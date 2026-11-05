export const APP_REDIRECT_URL = 'https://empapadakos.github.io/time-tracker-next/';
export const TERMINAL_STORAGE_KEY = 'time-tracker-next.auth.v1';
export const ADMIN_STORAGE_KEY = 'time-tracker-next.admin.auth.v1';

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALLBACK_FIELDS = ['access_token', 'refresh_token', 'error', 'error_code'];

// This selects a UI and storage namespace only. Database roles still decide
// which operations the signed-in user is allowed to perform.
export function resolvePageMode(location) {
  let current;
  try { current = new URL(typeof location === 'string' ? location : location?.href || APP_REDIRECT_URL); }
  catch { current = new URL(APP_REDIRECT_URL); }
  const hash = new URLSearchParams(current.hash.slice(1));
  const request = current.searchParams.get('browser_request') || '';
  const validRequest = REQUEST_ID.test(request);
  const callback = CALLBACK_FIELDS.some(field => current.searchParams.has(field) || hash.has(field));
  const admin = current.searchParams.get('panel') === 'admin' || validRequest || callback;
  const target = new URL(APP_REDIRECT_URL);
  target.searchParams.set('panel', 'admin');
  if (validRequest) target.searchParams.set('browser_request', request);
  return Object.freeze({
    admin,
    adminUrl: target.href,
    shopUrl: APP_REDIRECT_URL,
    storageKey: admin ? ADMIN_STORAGE_KEY : TERMINAL_STORAGE_KEY,
    // The existing Supabase allowlist contains this exact canonical root.
    // Callback markers select the isolated admin namespace on the return trip.
    redirectUrl: APP_REDIRECT_URL
  });
}

export const pageMode = resolvePageMode(globalThis.location);
