import config from '../config.js';
import {createBrowserIdentityStore} from './browser-identity.js';

export class TrackerError extends Error {
  constructor(message, {code = 'UNKNOWN', details = null, status = 0, uncertain = false, requestId = null} = {}) {
    super(message);
    this.name = 'TrackerError';
    Object.assign(this, {code, details, status, uncertain, requestId});
  }
}

function decodeDetails(value) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return {description: value}; }
}

export const APP_REDIRECT_URL = 'https://empapadakos.github.io/time-tracker-next/';
const DEVICE_DOMAIN = 'ttn-device.dwzbpfjvgphhtnweugfg.invalid';

export async function deriveDevicePassword(password, cryptoImpl = globalThis.crypto) {
  if (typeof password !== 'string' || [...password].length < 5 || [...password].length > 128) throw new TrackerError('Ο κωδικός υπολογιστή χρειάζεται από 5 έως 128 χαρακτήρες.', {code:'INVALID_DEVICE_PASSWORD'});
  if (!cryptoImpl?.subtle) throw new TrackerError('Χρειάζεται σύγχρονος browser με ασφαλή σύνδεση HTTPS.', {code:'BROWSER_STORAGE_UNAVAILABLE'});
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode('ttn-device-password:v1\u0000' + password));
  return 'Ttn1!' + [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

export function createTrackerApi({url, key, storageKey = 'time-tracker-next.auth.v1', fetchImpl = globalThis.fetch, storage, now = () => Date.now(), timeoutMs = 25000, redirectUrl = APP_REDIRECT_URL, location = globalThis.location, history = globalThis.history, locks = globalThis.navigator?.locks, eventTarget = globalThis.window, browserStore, cryptoImpl = globalThis.crypto, browserLabel = 'Υπολογιστής καταγραφής'} = {}) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url || '')) throw new Error('Invalid Supabase endpoint');
  if (!key) throw new Error('Missing publishable key');
  if (!storage) { try { storage = globalThis.localStorage; } catch {} }
  let session = null;
  let refreshPromise = null;
  let generation = 0;
  let terminalMode = false;
  let browserRegistration = null;
  let browserRegistrationPromise = null;
  const listeners = new Set();

  function storedSession() {
    try { return normalizeSession(JSON.parse(storage?.getItem(storageKey) || 'null')); } catch { return null; }
  }

  eventTarget?.addEventListener?.('storage', event => {
    if (event.key !== storageKey) return;
    generation++;
    session = storedSession();
    terminalMode = session?.ttn_terminal === true;
    browserRegistration = null;
    browserRegistrationPromise = null;
    for (const listener of listeners) listener(session);
  });

  function persist(next) {
    session = next;
    try { next ? storage?.setItem(storageKey, JSON.stringify(next)) : storage?.removeItem(storageKey); } catch {}
    for (const listener of listeners) listener(session);
  }

  function usesTerminal() {
    return terminalMode || session?.ttn_terminal === true || session?.user?.email?.toLowerCase().endsWith('@' + DEVICE_DOMAIN);
  }

  function markTerminal() {
    terminalMode = true;
    if (session && !session.ttn_terminal) persist({...session,ttn_terminal:true});
  }

  function normalizeSession(data) {
    const raw = data?.session || data;
    if (!raw?.access_token || !raw?.refresh_token) return null;
    return {...raw, expires_at: Number(raw.expires_at || (Math.floor(now() / 1000) + Number(raw.expires_in || 3600)))};
  }

  async function http(path, {body, token, method = 'POST', uncertain = false, requestId = null} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {'apikey': key, 'Content-Type': 'application/json'};
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetchImpl(`${url}${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, credentials: 'omit', cache: 'no-store'});
      const raw = await response.text();
      let data = null;
      if (raw) { try { data = JSON.parse(raw); } catch { throw new TrackerError('Ο διακομιστής επέστρεψε μη έγκυρη απάντηση.', {code: 'BAD_RESPONSE', status: response.status, uncertain, requestId}); } }
      if (!response.ok) {
        const details = decodeDetails(data?.details);
        const errorCode = data?.error_code || (typeof data?.code === 'string' ? data.code : null) || details?.code || `HTTP_${response.status}`;
        let message = data?.message || data?.error_description || data?.msg || data?.error || 'Η ενέργεια δεν ολοκληρώθηκε.';
        if (errorCode === 'invalid_credentials') message = 'Το email / username ή ο κωδικός δεν είναι σωστά.';
        if (errorCode === 'email_not_confirmed') message = 'Επιβεβαίωσε πρώτα το email σου.';
        if (response.status === 429) message = 'Έγιναν πολλές προσπάθειες. Περίμενε λίγο πριν δοκιμάσεις ξανά.';
        throw new TrackerError(message, {code: errorCode, details, status: response.status, uncertain: uncertain && response.status >= 500, requestId});
      }
      return data;
    } catch (error) {
      if (error instanceof TrackerError) throw error;
      throw new TrackerError(uncertain ? 'Η επιβεβαίωση της καταγραφής δεν έφτασε. Πάτησε επανάληψη για να ελεγχθεί η ίδια ενέργεια, χωρίς διπλή εγγραφή.' : 'Δεν υπάρχει σύνδεση με τον διακομιστή. Δοκίμασε ξανά.', {code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK', uncertain, requestId});
    } finally { clearTimeout(timer); }
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    if (!session?.refresh_token) throw new TrackerError('Συνδέσου για να συνεχίσεις.', {code: 'AUTH_REQUIRED', status: 401});
    const token = session.refresh_token;
    const startedGeneration = generation;
    const refreshUnderLock = async () => {
      try {
        if (generation !== startedGeneration) throw new TrackerError('Η συνεδρία άλλαξε. Δοκίμασε ξανά.', {code: 'SESSION_CHANGED', status: 409});
        const stored = storedSession();
        if (stored && stored.refresh_token !== token && stored.expires_at * 1000 > now() + 60000) {
          persist(stored);
          return stored;
        }
        const data = await http('/auth/v1/token?grant_type=refresh_token', {body: {refresh_token: token}});
        if (generation !== startedGeneration) throw new TrackerError('Η συνεδρία άλλαξε. Συνδέσου ξανά.', {code: 'SESSION_CHANGED', status: 401});
        const next = normalizeSession(data);
        if (!next) throw new TrackerError('Η συνεδρία έληξε. Συνδέσου ξανά.', {code: 'AUTH_REQUIRED', status: 401});
        if (usesTerminal()) next.ttn_terminal = true;
        persist(next);
        return next;
      } catch (error) {
        if (generation === startedGeneration && (error.status === 400 || error.status === 401)) persist(null);
        throw error;
      }
    };
    refreshPromise = (locks?.request ? locks.request(storageKey + '.refresh', refreshUnderLock) : refreshUnderLock()).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function authorizedRequest(path, body, {requestId = null, uncertain = false, method = 'POST'} = {}) {
    if (!session) throw new TrackerError('Συνδέσου για να συνεχίσεις.', {code: 'AUTH_REQUIRED', status: 401});
    if (session.expires_at * 1000 <= now() + 60000) await refresh();
    const tokenUsed = session.access_token;
    try {
      return await http(path, {body, token: tokenUsed, uncertain, requestId, method});
    } catch (error) {
      if (error.status !== 401) throw error;
      if (session?.access_token === tokenUsed) await refresh();
      if (!session) throw error;
      return http(path, {body, token: session.access_token, uncertain, requestId, method});
    }
  }
  const authorizedRpc = (name, body, options) => authorizedRequest(`/rest/v1/rpc/${name}`, body, options);

  async function browserIdentity() {
    if (!session) throw new TrackerError('Συνδέσου για να συνεχίσεις.', {code:'AUTH_REQUIRED',status:401});
    if (!session.user?.id) {
      const user = await authorizedRequest('/auth/v1/user',undefined,{method:'GET'});
      if (!user?.id) throw new TrackerError('Δεν επιβεβαιώθηκε ο λογαριασμός.', {code:'AUTH_REQUIRED',status:401});
      persist({...session,user});
    }
    browserStore ||= createBrowserIdentityStore();
    try { return await browserStore.get(session.user.id); }
    catch (error) { throw new TrackerError(error.message || 'Δεν αποθηκεύτηκε η εξουσιοδότηση του browser.', {code:error.code || 'BROWSER_STORAGE_UNAVAILABLE'}); }
  }

  const terminalEndpoint = (body, options) => authorizedRequest('/functions/v1/ttn-terminal',body,options);

  function terminalLabel() {
    if (browserLabel !== 'Υπολογιστής καταγραφής') return browserLabel;
    const ua = globalThis.navigator?.userAgent || '';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const platform = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    const name = session?.user?.email?.toLowerCase().endsWith('@'+DEVICE_DOMAIN) ? session.user.email.split('@')[0] : 'Υπολογιστής καταγραφής';
    return (name+' · '+browser+(platform?' / '+platform:'')).slice(0,120);
  }

  async function registerBrowser(force = false) {
    if (!force && browserRegistration) return browserRegistration;
    if (browserRegistrationPromise) return browserRegistrationPromise;
    const startedGeneration = generation;
    const pending = (async()=>{
      const identity = await browserIdentity();
      const value = await terminalEndpoint({action:'register',public_key:identity.public_key,label:terminalLabel()});
      if (generation !== startedGeneration) throw new TrackerError('Η σύνδεση άλλαξε. Δοκίμασε ξανά.',{code:'SESSION_CHANGED'});
      const device = value.device || value.browser;
      if (!device || !(device.id || device.device_id)) throw new TrackerError('Δεν επιβεβαιώθηκε η συσκευή.',{code:'BAD_RESPONSE'});
      browserRegistration = {...value,device,browser:device,status:device.status};
      return browserRegistration;
    })().finally(()=>{if(browserRegistrationPromise===pending)browserRegistrationPromise=null;});
    browserRegistrationPromise = pending;
    return pending;
  }

  function assertApproved(registration) {
    if (registration.status === 'approved') return;
    throw new TrackerError(registration.status === 'revoked' ? 'Η εξουσιοδότηση αυτού του browser έχει ανακληθεί.' : 'Ο browser περιμένει έγκριση από τον κύριο διαχειριστή.',{
      code:registration.status === 'revoked'?'BROWSER_REVOKED':'BROWSER_APPROVAL_REQUIRED',status:403,details:registration
    });
  }

  async function terminalRequest(operation, originalPayload, options = {}) {
    markTerminal();
    const registration = await registerBrowser();
    assertApproved(registration);
    const identity = await browserIdentity();
    const payload = structuredClone(originalPayload);
    const body = {device_id:registration.device.id || registration.device.device_id,operation,payload};
    const proof = await terminalEndpoint({action:'challenge',...body});
    if (!proof.challenge_id || typeof proof.challenge !== 'string') throw new TrackerError('Δεν δημιουργήθηκε η επιβεβαίωση του browser.',{code:'BAD_RESPONSE'});
    const signature = await identity.sign(proof.challenge);
    try {
      const value = await terminalEndpoint({action:'execute',...body,challenge_id:proof.challenge_id,signature},options);
      if (value?.ok !== true || !Object.hasOwn(value,'result')) throw new TrackerError('Δεν επιβεβαιώθηκε το αποτέλεσμα της ενέργειας.',{code:'BAD_RESPONSE',uncertain:Boolean(options.uncertain),requestId:options.requestId || null});
      return value.result;
    }
    catch (error) {
      if (['BROWSER_REVOKED','BROWSER_APPROVAL_REQUIRED','BROWSER_REQUIRED'].includes(error.code) || ['BROWSER_REVOKED','BROWSER_APPROVAL_REQUIRED','BROWSER_REQUIRED'].includes(error.details?.code)) browserRegistration=null;
      throw error;
    }
  }

  async function appRequest(operation, payload, options) {
    if (usesTerminal()) return terminalRequest(operation,payload,options);
    const routes = {context:['ttn_context',{}],read:['ttn_read',{p_view:payload.view,p_payload:payload.payload}],command:['ttn_command',{p_action:payload.action,p_payload:payload.payload,p_request_id:payload.request_id}]};
    const [rpc,body] = routes[operation];
    try { return await authorizedRpc(rpc,body,options); }
    catch (error) {
      if (error.code !== 'BROWSER_REQUIRED' && error.details?.code !== 'BROWSER_REQUIRED') throw error;
      return terminalRequest(operation,payload,options);
    }
  }

  async function consumeCallback() {
    if (!location?.href) return;
    const current = new URL(location.href);
    const hash = new URLSearchParams(current.hash.slice(1));
    const query = current.searchParams;
    const fields = ['access_token','refresh_token','expires_at','expires_in','token_type','type','error','error_code','error_description','sb'];
    const hasAuth = ['access_token','refresh_token','error','error_code'].some(k => hash.has(k) || query.has(k));
    if (!hasAuth) return;
    const value = k => hash.get(k) || query.get(k);
    const error = value('error_code') || value('error');
    const raw = {access_token:value('access_token'), refresh_token:value('refresh_token'), expires_at:value('expires_at'), expires_in:value('expires_in')};
    // Clear bearer credentials/errors before making a network request or rendering.
    for (const field of fields) { hash.delete(field); query.delete(field); }
    current.hash = hash.toString();
    history?.replaceState?.(null, '', current.pathname + current.search + current.hash);
    if (error) throw new TrackerError(error === 'otp_expired' ? 'Το link επιβεβαίωσης έχει λήξει ή χρησιμοποιηθεί. Αν έχεις ήδη επιβεβαιώσει το email, συνδέσου κανονικά· διαφορετικά ζήτησε νέο email.' : 'Η επιβεβαίωση δεν ολοκληρώθηκε. Δοκίμασε σύνδεση ή ζήτησε νέο email επιβεβαίωσης.', {code:error});
    const next = normalizeSession(raw);
    if (!next) throw new TrackerError('Δεν βρέθηκε πλήρης συνεδρία στο link. Συνδέσου με email και κωδικό.', {code:'AUTH_CALLBACK_INVALID'});
    const user = await http('/auth/v1/user', {method:'GET',token:next.access_token});
    if (!user?.id) throw new TrackerError('Δεν επιβεβαιώθηκε η συνεδρία. Συνδέσου ξανά.', {code:'AUTH_CALLBACK_INVALID'});
    generation++;
    persist({...next,user});
  }

  return {
    get session() { return session; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async restore() {
      generation++;
      session = storedSession();
      terminalMode = session?.ttn_terminal === true;
      browserRegistration = null;
      browserRegistrationPromise = null;
      await consumeCallback();
      if (!session) return false;
      if (session.expires_at * 1000 <= now() + 60000) await refresh();
      return Boolean(session);
    },
    async signIn({email, username, password}) {
      let login = String(email || '').trim();
      if (username !== undefined) {
        const normalized = String(username).trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9._-]{2,47}$/.test(normalized)) throw new TrackerError('Το username χρειάζεται 3–48 λατινικούς χαρακτήρες, αριθμούς, τελεία, παύλα ή κάτω παύλα.', {code:'INVALID_USERNAME'});
        login = normalized + '@' + DEVICE_DOMAIN;
      }
      const actualPassword = username === undefined ? password : await deriveDevicePassword(password,cryptoImpl);
      const data = await http('/auth/v1/token?grant_type=password', {body: {email: login, password:actualPassword}});
      const next = normalizeSession(data);
      if (!next) throw new TrackerError('Δεν δημιουργήθηκε συνεδρία. Δοκίμασε ξανά.', {code: 'AUTH_REQUIRED'});
      generation++;
      terminalMode = username !== undefined || login.toLowerCase().endsWith('@'+DEVICE_DOMAIN);
      browserRegistration = null;
      browserRegistrationPromise = null;
      if (terminalMode) next.ttn_terminal = true;
      persist(next);
      return next;
    },
    async signUp({email, password}) {
      const data = await http('/auth/v1/signup?redirect_to=' + encodeURIComponent(redirectUrl), {body: {email: String(email).trim(), password}});
      const next = normalizeSession(data);
      if (next) { generation++; persist(next); }
      return {needs_confirmation: !next, session: next};
    },
    resendConfirmation(email) {
      return http('/auth/v1/resend?redirect_to=' + encodeURIComponent(redirectUrl), {body:{type:'signup',email:String(email).trim()}});
    },
    async manageAccount(payload, requestId = globalThis.crypto.randomUUID()) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid account UUID');
      try { return await authorizedRequest('/functions/v1/ttn-manage-accounts', {...payload,request_id:requestId}, {requestId,uncertain:true}); }
      catch (error) { if (error.uncertain) error.message = 'Δεν επιβεβαιώθηκε η αλλαγή. Ανανέωσε τους λογαριασμούς πριν προσπαθήσεις ξανά.'; throw error; }
    },
    async signOut() {
      const token = session?.access_token;
      generation++;
      terminalMode=false;
      browserRegistration=null;
      browserRegistrationPromise=null;
      persist(null);
      if (token) { try { await http('/auth/v1/logout?scope=local', {token}); } catch {} }
    },
    browserStatus() { markTerminal(); return registerBrowser(true); },
    listBrowsers() { return terminalEndpoint({action:'list'}); },
    manageBrowser({action,...payload},requestId=null) { return terminalEndpoint({action,payload},{uncertain:true,requestId}); },
    approveBrowser(requestId) { return terminalEndpoint({action:'approve',payload:{request_id:requestId}}); },
    revokeBrowser(deviceId) { return terminalEndpoint({action:'revoke',payload:{device_id:deviceId}}); },
    context() { return appRequest('context', {}); },
    read(view, payload = {}) { return appRequest('read', {view,payload}); },
    command(action, payload, requestId = globalThis.crypto.randomUUID()) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid command UUID');
      return appRequest('command', {action,payload,request_id:requestId}, {requestId, uncertain: true});
    }
  };
}

export const api = createTrackerApi(config);
