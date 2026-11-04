import config from '../config.js';

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

export function createTrackerApi({url, key, storageKey = 'time-tracker-next.auth.v1', fetchImpl = globalThis.fetch, storage, now = () => Date.now(), timeoutMs = 25000, redirectUrl = APP_REDIRECT_URL, location = globalThis.location, history = globalThis.history, locks = globalThis.navigator?.locks, eventTarget = globalThis.window} = {}) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url || '')) throw new Error('Invalid Supabase endpoint');
  if (!key) throw new Error('Missing publishable key');
  if (!storage) { try { storage = globalThis.localStorage; } catch {} }
  let session = null;
  let refreshPromise = null;
  let generation = 0;
  const listeners = new Set();

  function storedSession() {
    try { return normalizeSession(JSON.parse(storage?.getItem(storageKey) || 'null')); } catch { return null; }
  }

  eventTarget?.addEventListener?.('storage', event => {
    if (event.key !== storageKey) return;
    generation++;
    session = storedSession();
    for (const listener of listeners) listener(session);
  });

  function persist(next) {
    session = next;
    try { next ? storage?.setItem(storageKey, JSON.stringify(next)) : storage?.removeItem(storageKey); } catch {}
    for (const listener of listeners) listener(session);
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

  async function authorizedRequest(path, body, {requestId = null, uncertain = false} = {}) {
    if (!session) throw new TrackerError('Συνδέσου για να συνεχίσεις.', {code: 'AUTH_REQUIRED', status: 401});
    if (session.expires_at * 1000 <= now() + 60000) await refresh();
    const tokenUsed = session.access_token;
    try {
      return await http(path, {body, token: tokenUsed, uncertain, requestId});
    } catch (error) {
      if (error.status !== 401) throw error;
      if (session?.access_token === tokenUsed) await refresh();
      if (!session) throw error;
      return http(path, {body, token: session.access_token, uncertain, requestId});
    }
  }
  const authorizedRpc = (name, body, options) => authorizedRequest(`/rest/v1/rpc/${name}`, body, options);

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
      session = storedSession();
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
      const data = await http('/auth/v1/token?grant_type=password', {body: {email: login, password}});
      const next = normalizeSession(data);
      if (!next) throw new TrackerError('Δεν δημιουργήθηκε συνεδρία. Δοκίμασε ξανά.', {code: 'AUTH_REQUIRED'});
      generation++;
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
      persist(null);
      if (token) { try { await http('/auth/v1/logout?scope=local', {token}); } catch {} }
    },
    context() { return authorizedRpc('ttn_context', {}); },
    read(view, payload = {}) { return authorizedRpc('ttn_read', {p_view: view, p_payload: payload}); },
    command(action, payload, requestId = globalThis.crypto.randomUUID()) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid command UUID');
      return authorizedRpc('ttn_command', {p_action: action, p_payload: payload, p_request_id: requestId}, {requestId, uncertain: true});
    }
  };
}

export const api = createTrackerApi(config);
