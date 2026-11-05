/** A per-account browser key. Private keys never leave WebCrypto/IndexedDB. */
const STORE='identities';
const VERSION=1;
const ACCOUNT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALGORITHM=Object.freeze({name:'ECDSA',namedCurve:'P-256'});
const SIGNATURE=Object.freeze({name:'ECDSA',hash:'SHA-256'});
const STORAGE_MESSAGE='Δεν είναι διαθέσιμη η ασφαλής αποθήκευση ταυτότητας σε αυτόν τον browser. Επίτρεψε την αποθήκευση δεδομένων για τη σελίδα και δοκίμασε ξανά. Για λόγους ασφάλειας δεν αντικαθίσταται αυτόματα υπάρχουσα ταυτότητα.';

function unavailable(cause) {
  if(cause?.code==='BROWSER_STORAGE_UNAVAILABLE')return cause;
  const error=new Error(STORAGE_MESSAGE,{cause});
  error.code='BROWSER_STORAGE_UNAVAILABLE';
  return error;
}

function base64url(bytes) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result='';
  for(let i=0;i<bytes.length;i+=3){
    const n=(bytes[i]<<16)|((bytes[i+1]??0)<<8)|(bytes[i+2]??0);
    result+=alphabet[n>>>18]+alphabet[(n>>>12)&63];
    if(i+1<bytes.length)result+=alphabet[(n>>>6)&63];
    if(i+2<bytes.length)result+=alphabet[n&63];
  }
  return result;
}

function validKey(key,type,usage,extractable) {
  return key?.type===type&&key.extractable===extractable&&
    key.algorithm?.name==='ECDSA'&&key.algorithm?.namedCurve==='P-256'&&
    key.usages?.length===1&&key.usages[0]===usage;
}

