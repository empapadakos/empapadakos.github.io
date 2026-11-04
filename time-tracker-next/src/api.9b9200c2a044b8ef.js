import config from '../config.9c8946eeaded4496.js';

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

export function createTrackerApi({url, key, storageKey = 'time-tracker-next.auth.v1', fetchImpl = globalThis.fetch, storage, now = () => Date.now(), timeoutMs = 25000} = {}) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url || '')) throw new Error('Invalid Supabase endpoint');
  if (!key) throw new Error('Missing publishable key');
  if (!storage) { try { storage = globalThis.localStorage; } catch {} }
  let session = null;
  let refreshPromise = null;
  let generation = 0;
  const listeners = new Set();

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
        let message = data?.message || data?.error_description || data?.msg || data?.error || 'Η ενέργεια δεν ολοκληρώθηκε.';
        if (data?.code === 'invalid_credentials') message = 'Το email ή ο κωδικός δεν είναι σωστά.';
        if (data?.code === 'email_not_confirmed') message = 'Επιβεβαίωσε πρώτα το email σου.';
        throw new TrackerError(message, {code: data?.code || details?.code || `HTTP_${response.status}`, details, status: response.status, uncertain: uncertain && response.status >= 500, requestId});
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
    refreshPromise = (async () => {
      try {
        const data = await http('/auth/v1/token?grant_type=refresh_token', {body: {refresh_token: token}});
        if (generation !== startedGeneration) throw new TrackerError('Η συνεδρία άλλαξε. Συνδέσου ξανά.', {code: 'SESSION_CHANGED', status: 401});
        const next = normalizeSession(data);
        if (!next) throw new TrackerError('Η συνεδρία έληξε. Συνδέσου ξανά.', {code: 'AUTH_REQUIRED', status: 401});
        persist(next);
        return next;
      } catch (error) {
        if (generation === startedGeneration && (error.status === 400 || error.status === 401)) persist(null);
        throw error;
      } finally { refreshPromise = null; }
    })();
    return refreshPromise;
  }

  async function authorizedRpc(name, body, {requestId = null, uncertain = false} = {}) {
    if (!session) throw new TrackerError('Συνδέσου για να συνεχίσεις.', {code: 'AUTH_REQUIRED', status: 401});
    if (session.expires_at * 1000 <= now() + 60000) await refresh();
    const tokenUsed = session.access_token;
    try {
      return await http(`/rest/v1/rpc/${name}`, {body, token: tokenUsed, uncertain, requestId});
    } catch (error) {
      if (error.status !== 401) throw error;
      if (session?.access_token === tokenUsed) await refresh();
      if (!session) throw error;
      return http(`/rest/v1/rpc/${name}`, {body, token: session.access_token, uncertain, requestId});
    }
  }

  return {
    get session() { return session; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async restore() {
      try {
        const raw = storage?.getItem(storageKey);
        const parsed = raw ? JSON.parse(raw) : null;
        session = normalizeSession(parsed);
      } catch { session = null; }
      if (!session) return false;
      if (session.expires_at * 1000 <= now() + 60000) await refresh();
      return Boolean(session);
    },
    async signIn({email, password}) {
      const data = await http('/auth/v1/token?grant_type=password', {body: {email: String(email).trim(), password}});
      const next = normalizeSession(data);
      if (!next) throw new TrackerError('Δεν δημιουργήθηκε συνεδρία. Δοκίμασε ξανά.', {code: 'AUTH_REQUIRED'});
      generation++;
      persist(next);
      return next;
    },
    async signUp({email, password}) {
      const data = await http('/auth/v1/signup', {body: {email: String(email).trim(), password}});
      const next = normalizeSession(data);
      if (next) { generation++; persist(next); }
      return {needs_confirmation: !next, session: next};
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