export function createBrowserIdentityStore({indexedDB=globalThis.indexedDB,crypto=globalThis.crypto,dbName='time-tracker-next.browser-identity.v1'}={}) {
  let connection=null;
  const pending=new Map();

  function supported() {
    if(!indexedDB||typeof indexedDB.open!=='function'||typeof dbName!=='string'||!dbName.trim()||
      typeof globalThis.TextEncoder!=='function'||
      !['generateKey','exportKey','sign','verify'].every(name=>typeof crypto?.subtle?.[name]==='function'))throw unavailable();
  }

  function openDatabase() {
    if(connection)return connection;
    connection=new Promise((resolve,reject)=>{
      let settled=false,request;
      const fail=cause=>{if(!settled){settled=true;reject(unavailable(cause));}};
      try{request=indexedDB.open(dbName,VERSION);}catch(error){fail(error);return;}
      request.onblocked=()=>fail(new Error('Browser identity database is blocked.'));
      request.onerror=()=>fail(request.error);
      request.onupgradeneeded=()=>{
        try{
          const database=request.result;
          if(!database.objectStoreNames.contains(STORE))database.createObjectStore(STORE,{keyPath:'account_id'});
        }catch(error){fail(error);try{request.transaction?.abort();}catch{}}
      };
      request.onsuccess=()=>{
        const database=request.result;
        if(settled){database.close();return;}
        if(!database.objectStoreNames.contains(STORE)){database.close();fail(new Error('Unknown identity database schema.'));return;}
        database.onversionchange=()=>{database.close();connection=null;};
        settled=true;resolve(database);
      };
    }).catch(error=>{connection=null;throw unavailable(error);});
    return connection;
  }

  function readRecord(database,accountId) {
    return new Promise((resolve,reject)=>{
      let transaction,value,request;
      try{
        transaction=database.transaction(STORE,'readonly');
        transaction.oncomplete=()=>resolve(value);
        transaction.onabort=()=>reject(unavailable(transaction.error||request?.error));
        transaction.onerror=()=>{};
        const store=transaction.objectStore(STORE);
        if(store.keyPath!=='account_id')throw new Error('Unknown identity record key.');
        request=store.get(accountId);
        request.onsuccess=()=>{value=request.result;};
      }catch(error){try{transaction?.abort();}catch{}reject(unavailable(error));}
    });
  }

  /** Only add; a competing first enrolment must never overwrite the winner. */
  function addRecord(database,record) {
    return new Promise((resolve,reject)=>{
      let transaction,request,duplicate=false;
      try{
        transaction=database.transaction(STORE,'readwrite');
        transaction.oncomplete=()=>resolve(true);
        transaction.onerror=()=>{};
        transaction.onabort=()=>{
          if(duplicate)resolve(false);
          else reject(unavailable(transaction.error||request?.error));
        };
        const store=transaction.objectStore(STORE);
        if(store.keyPath!=='account_id')throw new Error('Unknown identity record key.');
        request=store.add(record);
        request.onerror=()=>{duplicate=request.error?.name==='ConstraintError';};
      }catch(error){try{transaction?.abort();}catch{}reject(unavailable(error));}
    });
  }

  async function identityFrom(record,accountId) {
    if(!record||record.version!==VERSION||record.account_id!==accountId||
      !validKey(record.private_key,'private','sign',false)||!validKey(record.public_key,'public','verify',true))throw unavailable(new Error('Invalid persisted browser identity.'));
    // Actual crypto operations reject spoofed CryptoKey objects and mismatched pairs.
    const publicJwk=await crypto.subtle.exportKey('jwk',record.public_key);
    if(publicJwk?.kty!=='EC'||publicJwk.crv!=='P-256'||'d' in publicJwk||
      !/^[A-Za-z0-9_-]{43}$/.test(publicJwk.x)||!/^[A-Za-z0-9_-]{43}$/.test(publicJwk.y))throw unavailable(new Error('Invalid public browser key.'));
    const probe=new TextEncoder().encode('time-tracker-next.browser-identity.validation.v1');
    const proof=await crypto.subtle.sign(SIGNATURE,record.private_key,probe);
    if(proof.byteLength!==64||!await crypto.subtle.verify(SIGNATURE,record.public_key,proof,probe))throw unavailable(new Error('Browser identity keys do not match.'));
    const publicKey=Object.freeze({...publicJwk,...(publicJwk.key_ops?{key_ops:Object.freeze([...publicJwk.key_ops])}:{})});
    return Object.freeze({
      public_key:publicKey,
      async sign(challengeString) {
        try{
          if(typeof challengeString!=='string')throw new TypeError('A challenge string is required.');
          const bytes=new Uint8Array(await crypto.subtle.sign(SIGNATURE,record.private_key,new TextEncoder().encode(challengeString)));
          if(bytes.length!==64)throw new Error('Invalid ECDSA signature format.');
          return base64url(bytes);
        }catch(error){throw unavailable(error);}
      }
    });
  }

  async function load(accountId) {
    const database=await openDatabase();
    const existing=await readRecord(database,accountId);
    if(existing!==undefined)return identityFrom(existing,accountId);
    const pair=await crypto.subtle.generateKey(ALGORITHM,false,['sign','verify']);
    const record={version:VERSION,account_id:accountId,private_key:pair.privateKey,public_key:pair.publicKey};
    await identityFrom(record,accountId);
    await addRecord(database,record);
    // Read after COMMIT, also in the losing-tab case. Never expose an unpersisted key.
    const persisted=await readRecord(database,accountId);
    if(persisted===undefined)throw unavailable(new Error('Browser identity did not persist.'));
    return identityFrom(persisted,accountId);
  }

  return Object.freeze({
    async get(accountId) {
      try{
        supported();
        if(typeof accountId!=='string'||!ACCOUNT_ID.test(accountId))throw unavailable(new Error('A verified account ID is required.'));
        const account=accountId.toLowerCase();
        if(!pending.has(account)){
          const operation=load(account);
          pending.set(account,operation);
          const clear=()=>{if(pending.get(account)===operation)pending.delete(account);};
          operation.then(clear,clear);
        }
        return await pending.get(account);
      }catch(error){throw unavailable(error);}
    }
  });
}
