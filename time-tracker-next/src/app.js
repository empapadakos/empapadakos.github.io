import { api } from './api.js';
import { pageMode } from './page-mode.js';
import { buildFlowDiagnostics } from './flow-diagnostics.js';
import { replay, effectiveEvents, planNext, monthlyStats, dateKey, formatTime, formatDate, formatMinutes, localToIso, possibleInstants } from './domain.js';

const APP_NAME = 'Time Tracker v2';
document.title = APP_NAME + (pageMode.admin ? ' · Διαχείριση' : '');
const ACTIONS = { clock_in: 'Είσοδος', break_start: 'Έναρξη διαλείμματος', break_end: 'Επιστροφή από διάλειμμα', clock_out: 'Έξοδος' };
const STATUS = { approved: 'Εγκεκριμένη', pending: 'Σε αναμονή', draft: 'Πρόχειρη', rejected: 'Απορρίφθηκε', void: 'Ακυρωμένη' };
const ROLES = { admin: 'Πλήρης διαχείριση', reviewer: 'Προβολή αναφορών', operator: 'Τερματικό καταγραφής' };
const NOTES = { note: 'Σημείωση', absence: 'Απουσία', leave: 'Άδεια', sick: 'Ασθένεια', day_off: 'Ρεπό' };
const VIEWS = [
  ['record', 'Καταγραφή', '↗', ['admin', 'operator']],
  ['overview', 'Ζωντανή εικόνα', '◉', ['admin', 'reviewer']],
  ['history', 'Καταγραφές', '≡', ['admin', 'reviewer']],
  ['requests', 'Διορθώσεις', '↺', ['admin', 'reviewer']],
  ['stats', 'Παρουσιολόγιο', '▦', ['admin', 'reviewer']],
  ['employees', 'Προσωπικό', '♧', ['admin', 'reviewer']],
  ['settings', 'Ρυθμίσεις', '⚙', ['admin']],
  ['audit', 'Ιστορικό αλλαγών', '⌁', ['admin', 'reviewer']]
];
const app = document.getElementById('app');
const modal = document.getElementById('modal');
const state = {
  context: null, view: 'record', overview: null, selectedId: '', employeeData: null,
  historyId: '', historyDataset: 'current', historyData: null, historyFrom: '', historyTo: '', historyStatus: '', historyType: '',
  requests: null, requestStatus: 'pending', requestEmployee: '', requestSelection: new Set(), requestSelectionScope: '', requestBulkRunning: false, requestBulkResult: null,
  statsId: '', statsDataset: 'current', month: '', statsMode: 'effective', monthData: null, stats: null, statsShowArchived: false,
  statsSearch: '', statsDepartment: '', statsFilter: 'all', statsSelectedDay: '', statsSelectionScope: '',
  adminData: null, audit: [], auditCursor: null, showArchived: false,
  search: '', department: '', busy: false, loadToken: 0, personToken: 0, connected: true,
  serverOffset: 0, lastActivity: Date.now(), pendingCommand: null, signup: false, authMessage: '', authError: false,
  authMode: pageMode.admin ? 'admin' : 'device', authResend: false, authEmail: '', authUsername: '', authRetryRestore: false, authBusy: false,
  modalMember: null, modalDevice: null, modalBrowser: null, correctionGuidance: null, correctionToken: 0,
  browserGate: null, browserData: null, browserCheckBusy: false, browserCheckToken: 0, browserPollAt: 0, sessionLoadToken: 0,
  pendingBrowserRequest: '', openedBrowserRequest: '',
  adminDay: null, adminDayLoadToken: 0, nextScheduledRefresh: 0, adminIdleEstablished: false, returningToShop: false, sessionReloadPending: false
};


const ADMIN_ACTIVITY_KEY = 'time-tracker-next.admin.activity.v1';
const ADMIN_SESSION_KEY = 'time-tracker-next.admin.auth.v1';
const ADMIN_IDLE_MESSAGE = 'Η συνεδρία έληξε λόγω αδράνειας. Συνδέσου ξανά για να συνεχίσεις.';
let adminIdleMemory = null;
let adminIdleStorageBlocked = false;
function administrativeContext(context = state.context) { return pageMode.admin && ['admin', 'reviewer'].includes(context?.role); }
function legacyAdministrativeContext(context = state.context) { return !pageMode.admin && ['admin', 'reviewer'].includes(context?.role); }
function idleIdentity(context) { return String(context?.member_id || context?.email || '').toLowerCase(); }
function idleTimeout(context) { return Math.min(240, Math.max(1, Number(context?.settings?.idle_timeout_minutes) || 10)) * 60000; }
function readAdminIdle() {
  let value;
  try { value = sessionStorage.getItem(ADMIN_ACTIVITY_KEY); }
  catch { return adminIdleMemory; }
  if (value == null) return adminIdleStorageBlocked ? adminIdleMemory : null;
  try {
    const record = JSON.parse(value);
    if (!record || typeof record.identity !== 'string' || !record.identity || !Number.isFinite(record.lastActivity) || record.lastActivity <= 0 || record.lastActivity > Date.now() + 30000 || !Number.isFinite(record.timeoutMs) || record.timeoutMs < 60000 || record.timeoutMs > 14400000) return null;
    return record;
  } catch { return null; }
}
function writeAdminIdle(record) {
  adminIdleMemory = record;
  try { const value = JSON.stringify(record); sessionStorage.setItem(ADMIN_ACTIVITY_KEY, value); adminIdleStorageBlocked = sessionStorage.getItem(ADMIN_ACTIVITY_KEY) !== value; }
  catch { adminIdleStorageBlocked = true; }
}
function clearAdminIdle() {
  adminIdleMemory = null;
  try { sessionStorage.removeItem(ADMIN_ACTIVITY_KEY); adminIdleStorageBlocked = false; } catch { adminIdleStorageBlocked = true; }
}
function savedAdminSession() {
  try { return Boolean(sessionStorage.getItem(ADMIN_SESSION_KEY)); } catch { return false; }
}
function discardSavedAdminSession() {
  if (typeof api.discardStoredAdminSession === 'function') {
    Promise.resolve(api.discardStoredAdminSession()).catch(function() {});
  } else { try { sessionStorage.removeItem(ADMIN_SESSION_KEY); } catch {} }
}
function idleRemaining(record = readAdminIdle()) { return record ? Math.max(0, record.lastActivity + record.timeoutMs - Date.now()) : 0; }
function idleClock(record = readAdminIdle()) {
  const seconds = Math.ceil(idleRemaining(record) / 1000);
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}
function adminIdleBadge(extraClass = '') {
  const record = readAdminIdle();
  return '<span class="admin-idle-countdown' + (extraClass ? ' ' + extraClass : '') + (!record ? ' hidden' : '') + '" data-admin-idle role="timer" aria-live="off" title="Χρόνος μέχρι την αυτόματη αποσύνδεση διαχείρισης"><span>Αδράνεια</span> <time class="mono" data-admin-idle-time>' + idleClock(record) + '</time></span>';
}
function updateAdminIdleBadge() {
  const record = readAdminIdle();
  document.querySelectorAll('[data-admin-idle]').forEach(function(node) {
    node.classList.toggle('hidden', !record);
    node.classList.toggle('admin-idle-warning', Boolean(record && idleRemaining(record) <= 60000));
    const clock = node.querySelector('[data-admin-idle-time]'); if (clock) clock.textContent = idleClock(record);
  });
}
function requestSessionReload() {
  if (state.sessionReloadPending) return;
  state.sessionReloadPending = true; state.authBusy = true;
  state.sessionLoadToken++; state.loadToken++; state.personToken++; state.adminDayLoadToken++;
  state.context = null; state.employeeData = null; state.historyData = null; state.monthData = null; state.overview = null; state.adminData = null;
  clearPasswords(modal); modal.close(); app.innerHTML = loading();
  window.location?.reload?.();
}
function expireAdminIdle() {
  if (state.sessionReloadPending) return true;
  if (pageMode.admin && state.authBusy && !state.context) return false;
  if (legacyAdministrativeContext() && !state.busy && Date.now() - state.lastActivity >= idleTimeout(state.context)) {
    if (!state.idleLogout) { state.idleLogout = true; Promise.resolve(logout(ADMIN_IDLE_MESSAGE)).finally(function() { state.idleLogout = false; }); }
    return true;
  }
  let record = readAdminIdle();
  if (administrativeContext() && !state.adminIdleEstablished && !record) {
    writeAdminIdle({lastActivity: state.lastActivity, timeoutMs: idleTimeout(state.context), identity: idleIdentity(state.context)});
    state.adminIdleEstablished = true; record = readAdminIdle();
  }
  if (administrativeContext() && record?.identity && record.identity !== idleIdentity(state.context)) { requestSessionReload(); return true; }
  const missing = administrativeContext() && state.adminIdleEstablished && !record;
  if (!missing && (!record || idleRemaining(record) > 0)) return false;
  if (administrativeContext() && state.busy) { updateAdminIdleBadge(); return true; }
  clearAdminIdle();
  if (administrativeContext()) {
    if (!state.idleLogout) {
      state.idleLogout = true;
      Promise.resolve(logout(ADMIN_IDLE_MESSAGE)).finally(function() { state.idleLogout = false; });
    }
  } else discardSavedAdminSession();
  updateAdminIdleBadge(); return true;
}
function syncAdminIdle(context, fresh = false) {
  const record = readAdminIdle();
  if (administrativeContext(context)) {
    if (!fresh && record?.identity && record.identity !== idleIdentity(context)) {
      if (state.adminIdleEstablished || administrativeContext()) requestSessionReload();
      else clearAdminIdle();
      return false;
    }
    if (!fresh && state.adminIdleEstablished && !record) { requestSessionReload(); return false; }
    if (!fresh && record && idleRemaining(record) <= 0) { clearAdminIdle(); return false; }
    const next = !fresh && record && record.identity === idleIdentity(context) ? {...record, timeoutMs: idleTimeout(context)} : {lastActivity: Date.now(), timeoutMs: idleTimeout(context), identity: idleIdentity(context)};
    writeAdminIdle(next); state.lastActivity = next.lastActivity; state.adminIdleEstablished = true;
    return idleRemaining(next) > 0;
  }
  if (record) writeAdminIdle({...record, timeoutMs: idleTimeout(context)});
  return true;
}
function recordAppActivity(event) {
  const activeAdmin = administrativeContext() || legacyAdministrativeContext();
  if (expireAdminIdle()) {
    if (activeAdmin || state.sessionReloadPending) { event?.preventDefault?.(); event?.stopImmediatePropagation?.(); }
    return;
  }
  if (legacyAdministrativeContext()) state.lastActivity = Date.now();
  const record = readAdminIdle();
  if (record) { const at = Date.now(); writeAdminIdle({...record, lastActivity: at}); state.lastActivity = at; updateAdminIdleBadge(); }
}
function freshAdminCallback() {
  try {
    const current = new URL(window.location?.href || pageMode.adminUrl); const hash = new URLSearchParams(current.hash.slice(1));
    return Boolean((hash.get('access_token') || current.searchParams.get('access_token')) && (hash.get('refresh_token') || current.searchParams.get('refresh_token')));
  } catch { return false; }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
function isAdmin() { return state.context?.role === 'admin'; }
function isOperator() { return state.context?.role === 'operator'; }
function isOwner() { return isAdmin() && state.context?.is_owner === true; }
function canRecord() { return ['admin', 'operator'].includes(state.context?.role); }
function archiveAvailable() { return ['admin', 'reviewer'].includes(state.context?.role) && state.context?.history_archive?.available === true; }
function viewDataset(view = state.view) {
  const selected = view === 'history' ? state.historyDataset : (view === 'stats' ? state.statsDataset : 'current');
  return archiveAvailable() && selected === 'archive' ? 'archive' : 'current';
}
function dataDataset(data) { return data?.dataset === 'archive' || data?.read_only === true ? 'archive' : 'current'; }
function isArchiveView(view = state.view) {
  const data = view === 'history' ? state.historyData : (view === 'stats' ? state.monthData : null);
  return viewDataset(view) === 'archive' || dataDataset(data) === 'archive';
}
function datasetField(view) {
  return archiveAvailable() ? selectField('Καταγραφές', view + '_dataset', option('current', 'Νέες καταγραφές', viewDataset(view)) + option('archive', 'Παλιό ιστορικό (μόνο προβολή)', viewDataset(view))) : '';
}
function archiveNotice() { return banner('Παλιό ιστορικό · μόνο προβολή. Οι νέες καταγραφές και τα σύνολά τους εμφανίζονται χωριστά.'); }
function now() { return new Date(Date.now() + state.serverOffset); }
function today() { return dateKey(now()); }
function employee(id) { return state.context?.employees?.find(function(e) { return !e.deleted_at && String(e.id) === String(id); }); }
function visibleEmployees(includeArchived = false) { return (state.context?.employees || []).filter(function(e) { return !e.deleted_at && (includeArchived || !e.archived); }).sort(function(a,b) { return Number(Boolean(a.archived))-Number(Boolean(b.archived)); }); }
function activeEmployees() { return visibleEmployees(); }
function reconcileSelections() {
  if (!archiveAvailable()) {
    if (state.historyDataset !== 'current') state.historyData = null;
    if (state.statsDataset !== 'current') { state.monthData = null; state.stats = null; }
    state.historyDataset = 'current'; state.statsDataset = 'current';
  }
  const rows = visibleEmployees(true);
  const first = activeEmployees()[0];
  if (!rows.some(function(e) { return (state.showArchived || !e.archived) && String(e.id) === String(state.historyId); })) { state.historyId = first?.id || ''; state.historyData = null; }
  if (!rows.some(function(e) { return (state.statsShowArchived || !e.archived) && String(e.id) === String(state.statsId); })) { state.statsId = visibleEmployees(state.statsShowArchived)[0]?.id || ''; state.monthData = null; state.stats = null; }
  if (!rows.some(function(e) { return !e.archived && String(e.id) === String(state.selectedId); })) { state.selectedId = ''; state.employeeData = null; }
  if (state.requestEmployee && !activeEmployees().some(function(e) { return String(e.id) === String(state.requestEmployee); })) { state.requestEmployee = ''; state.requests = null; }
}
function personName(id) { return employee(id)?.name || 'Εργαζόμενος'; }
function initials(name) { return String(name || '').trim().split(/\s+/).slice(0, 2).map(function(p) { return p[0] || ''; }).join('').toLocaleUpperCase('el-GR'); }
function displayDate(value) { try { return formatDate(value); } catch { return '—'; } }
function displayTime(value) { try { return formatTime(value).replace(':', '.'); } catch { return '—'; } }
function clockText(value) {
  const match = String(value || '').match(/^(\d{2})[:.](\d{2})/);
  return match ? match[1] + '.' + match[2] : String(value || '');
}
function normalizeTime(value, {allowSeconds = false} = {}) {
  let text = String(value || '').trim();
  if (/^\d{4}$/.test(text)) text = text.slice(0, 2) + ':' + text.slice(2);
  const pattern = allowSeconds ? /^(\d{1,2})[:.](\d{2})(?::\d{2}(?:\.\d+)?)?$/ : /^(\d{1,2})[:.](\d{2})$/;
  const match = text.match(pattern);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('Γράψε την ώρα σε 24ωρη μορφή, π.χ. 21.00.');
  return match[1].padStart(2, '0') + ':' + match[2];
}
function formatTimeInput(value, {deleting = false, complete = false} = {}) {
  const raw = String(value || '').trim();
  const separated = raw.match(/^(\d{1,2})[:.](\d{0,2})/);
  if (separated) {
    const hour = separated[1].length === 1 && (complete || separated[2].length === 2) ? separated[1].padStart(2, '0') : separated[1];
    return hour + '.' + separated[2];
  }
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  return digits.length > 2 ? digits.slice(0, 2) + '.' + digits.slice(2) : (digits.length === 2 && !deleting ? digits + '.' : digits);
}
function updateTimeInput(input, options = {}) {
  input.value = formatTimeInput(input.value, options);
  let error = '';
  if (/^\d{1,2}\.\d{2}$/.test(input.value)) {
    try { normalizeTime(input.value); } catch (cause) { error = cause.message; }
  }
  input.setCustomValidity?.(error);
  if (input.name === 'entry_0_time' && typeof updateGuidedCorrectionDate === 'function') updateGuidedCorrectionDate(input.form);
}
function shortDay(key) { return new Intl.DateTimeFormat('el-GR', { weekday: 'short', timeZone: 'Europe/Athens' }).format(new Date(key + 'T12:00:00Z')); }
function dateDisplay(key) { return key ? key.split('-').reverse().join('/') : '—'; }
function setServerTime(value) { if (value && Number.isFinite(Date.parse(value))) state.serverOffset = Date.parse(value) - Date.now(); }
function stateOf(value) {
  if (typeof value === 'string') return { state: value, valid: true, issues: [] };
  if (value && typeof value.state === 'string') return { valid: true, issues: [], ...value };
  const nested = value?.effective_state || value?.state;
  return nested && nested !== value ? stateOf(nested) : { state: 'OUT', valid: true, issues: [] };
}
function badgeForState(value) {
  const s = stateOf(value);
  if (s.valid === false || s.issues?.length) return '<span class="badge red">Χρειάζεται έλεγχος</span>';
  const options = { OUT: ['Εκτός', ''], IN: ['Μέσα', 'green'], ON_BREAK: ['Σε διάλειμμα', 'amber'] };
  const pair = options[s.state] || options.OUT;
  return '<span class="badge ' + pair[1] + '"><span class="status-dot"></span>' + pair[0] + '</span>';
}
function statusBadge(status) { return '<span class="badge ' + ({ pending: 'amber', approved: 'green', rejected: 'red' }[status] || '') + '">' + esc(STATUS[status] || status) + '</span>'; }
function isScheduledEvent(event) { return event?.source === 'admin' && event.status === 'approved' && Date.parse(event.event_at) > now().getTime(); }
function eventStatusBadge(event) { return isScheduledEvent(event) ? '<span class="badge planned">Ορισμένη ώρα</span>' : statusBadge(event.status); }
function updateRequestCounter(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return;
  const count = Math.max(0,Number(value));
  if (state.context) state.context.pending_count = count;
  if (state.overview) state.overview.pending_count = count;
  const badge = document.getElementById('request-counter'); if (badge) badge.textContent = String(count);
}
function pendingBadge(count, employeeId = null, label = null) {
  if (!count) return '';
  const text = label || count + ' σε αναμονή';
  if (employeeId && !employee(employeeId)?.archived && ['admin','reviewer'].includes(state.context?.role) && !isArchiveView()) {
    return '<button type="button" class="badge amber request-link" data-action="open-requests" data-employee="' + esc(employeeId) + '" aria-label="' + esc('Εκκρεμείς διορθώσεις: ' + personName(employeeId)) + '">' + esc(text) + '</button>';
  }
  return '<span class="badge amber">' + esc(text) + '</span>';
}
function avatar(e) { return '<span class="avatar" data-color="' + esc(/^#[0-9a-f]{6}$/i.test(e?.color || '') ? e.color : '') + '">' + esc(initials(e?.name)) + '</span>'; }
function colorAvatars() {
  document.querySelectorAll('.avatar[data-color]').forEach(function(el) {
    if (/^#[0-9a-f]{6}$/i.test(el.dataset.color || '')) {
      el.style.backgroundColor = el.dataset.color + '22';
      el.style.color = el.dataset.color;
    }
  });
  document.querySelectorAll('.kiosk-employee[data-color]').forEach(function(el) {
    el.style.backgroundColor = /^#[0-9a-f]{6}$/i.test(el.dataset.color || '') ? el.dataset.color : '#ffffff';
  });
}
function option(value, label, selected) { return '<option value="' + esc(value) + '"' + (String(value) === String(selected) ? ' selected' : '') + '>' + esc(label) + '</option>'; }
function employeeOptions(selected, includeAll = false, includeArchived = false) {
  return (includeAll ? option('', 'Όλοι οι εργαζόμενοι', selected) : '') +
    visibleEmployees(includeArchived).map(function(e) { return option(e.id,e.name + (e.archived ? ' · Αρχείο' : ''),selected); }).join('');
}
function actionOptions(selected) { return Object.entries(ACTIONS).map(function(pair) { return option(pair[0], pair[1], selected); }).join(''); }
function loading() { return '<div class="loading"><span class="spinner"></span>Φόρτωση…</div>'; }
function empty(title, message, button = '') { return '<div class="empty"><div class="empty-icon">◇</div><h3>' + esc(title) + '</h3><p>' + esc(message) + '</p>' + button + '</div>'; }
function banner(message, kind = '', extra = '') { return '<div class="banner ' + kind + '"><span class="banner-icon">' + (kind === 'error' ? '!' : 'ⓘ') + '</span><div>' + message + extra + '</div></div>'; }
function heading(title, description, actions = '') {
  return '<div class="page-heading"><div><div class="eyebrow">Ομάδα & χρόνος</div><h1>' + esc(title) + '</h1><p>' + esc(description) + '</p></div>' + (actions ? '<div class="page-actions">' + actions + '</div>' : '') + '</div>';
}
function button(label, action, extra = '', classes = '') { return '<button type="button" class="button ' + classes + '" data-action="' + esc(action) + '" ' + extra + '>' + esc(label) + '</button>'; }
function field(label, name, value = '', type = 'text', extra = '') {
  if (type === 'time') {
    return '<div class="field"><label for="f-' + esc(name) + '">' + esc(label.replace(' Αθήνας', '')) + '</label><input id="f-' + esc(name) + '" name="' + esc(name) + '" type="text" class="time-input mono" data-time-input inputmode="numeric" autocomplete="off" placeholder="ΩΩ.ΛΛ" maxlength="5" pattern="([01][0-9]|2[0-3])[.][0-5][0-9]" title="24ωρη μορφή ώρας και λεπτών: ΩΩ.ΛΛ" value="' + esc(clockText(value)) + '" ' + extra.replace(/\bstep="[^"]*"/g, '') + '></div>';
  }
  return '<div class="field"><label for="f-' + esc(name) + '">' + esc(label) + '</label><input id="f-' + esc(name) + '" name="' + esc(name) + '" type="' + esc(type) + '" value="' + esc(value) + '" ' + extra + '></div>';
}
function selectField(label, name, options, extra = '') { return '<div class="field"><label for="f-' + esc(name) + '">' + esc(label) + '</label><select id="f-' + esc(name) + '" name="' + esc(name) + '" ' + extra + '>' + options + '</select></div>'; }
function toast(message, kind = '') {
  const node = document.createElement('div'); node.className = 'toast ' + kind; node.textContent = message;
  document.getElementById('toast-stack').appendChild(node); setTimeout(function() { node.remove(); }, kind === 'error' ? 9000 : 5000);
}
function setConnection(connected) {
  state.connected = connected;
  const el = document.getElementById('connection');
  if (el) { el.classList.toggle('offline', !connected); el.textContent = connected ? 'Συνδεδεμένο' : 'Η σύνδεση διακόπηκε'; }
}
function setBusy(value) {
  state.busy = value;
  document.querySelectorAll('[data-mutate], [data-submit], .employee-card').forEach(function(el) { el.disabled = value || state.requestBulkRunning; });
  document.querySelectorAll('.kiosk-admin-link').forEach(function(el) { el.setAttribute('aria-disabled', String(value)); });
  document.body.classList.toggle('is-busy', value);
}
function pendingStorageKey() { return 'ttn-command:' + String(state.context?.email || '').toLowerCase(); }
function savePending(command) {
  state.pendingCommand = command;
  try { if (command) sessionStorage.setItem(pendingStorageKey(), JSON.stringify(command)); else sessionStorage.removeItem(pendingStorageKey()); } catch {}
}
function restorePending() {
  try { state.pendingCommand = JSON.parse(sessionStorage.getItem(pendingStorageKey()) || 'null'); } catch { state.pendingCommand = null; }
}
function renderUncertain() {
  const box = document.getElementById('uncertain');
  if (!box) return;
  box.innerHTML = state.pendingCommand
    ? banner('Δεν έχει επιβεβαιωθεί η τελευταία αποθήκευση. Έλεγξε ξανά το ίδιο αίτημα πριν από νέα καταγραφή.', 'warning',
      '<div class="actions">' + button('Έλεγχος αποθήκευσης', 'retry-command', 'data-mutate', 'small') + '</div>') : '';
  box.classList.toggle('hidden', !state.pendingCommand);
}
const ATTENDANCE_ACTIONS = new Set(['record', 'correction', 'review', 'event_edit', 'event_void', 'admin_day_save', 'note_save', 'note_delete']);
function attendancePayload(action, payload) {
  const epoch = state.context?.attendance_epoch ?? state.context?.settings?.attendance_epoch;
  // Capture the dataset when a new command is created. A retry must retain
  // its original payload and must never be relabelled with a newer epoch.
  return ATTENDANCE_ACTIONS.has(action) && epoch !== undefined && epoch !== null
    ? { ...payload, attendance_epoch: epoch } : payload;
}
async function command(action, payload, retry = false, completionMessage = null, deletionPassword = null) {
  if (state.busy) throw new Error('Περίμενε να ολοκληρωθεί η προηγούμενη ενέργεια.');
  if (state.pendingCommand && !retry) throw new Error('Έλεγξε πρώτα την τελευταία αποθήκευση από το μήνυμα στην κορυφή.');
  const pending = retry ? state.pendingCommand : { action, payload: attendancePayload(action, payload), id: crypto.randomUUID(), email: state.context?.email, ...(completionMessage ? {completionMessage} : {}) };
  if (!pending) return null;
  savePending(pending); setBusy(true);
  try {
    if (deletionPassword !== null) await api.authorizeDeletion({action:pending.action,payload:pending.payload,request_id:pending.id,password:deletionPassword});
    const result = await api.command(pending.action, pending.payload, pending.id);
    savePending(null); setConnection(true); setServerTime(result?.server_now); return result;
  } catch (error) {
    if (!error.uncertain && ((error.status && error.status < 500) || error.details || error.code === 'P0001' || error.deletionAuthorization)) savePending(null);
    if (error.uncertain) setConnection(false);
    handleBrowserGate(error);
    throw error;
  } finally { setBusy(false); renderUncertain(); }
}
async function recoverDatasetChanged(error) {
  if (error?.uncertain || (error?.details?.code || error?.code) !== 'DATASET_CHANGED') return false;
  savePending(null);
  closeModal();
  state.employeeData = null; state.historyData = null; state.monthData = null; state.stats = null;
  state.overview = null; state.requests = null;
  const counter = document.getElementById('request-counter'); if (counter) counter.textContent = '—';
  state.adminDay = null; state.adminDayLoadToken++;
  if (state.context) await refreshApp();
  toast('Το παλιό αίτημα δεν εκτελέστηκε, επειδή το ιστορικό ενημερώθηκε. Επίλεξε ξανά την ενέργεια που θέλεις.', 'error');
  return true;
}
function issueMessages(error) {
  const details = error?.details || {};
  const issues = details.issues || details.state?.issues || [];
  return [error?.message || 'Η ενέργεια δεν ολοκληρώθηκε.'].concat(issues.slice(0, 5).map(function(i) {
    return i.message || (i.expected_actions?.length ? 'Χρειάζεται πρώτα: ' + i.expected_actions.map(function(a) { return ACTIONS[a] || a; }).join(' → ') : '');
  })).filter(Boolean).filter(function(v, i, all) { return all.indexOf(v) === i; }).join('\n');
}
function describeFlowFailure(error, attemptedEvents = [], details = error?.details) {
  if (error?.uncertain || !details || !(details.issues?.length || details.state?.issues?.length)) return error;
  error.flowDiagnostics = buildFlowDiagnostics(details, { attemptedEvents });
  return error;
}
function flowDiagnosticText(model) {
  return [model.title, model.intro, model.attemptSummary, ...model.items.map(function(item, index) {
    return [(index + 1) + '. ' + item.title, item.explanation,
      ...item.evidence.map(function(evidence) { return evidence.label + ': ' + evidence.text; }),
      item.timeWindow?.text, item.attemptExplanation, 'Τι χρειάζεται: ' + item.solution].filter(Boolean).join('\n');
  }), model.remainingCount ? 'Υπάρχουν ακόμη ' + model.remainingCount + ' ασυμφωνίες που χρειάζονται έλεγχο στις Καταγραφές.' : '', model.footer].filter(Boolean).join('\n\n');
}
function modalError(error, kind = '') {
  const node = document.getElementById('modal-error');
  if (!node) { toast(error.flowDiagnostics?.summary || issueMessages(error), 'error'); return; }
  node.classList.toggle('flow-diagnostic-error', Boolean(error.flowDiagnostics));
  if (error.flowDiagnostics) {
    node.textContent = '';
    const instruction = document.createElement('p');
    instruction.className = 'flow-diagnostic-summary';
    instruction.textContent = error.flowDiagnostics.summary || error.flowDiagnostics.intro;
    const details = document.createElement('details'); details.className = 'flow-diagnostic-details';
    const toggle = document.createElement('summary'); toggle.textContent = 'Αναλυτική εξήγηση';
    const explanation = document.createElement('div'); explanation.className = 'flow-diagnostic-text';
    explanation.textContent = flowDiagnosticText(error.flowDiagnostics);
    details.append(toggle, explanation); node.append(instruction, details);
  } else node.textContent = issueMessages(error);
  if (isAdmin() && error.details?.code === 'STALE_REVISION' && state.adminDay) {
    const p = document.createElement('p'); p.textContent = 'Οι ώρες άλλαξαν σε άλλη συσκευή. Φόρτωσε τη νεότερη εικόνα πριν αποθηκεύσεις ξανά. Οι μη αποθηκευμένες αλλαγές αυτής της φόρμας θα χαθούν.';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'button small'; b.dataset.action = 'admin-day-reload'; b.textContent = 'Φόρτωση νεότερων ωρών'; node.append(p, b);
  }
  if (isAdmin() && error.details?.code === 'DEPENDENT_EVENTS') {
    if (kind === 'admin-day') {
      const p = document.createElement('p'); p.textContent = 'Δεν διαγράφηκε καμία ώρα. Επίλεξε «Διαγραφή ώρας» και στις σχετικές κινήσεις που θέλεις να αφαιρέσεις, ώστε η ακολουθία να παραμένει σωστή, και αποθήκευσέ τες μαζί. Κίνηση άλλης ημέρας αλλάζει από την αντίστοιχη ημέρα.';
      const b = document.createElement('button'); b.type = 'button'; b.className = 'button small'; b.dataset.action = 'related-history'; b.dataset.employee = state.adminDay?.employeeId || ''; b.textContent = 'Άνοιγμα σχετικών καταγραφών';
      node.append(p, b); return;
    }
    const p = document.createElement('p'); p.textContent = 'Μπορείς να επιλέξεις τις σχετικές κινήσεις στις Καταγραφές και να τις ακυρώσεις μαζί.';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'button small'; b.dataset.action = 'related-history'; b.textContent = 'Άνοιγμα σχετικών καταγραφών';
    node.append(p, b);
  }
}
function clearPasswords(root) { root?.querySelectorAll('input[type="password"]').forEach(function(input) { input.value = ''; }); }
function clearKioskSelection() {
  if (!isOperator()) return;
  state.personToken++; state.selectedId = ''; state.employeeData = null;
}
function closeModal() {
  if (state.busy) return;
  state.correctionToken++; state.correctionGuidance = null;
  clearPasswords(modal); modal.close(); state.modalDevice = null; state.modalMember = null; state.modalBrowser = null;
  clearKioskSelection();
}
function openModal(title, subtitle, body, footer, kind = '', initialFocus = '') {
  state.correctionToken++;
  if (kind !== 'correction') state.correctionGuidance = null;
  if (modal.open) { clearPasswords(modal); modal.close(); }
  modal.classList.toggle('kiosk-dialog', isOperator());
  modal.classList.toggle('kiosk-actions-dialog', isOperator() && kind === 'kiosk-actions');
  modal.innerHTML = '<form id="modal-form" data-kind="' + esc(kind) + '"><header class="modal-header"><div><h2 id="modal-title">' + esc(title) + '</h2>' +
    (subtitle ? '<p>' + esc(subtitle) + '</p>' : '') + '</div>' + (isOperator() ? '' : '<button type="button" class="icon-button" data-action="close-modal" aria-label="Κλείσιμο">×</button>') + '</header>' +
    '<div class="modal-body"><div id="modal-error" class="modal-error" role="alert"></div>' + body + '</div>' +
    '<footer class="modal-footer">' + button(isOperator() ? 'Ακύρωση' : 'Άκυρο', 'close-modal', initialFocus === 'cancel' ? 'autofocus' : '') + footer + '</footer></form>';
  modal.showModal(); updateDstChoices(modal); colorAvatars();
  setTimeout(function() { modal.querySelector(initialFocus === 'cancel' ? 'button[data-action="close-modal"]' : 'input:not([type=hidden]),select,textarea,button')?.focus(); }, 30);
}
function submitButton(label, value = '') { return '<button class="button primary" type="submit" data-submit value="' + esc(value) + '">' + esc(label) + '</button>'; }
function dateTimeValues(iso = now()) {
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Athens', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);
  return { date: dateKey(d), time };
}
function dateTimeFields(iso, prefix, {emptyTime = false, date = today()} = {}) {
  const v = emptyTime ? {date, time: ''} : dateTimeValues(iso);
  const original = !emptyTime && iso ? String(iso instanceof Date ? iso.toISOString() : iso) : '';
  const occurrence = original ? originalOccurrence(original) : '';
  return field('Ημερομηνία', prefix + '_date', v.date, 'date', 'required data-dst="' + esc(prefix) + '"') +
    field('Ώρα', prefix + '_time', v.time, 'time', 'required data-dst="' + esc(prefix) + '"') +
    (original ? '<input type="hidden" name="' + esc(prefix) + '_original_at" value="' + esc(original) + '">' : '') + dstChoiceFields(prefix, occurrence);
}
function fixedDateTimeFields(date, prefix) {
  return '<input type="hidden" name="' + esc(prefix) + '_date" value="' + esc(date) + '" data-dst="' + esc(prefix) + '">' +
    field('Ώρα', prefix + '_time', '', 'time', 'required data-dst="' + esc(prefix) + '"') + dstChoiceFields(prefix);
}
function dstChoiceFields(prefix, selected = '') {
  return '<div class="field full dst-choice hidden" data-dst-choice="' + esc(prefix) + '"><label for="f-' + esc(prefix) + '_occurrence">Αυτή η ώρα εμφανίζεται δύο φορές</label><select name="' + esc(prefix) + '_occurrence" id="f-' + esc(prefix) + '_occurrence">' +
    option('', 'Επίλεξε εμφάνιση ώρας', selected) + option('earlier', 'Πρώτη εμφάνιση · πριν την αλλαγή ώρας', selected) + option('later', 'Δεύτερη εμφάνιση · μετά την αλλαγή ώρας', selected) + '</select></div>';
}
function originalOccurrence(iso) {
  try {
    const values = dateTimeValues(iso); const candidates = possibleInstants(values.date, values.time);
    return candidates.length > 1 ? (Date.parse(iso) < Date.parse(candidates[1]) ? 'earlier' : 'later') : '';
  } catch { return ''; }
}
function minuteTimeToIso(date, value, {original = '', choice = 'reject', allowSeconds = false} = {}) {
  const time = normalizeTime(value, {allowSeconds});
  const originalClock = original ? dateTimeValues(original) : null;
  const sameMinute = originalClock && originalClock.time.slice(0, 5) === time;
  if (sameMinute && originalClock.date === date && (originalOccurrence(original) || 'reject') === choice) return original;
  const result = localToIso(date, time, {disambiguation: choice});
  if (!sameMinute) return result;
  // A minute-only editor must not erase precision that it cannot display.
  const second = new Date(original).getUTCSeconds();
  const fraction = String(original).match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/i)?.[1] || '000';
  return new Date(Date.parse(result) + second * 1000).toISOString().replace(/\.\d{3}Z$/, '.' + fraction + 'Z');
}
function updateDstChoices(root) {
  root.querySelectorAll('[data-dst-choice]').forEach(function(box) {
    const prefix = box.dataset.dstChoice;
    const d = root.querySelector('[name="' + prefix + '_date"]')?.value;
    const t = root.querySelector('[name="' + prefix + '_time"]')?.value;
    let ambiguous = false; try { ambiguous = d && t && possibleInstants(d, normalizeTime(t)).length > 1; } catch {}
    box.classList.toggle('hidden', !ambiguous);
    const sel = box.querySelector('select'); if (sel) sel.required = Boolean(ambiguous);
  });
}
function isoFromForm(form, prefix) {
  const d = form.elements[prefix + '_date']?.value; const t = form.elements[prefix + '_time']?.value;
  const choice = form.elements[prefix + '_occurrence']?.value || 'reject';
  if (!d || !t) throw new Error('Συμπλήρωσε ημερομηνία και ώρα.');
  const original = form.elements[prefix + '_original_at']?.value;
  return minuteTimeToIso(d, t, {original, choice});
}
function captureBrowserRequest() {
  if (!pageMode.admin) return;
  const key = 'ttn-browser-review';
  try {
    const url = window.location?.href ? new URL(window.location.href) : null;
    const fromLink = url?.searchParams.get('browser_request');
    const request = fromLink || state.pendingBrowserRequest || sessionStorage.getItem(key) || '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request)) {
      state.pendingBrowserRequest = request;
      sessionStorage.setItem(key, request);
      if (fromLink) { state.authMode = 'admin'; state.signup = false; state.authResend = false; }
    }
    if (url?.searchParams.has('browser_request')) { url.searchParams.delete('browser_request'); window.history?.replaceState(null, '', url.href); }
  } catch {}
}
function clearBrowserRequest() {
  state.pendingBrowserRequest = ''; state.openedBrowserRequest = '';
  try { sessionStorage.removeItem('ttn-browser-review'); } catch {}
}
function browserLinkNotice() {
  if (!state.pendingBrowserRequest) return '';
  return banner(isOwner() ? 'Άνοιξες αίτημα έγκρισης browser. Έλεγξε τον υπολογιστή πριν επιβεβαιώσεις την πρόσβαση.' : 'Για την έγκριση αυτού του browser χρειάζεται σύνδεση με τον λογαριασμό ιδιοκτήτη.', 'warning',
    state.context || state.browserGate ? '<div class="actions">' + (isOwner() ? button('Έλεγχος αιτήματος', 'browser-review-link', '', 'small') : button('Σύνδεση ως ιδιοκτήτης', 'browser-owner-login', '', 'small')) + '</div>' : '');
}
function handleBrowserGate(error) {
  const code = error?.code === 'P0001' ? error.details?.code : (error?.details?.code || error?.code);
  if (!['BROWSER_PENDING', 'BROWSER_APPROVAL_REQUIRED', 'BROWSER_REQUIRED', 'BROWSER_REVOKED', 'BROWSER_STORAGE_UNAVAILABLE'].includes(code)) return false;
  const details = error.details || {};
  const browser = details.browser || details.device || {};
  const status = code === 'BROWSER_REVOKED' ? 'revoked' : (code === 'BROWSER_STORAGE_UNAVAILABLE' ? 'unavailable' : 'pending');
  state.sessionLoadToken++; state.loadToken++; state.personToken++; state.adminDayLoadToken++;
  state.browserGate = { status, browser, request_id:details.approval_request_id || browser.pending_request_id || '', notification: details.notification || {}, message: error.message || '' };
  state.browserPollAt = Date.now() + 15000;
  state.context = null; state.overview = null; state.employeeData = null; state.historyData = null; state.monthData = null; state.stats = null;
  state.requests = null; state.adminData = null; state.browserData = null; state.adminDay = null; state.nextScheduledRefresh = 0; state.selectedId = '';
  clearPasswords(modal); modal.close(); state.modalDevice = null; state.modalMember = null; state.modalBrowser = null;
  state.authMode = 'device'; state.signup = false; state.authResend = false; renderBrowserGate(); return true;
}
function renderBrowserGate() {
  const gate = state.browserGate; if (!gate) return;
  document.body.classList.remove('employee-kiosk', 'attendance-page', 'overview-page', 'top-navigation');
  clearPasswords(app);
  const revoked = gate.status === 'revoked'; const unavailable = gate.status === 'unavailable';
  const notification = gate.notification?.status;
  const title = unavailable ? 'Δεν μπορεί να ενεργοποιηθεί αυτός ο browser' : (revoked ? 'Η πρόσβαση του browser ανακλήθηκε' : 'Αναμονή έγκρισης υπολογιστή');
  const mail = notification === 'sent' ? 'Το αίτημα στάλθηκε με email στον ιδιοκτήτη. Η καταγραφή θα ανοίξει αφού εγκριθεί.' :
    (notification === 'not_configured' ? 'Η αποστολή email δεν έχει ρυθμιστεί. Ο διαχειριστής βλέπει το αίτημα στις Ρυθμίσεις.' :
    (notification === 'failed' ? 'Δεν επιβεβαιώθηκε η αποστολή email. Το αίτημα είναι διαθέσιμο στον ιδιοκτήτη στις Ρυθμίσεις.' : 'Ο ιδιοκτήτης μπορεί να ελέγξει το αίτημα από τις Ρυθμίσεις και να εγκρίνει αυτόν τον browser.'));
  app.innerHTML = '<div class="browser-gate-page"><section class="card browser-gate-card"><div class="brand"><span class="brand-mark">⏱</span><span>' + esc(APP_NAME) + '</span></div>' +
    '<span class="badge ' + (revoked || unavailable ? 'red' : 'amber') + '">' + (revoked ? 'Ανακληθείσα πρόσβαση' : (unavailable ? 'Χρειάζεται έλεγχος browser' : 'Εκκρεμεί έγκριση')) + '</span><h1>' + title + '</h1>' +
    '<p>' + esc(unavailable ? (gate.message || 'Χρειάζεται browser που επιτρέπει ασφαλή τοπική αποθήκευση. Έλεγξε τις ρυθμίσεις του και δοκίμασε ξανά.') : (revoked ? 'Ο ιδιοκτήτης έχει αφαιρέσει την πρόσβαση αυτού του browser. Δεν επιτρέπονται καταγραφές από εδώ.' : mail)) + '</p>' +
    (gate.browser.display_name || gate.browser.username || gate.browser.label ? '<div class="browser-gate-identity"><strong>' + esc(gate.browser.display_name || gate.browser.username || 'Υπολογιστής καταγραφής') + '</strong><small>' + esc(gate.browser.label || gate.browser.username || '') + '</small></div>' : '') +
    (gate.request_id ? '<p>Κωδικός αιτήματος: <strong class="mono">' + esc(String(gate.request_id).slice(0,8).toUpperCase()) + '</strong></p>' : '') +
    (gate.checkError ? '<div class="form-message error" role="status">' + esc(gate.checkError) + '</div>' : '') +
    '<div class="actions">' + button(state.browserCheckBusy ? 'Γίνεται έλεγχος…' : 'Έλεγχος έγκρισης', 'browser-check', state.browserCheckBusy ? 'disabled' : '', 'primary') + button('Αποσύνδεση', 'logout') + '</div>' +
    '<p class="field-help">Η έγκριση ισχύει για αυτόν τον browser και το συγκεκριμένο προφίλ του. Άλλος browser ή προφίλ χρειάζεται ξεχωριστή έγκριση. Όσο διατηρούνται τα δεδομένα του browser, η επανεκκίνηση διατηρεί την έγκριση και δεν στέλνει νέο αίτημα email.</p>' + browserLinkNotice() + '</section></div>';
}
async function checkBrowserApproval() {
  if (!state.browserGate || state.browserCheckBusy || state.authBusy || document.hidden) return;
  const token = state.sessionLoadToken; const gate = state.browserGate;
  const checkToken = ++state.browserCheckToken;
  state.browserCheckBusy = true; renderBrowserGate();
  try {
    const result = await api.browserStatus();
    if (token !== state.sessionLoadToken || state.browserGate !== gate) return;
    if (result.status === 'approved') { await enterApp(); return; }
    state.browserGate = { status: result.status === 'revoked' ? 'revoked' : 'pending', browser: result.browser || result.device || gate.browser, request_id:result.approval_request_id || gate.request_id || '', notification: result.notification || gate.notification };
  } catch (error) {
    if (token !== state.sessionLoadToken && state.browserGate !== gate) return;
    if (!handleBrowserGate(error)) state.browserGate = { ...gate, checkError: error.message || 'Δεν ήταν δυνατός ο έλεγχος. Δοκίμασε ξανά.' };
  } finally {
    if (checkToken === state.browserCheckToken) {
      state.browserCheckBusy = false; state.browserPollAt = Date.now() + 15000;
      if (state.browserGate) renderBrowserGate();
    }
  }
}
function renderLogin() {
  state.context = null;
  document.body.classList.remove('employee-kiosk', 'attendance-page', 'overview-page', 'top-navigation');
  clearPasswords(app);
  state.authMode = pageMode.admin ? 'admin' : 'device';
  const device = !pageMode.admin;
  const resend = !device && state.authResend;
  const signup = !device && !resend && state.signup;
  const title = resend ? 'Επιβεβαίωση email' : (signup ? 'Δημιουργία λογαριασμού' : (pageMode.admin ? 'Σύνδεση διαχείρισης' : 'Σύνδεση στην εφαρμογή'));
  app.innerHTML = '<div class="login-page">' + adminIdleBadge('admin-idle-login') + '<section class="login-story"><div class="brand"><span class="brand-mark">⏱</span><span>' + esc(APP_NAME) + '</span></div>' +
    '<h1>Η ομάδα σου.<br>Κάθε στιγμή,<br>σε σωστή σειρά.</h1><p>Καταγραφές παρουσίας, ξεκάθαρες διορθώσεις και μια κοινή εικόνα για την καθημερινή εργασία.</p><footer>Ώρα Ελλάδας · Οι αλλαγές επιβεβαιώνονται πριν εμφανιστούν ως αποθηκευμένες.</footer></section>' +
    '<section class="login-form-wrap"><form id="auth-form" class="login-form"><div class="eyebrow">Καλώς ήρθες</div>' + (device ? '<div class="auth-tabs" role="group" aria-label="Τρόπος σύνδεσης"><a class="button" href="' + esc(pageMode.adminUrl) + '">🔒 Διαχείριση</a>' +
    button('Υπολογιστής καταγραφής', 'auth-mode', 'data-mode="device" aria-pressed="true"', 'active') + '</div>' : '') + '<h2>' + title + '</h2><p>' +
    (device ? 'Βάλε το όνομα χρήστη και τον κωδικό που όρισε ο διαχειριστής για αυτόν τον υπολογιστή.' : (resend ? 'Στείλε νέο σύνδεσμο επιβεβαίωσης στο email σου.' : (signup ? 'Χρησιμοποίησε το email για το οποίο έχεις πρόσβαση.' : 'Συνδέσου με το προσωπικό σου email διαχείρισης.'))) + '</p>' +
    browserLinkNotice() + (state.authMessage ? '<div class="form-message ' + (state.authError ? 'error' : '') + '" role="status">' + esc(state.authMessage) + '</div>' : '') +
    (state.authRetryRestore ? button('Επανάληψη σύνδεσης', 'retry-restore', '', 'block') : '') +
    (device ? field('Όνομα χρήστη υπολογιστή', 'username', state.authUsername, 'text', 'required maxlength="48" autocomplete="username" autocapitalize="none" spellcheck="false"') : field('Email', 'email', state.authEmail, 'email', 'required autocomplete="username"')) +
    (resend ? '' : field('Κωδικός πρόσβασης', 'password', '', 'password', 'required minlength="' + (device ? '5' : '8') + '"' + (device ? ' maxlength="128"' : '') + ' autocomplete="' + (signup ? 'new-password' : 'current-password') + '"')) +
    '<button class="button primary block" type="submit" data-submit>' + (resend ? 'Αποστολή νέου συνδέσμου' : (signup ? 'Δημιουργία λογαριασμού' : 'Σύνδεση')) + '</button><div id="auth-progress" class="login-progress" aria-live="polite"></div>' +
    (device ? '' : '<div class="login-switch">' + (signup || resend ? 'Έχεις ήδη λογαριασμό; ' : 'Πρώτη φορά εδώ; ') + '<button type="button" data-action="toggle-signup">' + (signup || resend ? 'Σύνδεση' : 'Δημιουργία λογαριασμού') + '</button>' +
    (resend ? '' : '<button type="button" data-action="resend-confirmation">Νέο email επιβεβαίωσης</button>') + '</div>') +
    '<p class="login-help">' + (device ? 'Οι εργαζόμενοι επιλέγουν το όνομά τους και πατούν τις καταγραφές, χωρίς δικό τους email. Η σύνδεση διατηρείται σε αυτόν τον browser, χωρίς αποσύνδεση λόγω αδράνειας. Μπορεί να χρειαστεί νέα σύνδεση μετά από αποσύνδεση, αλλαγή πρόσβασης ή διαγραφή δεδομένων του browser.' : 'Η πρόσβαση δίνεται από τον διαχειριστή. Στο κοινό tablet χρησιμοποίησε λογαριασμό τερματικού, ώστε η διαχείριση να παραμένει προσωπική.') + '</p>' +
    (pageMode.admin ? button('🏠 Κατάστημα', 'return-shop', '', 'block') : '') + '</form></section></div>';
}
async function enterApp({freshAdmin = false} = {}) {
  const token = ++state.sessionLoadToken;
  const context = await api.context(); if (token !== state.sessionLoadToken) return;
  if (pageMode.admin && !['admin', 'reviewer'].includes(context.role)) {
    await api.signOut();
    throw new Error('Αυτός ο λογαριασμός δεν έχει πρόσβαση στη διαχείριση. Συνδέσου με το προσωπικό email διαχειριστή.');
  }
  if (!syncAdminIdle(context, freshAdmin)) { if (state.sessionReloadPending) return; await api.signOut(); state.authMessage = ADMIN_IDLE_MESSAGE; renderLogin(); return; }
  state.browserGate = null; state.browserPollAt = 0;
  state.context = context; setServerTime(context.server_now); updateRequestCounter(context.pending_count);
  if (legacyAdministrativeContext(context)) state.lastActivity = Date.now();
  restorePending(); state.view = pageMode.admin ? 'overview' : (VIEWS.find(function(v) { return v[3].includes(context.role); })?.[0] || 'overview');
  if (state.pendingBrowserRequest && isOwner()) state.view = 'settings';
  state.month ||= today().slice(0, 7); state.historyFrom ||= today().slice(0, 7) + '-01'; state.historyTo ||= today();
  reconcileSelections();
  renderShell(); await loadView(state.view);
  if (token === state.sessionLoadToken && state.pendingBrowserRequest && isOwner()) await reviewBrowserLink();
}
function attendanceShell(context) {
  const views = VIEWS.filter(function(view) { return view[3].includes(context.role); });
  function nav(view) {
    return '<button type="button" class="nav-button' + (view[0] === state.view ? ' active' : '') + '" data-action="navigate" data-view="' + view[0] + '"' + (view[0] === state.view ? ' aria-current="page"' : '') + '><span class="nav-label">' + esc(view[1]) + '</span>' + (view[0] === 'requests' ? '<span class="nav-counter" id="request-counter">' + esc(state.context?.pending_count ?? state.overview?.pending_count ?? '—') + '</span>' : '') + '</button>';
  }
  const clock = '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="16" cy="16" r="13"/><path d="M16 8v8h8"/></svg>';
  return '<div class="shell"><header class="sidebar" id="sidebar"><div class="brand"><span class="brand-mark">' + clock + '</span><span class="brand-text">' + esc(APP_NAME) + '</span></div><nav aria-label="Κύρια πλοήγηση">' + views.map(nav).join('') + '</nav>' +
    '<div class="header-actions">' + adminIdleBadge() + (pageMode.admin ? button('Κατάστημα','return-shop','','small return-shop-button') : '') + '<span id="connection" class="connection" title="Συνδεδεμένο">Συνδεδεμένο</span><time class="live-clock mono"></time><button class="icon-button" type="button" data-action="refresh" aria-label="Ανανέωση" title="Ανανέωση">↻</button>' +
    '</div>' +
    '<details class="attendance-account"><summary aria-label="Λογαριασμός διαχειριστή"><span class="avatar">' + esc(initials(context.display_name || context.username || context.email)) + '</span><span aria-hidden="true">⌄</span></summary><div class="attendance-account-menu"><strong>' + esc(context.display_name || context.username || context.email) + '</strong><small>' + esc(ROLES[context.role] || context.role) + '</small><button type="button" data-action="logout">Αποσύνδεση</button></div></details></header>' +
    '<div class="main-wrap"><div id="browser-link-notice" class="browser-link-notice">' + browserLinkNotice() + '</div><div id="uncertain" class="uncertain-banner hidden" role="alert"></div><main id="main" tabindex="-1"></main></div></div>';
}

function renderShell() {
  const ctx = state.context;
  document.body.classList.toggle('employee-kiosk', isOperator());
  document.body.classList.toggle('top-navigation', !isOperator());
  document.body.classList.toggle('attendance-page', state.view === 'stats' && !isOperator());
  document.body.classList.toggle('overview-page', state.view === 'overview' && !isOperator());
  if (isOperator()) {
    app.innerHTML = '<div class="kiosk-shell"><header class="kiosk-header"><h1>⏱ ' + esc(APP_NAME) + '</h1><nav class="kiosk-nav" aria-label="Κύρια πλοήγηση">' +
      adminIdleBadge() + '<button class="kiosk-nav-button active" type="button" data-action="kiosk-home" aria-current="page">🏠 Κατάστημα</button><a class="kiosk-nav-button kiosk-admin-link" href="' + esc(pageMode.adminUrl) + '">🔒 Διαχείριση</a></nav></header>' +
      '<div id="uncertain" class="uncertain-banner hidden" role="alert"></div><main id="main" class="kiosk-main" tabindex="-1"></main></div>';
    renderUncertain(); return;
  }
  app.innerHTML = attendanceShell(ctx);
  renderUncertain(); tick();
}

async function loadOverview() {
  return api.read('overview', {});
}
async function loadView(view, silent = false) {
  if (state.sessionReloadPending || !state.context) return;
  const token = ++state.loadToken; const main = document.getElementById('main');
  const selection = { selectedId: state.selectedId, personToken: state.personToken, historyId: state.historyId, historyDataset: viewDataset('history'), statsId: state.statsId, statsDataset: viewDataset('stats'), month: state.month, requestStatus: state.requestStatus, requestEmployee: state.requestEmployee };
  function isCurrent() {
    if (!state.context || token !== state.loadToken || state.view !== view) return false;
    if (view === 'record') return selection.selectedId === state.selectedId && selection.personToken === state.personToken;
    if (view === 'history') return selection.historyId === state.historyId && selection.historyDataset === viewDataset('history');
    if (view === 'stats') return selection.statsId === state.statsId && selection.month === state.month && selection.statsDataset === viewDataset('stats');
    if (view === 'requests') return selection.requestStatus === state.requestStatus && selection.requestEmployee === state.requestEmployee;
    return true;
  }
  if (!silent) main.innerHTML = loading();
  if (view === 'history' && (String(state.historyData?.employee?.id || '') !== String(selection.historyId) || dataDataset(state.historyData) !== selection.historyDataset)) state.historyData = null;
  if (view === 'stats' && (String(state.monthData?.employee?.id || '') !== String(selection.statsId) || state.monthData?.month !== selection.month || dataDataset(state.monthData) !== selection.statsDataset)) { state.monthData = null; state.stats = null; state.nextScheduledRefresh = 0; }
  try {
    const updates = {}; let serverTime = null;
    if (view === 'record' || view === 'overview') {
      const results = await Promise.all([loadOverview(), view === 'record' && selection.selectedId ? api.read('employee', { employee_id: selection.selectedId }) : Promise.resolve(null)]);
      updates.overview = results[0]; serverTime = results[0].server_now;
      if (results[1]) { updates.employeeData = results[1]; serverTime = results[1].server_now || serverTime; }
    } else if (view === 'history' && selection.historyId) {
      updates.historyData = await api.read('employee', { employee_id: selection.historyId, ...(selection.historyDataset === 'archive' ? { dataset: 'archive' } : {}) }); serverTime = updates.historyData.server_now;
    } else if (view === 'requests') {
      updates.requests = await api.read('requests', { status: selection.requestStatus || undefined, employee_id: selection.requestEmployee || undefined }); serverTime = updates.requests.server_now;
    } else if (view === 'stats' && selection.statsId) {
      updates.monthData = await api.read('month', { employee_id: selection.statsId, month: selection.month, ...(selection.statsDataset === 'archive' ? { dataset: 'archive' } : {}) }); serverTime = updates.monthData.server_now;
    } else if (view === 'settings') {
      const results = await Promise.all([api.read('admin', {}), isOwner() ? api.listBrowsers().catch(function(error) { return { devices: [], error: error.message || 'Δεν φορτώθηκαν οι εγκρίσεις browser.' }; }) : Promise.resolve(null)]);
      updates.adminData = results[0]; updates.browserData = results[1]; serverTime = updates.adminData.server_now || updates.browserData?.server_now;
    } else if (view === 'audit') {
      const data = await api.read('audit', { limit: 100 }); updates.audit = data.rows || []; updates.auditCursor = data.next_cursor; serverTime = data.server_now;
    }
    if (!isCurrent()) return;
    if ((updates.historyData && dataDataset(updates.historyData) !== selection.historyDataset) || (updates.monthData && dataDataset(updates.monthData) !== selection.statsDataset)) throw new Error('Δεν φορτώθηκε το επιλεγμένο ιστορικό. Δοκίμασε ανανέωση.');
    Object.assign(state, updates); setServerTime(serverTime);
    updateRequestCounter(updates.overview?.pending_count ?? updates.requests?.pending_count ?? state.context?.pending_count);
    renderCurrentView(); setConnection(true);
  } catch (error) {
    if (!isCurrent()) return;
    if (handleBrowserGate(error)) return;
    setConnection(Boolean(error.status && error.status < 500));
    main.innerHTML = heading(VIEWS.find(function(v) { return v[0] === view; })?.[1] || 'Εφαρμογή', 'Δεν ήταν δυνατή η φόρτωση.') +
      banner(esc(error.message || 'Δοκίμασε ξανά σε λίγο.'), 'error', '<div class="actions">' + button('Δοκιμή ξανά', 'refresh', '', 'small') + '</div>');
  }
}
function renderCurrentView() {
  const main = document.getElementById('main'); if (!main) return;
  document.body.classList.toggle('attendance-page', state.view === 'stats' && !isOperator());
  document.body.classList.toggle('overview-page', state.view === 'overview' && !isOperator());
  const renders = { record: renderRecord, overview: renderOverview, history: renderHistory, requests: renderRequests, stats: renderStats, employees: renderEmployees, settings: renderSettings, audit: renderAudit };
  main.innerHTML = (renders[state.view] || renderOverview)(); colorAvatars(); setBusy(state.busy); tick();
}
async function navigate(view) {
  if (!VIEWS.some(function(v) { return v[0] === view && v[3].includes(state.context?.role); })) return;
  if (state.busy) return;
  state.view = view; document.getElementById('sidebar')?.classList.remove('open');
  document.querySelectorAll('.nav-button').forEach(function(el) { el.classList.toggle('active', el.dataset.view === view); });
  const title = document.getElementById('current-view-name'); if (title) title.textContent = VIEWS.find(function(v) { return v[0] === view; })[1];
  await loadView(view);
}
async function refreshApp() {
  if (state.busy) return;
  const token = ++state.sessionLoadToken;
  try {
    const previousRole = state.context?.role;
    const context = await api.context(); if (token !== state.sessionLoadToken) return;
    if (pageMode.admin && !['admin', 'reviewer'].includes(context.role)) {
      await logout('Ο λογαριασμός δεν έχει πλέον πρόσβαση στη διαχείριση.');
      return;
    }
    if (!syncAdminIdle(context)) { if (state.sessionReloadPending) return; await logout(ADMIN_IDLE_MESSAGE); return; }
    state.context = context; setServerTime(context.server_now); updateRequestCounter(context.pending_count);
    if (expireAdminIdle()) return;
    reconcileSelections();
    if (!VIEWS.some(function(v) { return v[0] === state.view && v[3].includes(context.role); })) state.view = VIEWS.find(function(v) { return v[3].includes(context.role); })[0];
    if (previousRole !== context.role) renderShell();
    await loadView(state.view);
  } catch (error) { if (token !== state.sessionLoadToken || handleBrowserGate(error)) return; setConnection(false); toast(error.message, 'error'); }
}
function overviewEmployee(id) { return state.overview?.employees?.find(function(e) { return String(e.id) === String(id); }); }
function employeeGrid() {
  const query = state.search.toLocaleLowerCase('el-GR').trim();
  const list = activeEmployees().filter(function(e) { return (!state.department || e.department === state.department) && (!query || e.name.toLocaleLowerCase('el-GR').includes(query)); });
  return list.length ? list.map(function(e) {
    const s = stateOf(overviewEmployee(e.id));
    return '<button class="employee-card ' + (String(e.id) === String(state.selectedId) ? 'selected' : '') + '" type="button" data-action="select-employee" data-id="' + esc(e.id) + '" data-state="' + esc(s.state) + '" aria-pressed="' + (String(e.id) === String(state.selectedId)) + '"><span class="status-dot"></span>' + avatar(e) + '<div class="employee-name">' + esc(e.name) + '</div><div class="employee-dept">' + esc(e.department || 'Ομάδα') + '</div></button>';
  }).join('') : empty('Δεν βρέθηκαν εργαζόμενοι', 'Δοκίμασε διαφορετικό όνομα ή τμήμα.');
}
function renderRecord() {
  const employees = activeEmployees();
  if (isOperator()) return renderKioskNames(employees);
  if (!employees.length) return heading('Καταγραφή παρουσίας', 'Είσοδος, διάλειμμα και έξοδος σε σωστή σειρά.') + '<div class="card">' + empty('Η ομάδα σου ξεκινά εδώ', isAdmin() ? 'Πρόσθεσε το προσωπικό για να αρχίσουν οι καταγραφές.' : 'Ο διαχειριστής δεν έχει προσθέσει ακόμη ενεργούς εργαζομένους.', isAdmin() ? button('Προσθήκη προσωπικού', 'navigate', 'data-view="employees"', 'primary') : '') + '</div>';
  const departments = [...new Set(employees.map(function(e) { return e.department; }).filter(Boolean))].sort();
  return heading('Καταγραφή παρουσίας', 'Επίλεξε το όνομά σου και την ενέργεια που θέλεις να καταγράψεις.') +
    '<div class="kiosk-layout"><section class="card"><div class="card-heading"><h2>Η ομάδα</h2><span class="badge">' + employees.length + ' εργαζόμενοι</span></div><div class="filter-row">' +
    '<div class="field"><label for="employee-search" class="sr-only">Αναζήτηση εργαζομένου</label><input id="employee-search" name="employee_search" type="search" placeholder="Αναζήτηση ονόματος…" value="' + esc(state.search) + '" autocomplete="off"></div>' +
    '<div class="field"><label for="employee-department" class="sr-only">Τμήμα</label><select id="employee-department" name="employee_department">' + option('', 'Όλα τα τμήματα', state.department) + departments.map(function(d) { return option(d, d, state.department); }).join('') + '</select></div></div><div id="employee-grid" class="employee-grid">' + employeeGrid() + '</div></section>' +
    '<aside class="employee-panel card" id="employee-panel">' + renderSelectedPerson() + '</aside></div>';
}
function renderKioskNames(employees) {
  if (!employees.length) return '<p class="kiosk-empty" role="status">Δεν υπάρχουν ενεργοί εργαζόμενοι.</p>';
  let html = ''; let department = null;
  employees.forEach(function(e) {
    const nextDepartment = e.department || '';
    if (department !== nextDepartment) {
      if (department !== null) html += '</div></section>';
      html += '<section class="kiosk-section">' + (nextDepartment ? '<h2 class="kiosk-section-title">' + esc(nextDepartment) + '</h2>' : '') + '<div class="kiosk-grid">';
      department = nextDepartment;
    }
    html += '<button class="employee-card kiosk-employee" type="button" data-action="select-employee" data-id="' + esc(e.id) + '" data-color="' + esc(/^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#ffffff') + '">' + esc(e.name) + '</button>';
  });
  return html + '</div></section>';
}
function kioskActions(id) {
  const actions = [
    ['clock_in', '🚪 Είσοδος'], ['clock_out', '🚶 Έξοδος'],
    ['break_start', '☕ Διάλειμμα Έναρξη'], ['break_end', '🔙 Επιστροφή από διάλειμμα']
  ];
  return '<div class="kiosk-action-grid">' + actions.map(function(action) {
    return '<button type="button" class="kiosk-action" data-action="record-action" data-type="' + action[0] + '" data-mutate>' + action[1] + '</button>';
  }).join('') + '<button type="button" class="kiosk-action kiosk-correction" data-action="open-correction" data-id="' + esc(id) + '" data-mutate>⚠ Αίτημα Διόρθωσης</button></div>';
}
function renderSelectedPerson() {
  const e = employee(state.selectedId);
  if (!e) return empty('Έτοιμοι για σήμερα', 'Επίλεξε έναν εργαζόμενο για να δεις την κατάστασή του και τις διαθέσιμες ενέργειες.');
  if (!state.employeeData || String(state.employeeData.employee?.id) !== String(e.id)) return loading();
  const data = state.employeeData; const s = stateOf(data);
  const issues = s.issues || [];
  const recent = (data.events || []).filter(function(ev) { return !['void', 'rejected', 'draft'].includes(ev.status) && Date.parse(ev.event_at) <= now().getTime(); }).slice(-5).reverse();
  const stateDescription = s.open_break_at ? 'Διάλειμμα από ' + displayTime(s.open_break_at) : (s.open_shift_at ? 'Είσοδος ' + displayDate(s.open_shift_at) + ' στις ' + displayTime(s.open_shift_at) : 'Δεν υπάρχει ανοιχτή βάρδια.');
  return '<div class="selected-person">' + avatar(e) + '<div><h2>' + esc(e.name) + '</h2><span class="muted">' + esc(e.department || 'Ομάδα') + '</span></div></div>' +
    '<div class="state-panel">' + badgeForState(s) + ' ' + pendingBadge(s.pending_count, e.id) + '<p>' + esc(stateDescription) + '</p>' +
    (s.open_break_at ? '<p class="strong mono" data-elapsed="' + esc(s.open_break_at) + '"></p>' : '') + '</div>' +
    (issues.length ? banner('Χρειάζονται διορθώσεις για να συνεχίσεις.' + '<ul class="issue-list">' + issues.slice(0, 3).map(function(i) { return '<li>' + esc(i.message || 'Έλεγξε την ακολουθία ενεργειών.') + '</li>'; }).join('') + '</ul>', 'warning') : '') +
    '<div class="action-grid">' +
    '<button class="attendance-button clock-in" type="button" data-action="record-action" data-type="clock_in" data-mutate><span>↗</span>Είσοδος</button>' +
    '<button class="attendance-button break-start" type="button" data-action="record-action" data-type="break_start" data-mutate><span>☕</span>Έναρξη διαλείμματος</button>' +
    '<button class="attendance-button break-end" type="button" data-action="record-action" data-type="break_end" data-mutate><span>↶</span>Επιστροφή από διάλειμμα</button>' +
    '<button class="attendance-button clock-out" type="button" data-action="record-action" data-type="clock_out" data-mutate><span>↗</span>Έξοδος</button></div>' +
    '<div class="actions">' + button('Αίτημα διόρθωσης', 'open-correction', 'data-id="' + esc(e.id) + '"', 'text') + (state.context.role === 'operator' ? '' : button('Ιστορικό', 'person-history', 'data-id="' + esc(e.id) + '"', 'text')) + '</div>' +
    '<h3 class="muted">Τελευταίες κινήσεις</h3><ul class="recent-list">' + recent.map(function(ev) { return '<li><span>' + esc(ACTIONS[ev.type]) + (ev.status === 'pending' ? ' <small>· σε αναμονή</small>' : '') + '</span><span class="mono">' + esc(displayTime(ev.event_at)) + '<small> · ' + esc(displayDate(ev.event_at)) + '</small></span></li>'; }).join('') + '</ul>' +
    '<p class="field-help">Οι διορθώσεις προσμετρώνται προσωρινά. Μπορείς να συνεχίσεις όταν έχουν καλυφθεί όλες οι ελλείψεις.</p>';
}
let breakDayCache = {key:'',start:0};
function liveBreakTiming(startAt, closedMinutes, closedDate, limit) {
  const current = now(), timestamp = Date.parse(startAt), key = dateKey(current);
  if (!Number.isFinite(timestamp) || timestamp > current.getTime()) return null;
  if (breakDayCache.key !== key) breakDayCache = {key,start:Date.parse(localToIso(key,'00:00'))};
  const closed = closedDate === key ? Math.max(0,Number(closedMinutes) || 0) : 0;
  const openToday = Math.max(0,current.getTime()-Math.max(timestamp,breakDayCache.start))/60000;
  return {elapsed:Math.floor(Math.max(0,current.getTime()-timestamp)/60000),excess:Math.max(0,Math.round(closed+openToday-Math.max(0,Number(limit) || 0)))};
}
function liveBreakInfo(person, people = state.overview?.employees || []) {
  const status = stateOf(person);
  if (status.state !== 'ON_BREAK' || !status.open_break_at) return null;
  const date = state.overview?.server_now ? dateKey(state.overview.server_now) : today();
  const limit = state.context?.settings?.break_limit_minutes ?? 30;
  const timing = liveBreakTiming(status.open_break_at,person.break_closed_today_minutes,date,limit);
  if (!timing) return null;
  const department = String(person.department || '').trim().toLocaleLowerCase('el-GR');
  const colleagues = department && status.valid !== false ? people.filter(function(other) {
    const peer = stateOf(other);
    return String(other.id) !== String(person.id) && String(other.department || '').trim().toLocaleLowerCase('el-GR') === department && peer.valid !== false && peer.state === 'ON_BREAK' && Number.isFinite(Date.parse(peer.open_break_at)) && Date.parse(peer.open_break_at) <= now().getTime();
  }) : [];
  return {...timing,startAt:status.open_break_at,closed:person.break_closed_today_minutes || 0,date,limit,colleagues};
}
function updateLiveBreakExcess(element) {
  const timing = liveBreakTiming(element.dataset.breakStart,element.dataset.breakClosed,element.dataset.breakDay,element.dataset.breakLimit);
  const excess = timing?.excess || 0;
  element.textContent = excess ? 'Υπέρβαση +' + excess + 'λ' : '';
  element.classList.toggle('hidden',!excess);
}
function renderOverview() {
  const rows = (state.overview?.employees || []).filter(function(e) { return !e.archived && !e.deleted_at; });
  const groups = [['IN', 'Μέσα', 'green'], ['ON_BREAK', 'Σε διάλειμμα', 'amber'], ['OUT', 'Εκτός', '']];
  const counts = groups.map(function(g) { return rows.filter(function(e) { return stateOf(e).state === g[0]; }).length; });
  return '<div class="overview-content">' + heading('Ζωντανή εικόνα', 'Η κατάσταση της ομάδας με εγκεκριμένες και εκκρεμείς διορθώσεις.') +
    '<div class="metric-grid">' + metric('Μέσα στην εργασία', counts[0], 'Ενεργές βάρδιες') + metric('Σε διάλειμμα', counts[1], 'Ανοιχτά διαλείμματα') + metric('Εκτός', counts[2], 'Χωρίς ανοιχτή βάρδια') + metric('Εκκρεμείς διορθώσεις', state.overview?.pending_count || 0, 'Προς έλεγχο', 'open-requests') + '</div>' +
    (rows.some(function(e) { return stateOf(e).valid === false; }) ? banner('Υπάρχουν ακολουθίες που χρειάζονται έλεγχο. Άνοιξε τον εργαζόμενο για τις ελλείψεις.', 'warning') : '') +
    '<div class="overview-columns">' + groups.map(function(g) {
      const list = rows.filter(function(e) { return stateOf(e).state === g[0]; });
      return '<section class="overview-group"><h3>' + esc(g[1]) + '<span class="badge ' + g[2] + '">' + list.length + '</span></h3>' + (list.length ? '<div class="overview-people">' + list.map(function(e) {
        const status = stateOf(e), info = liveBreakInfo(e,rows), together = Boolean(info?.colleagues.length);
        const shared = together ? 'Ταυτόχρονο διάλειμμα με: ' + info.colleagues.map(function(peer) { return peer.name; }).join(', ') : '';
        const startLabel = info ? (dateKey(info.startAt) === today() ? '' : displayDate(info.startAt).slice(0,5)+' ') + displayTime(info.startAt) : '';
        return '<button type="button" class="person-row' + (together ? ' break-together' : '') + '"' + (shared ? ' title="' + esc(shared) + '"' : '') + ' data-action="' + (canRecord() ? 'select-person-from-overview' : 'person-history') + '" data-id="' + esc(e.id) + '">' + '<div class="overview-person-main">' + avatar(e) +
          '<div class="overview-person-text"><span class="strong overview-person-name">' + esc(e.name) + '</span><small>' + esc(e.department || 'Ομάδα') + (together ? ' · <span class="attendance-negative">Μαζί</span><span class="sr-only">' + esc(shared) + '</span>' : '') + '</small>' +
          (info ? '<small class="overview-break-start">από <time datetime="' + esc(info.startAt) + '">' + esc(startLabel) + '</time> · <span data-elapsed="' + esc(info.startAt) + '">' + esc(formatMinutes(info.elapsed)) + '</span> <span class="overview-break-excess attendance-negative' + (!info.excess ? ' hidden' : '') + '" data-live-break data-break-start="' + esc(info.startAt) + '" data-break-closed="' + esc(info.closed) + '" data-break-day="' + esc(info.date) + '" data-break-limit="' + esc(info.limit) + '">' + (info.excess ? 'Υπέρβαση +' + info.excess + 'λ' : '') + '</span></small>' : '') + '</div>' +
          '</div>' + ((status.valid === false || status.pending_count) ? '<div class="overview-person-footer">' + (status.valid === false ? '<span class="badge red">Έλεγχος</span>' : '') + pendingBadge(status.pending_count) + '</div>' : '') + '</button>';
      }).join('') + '</div>' : '<p class="muted">Κανένας εργαζόμενος.</p>') + '</section>';
    }).join('') + '</div><p class="footer-note">Ανανέωση ανά 30 δευτερόλεπτα · Ώρα Ελλάδας</p></div>';
}
function metric(label, value, foot, action = null) {
  const clickable = action && ['admin','reviewer'].includes(state.context?.role);
  return (clickable ? '<button type="button" class="metric metric-link" data-action="' + esc(action) + '">' : '<div class="metric">') + '<span class="metric-label">' + esc(label) + '</span><span class="metric-value mono">' + esc(value) + '</span><span class="metric-foot">' + esc(foot) + '</span>' + (clickable ? '</button>' : '</div>');
}
function filteredHistory() {
  return (state.historyData?.events || []).filter(function(ev) {
    const day = dateKey(ev.event_at);
    return (!state.historyFrom || day >= state.historyFrom) && (!state.historyTo || day <= state.historyTo) && (!state.historyStatus || ev.status === state.historyStatus) && (!state.historyType || ev.type === state.historyType);
  }).slice().reverse();
}
function renderHistory() {
  if (!state.historyId) return heading('Καταγραφές', 'Το ιστορικό κινήσεων κάθε εργαζομένου.') + '<div class="card">' + empty('Δεν υπάρχουν εργαζόμενοι', 'Πρόσθεσε πρώτα το προσωπικό.') + '</div>';
  const readOnly = isArchiveView('history');
  const canEdit = isAdmin() && !readOnly, canDelete = isOwner() && !readOnly;
  const rows = filteredHistory();
  const filters = '<div class="filter-row">' + datasetField('history') + selectField('Εργαζόμενος', 'history_employee', employeeOptions(state.historyId,false,state.showArchived)) +
    field('Από', 'history_from', state.historyFrom, 'date') + field('Έως', 'history_to', state.historyTo, 'date') +
    selectField('Κατάσταση', 'history_status', option('', 'Όλες', state.historyStatus) + Object.entries(STATUS).map(function(p) { return option(p[0], p[1], state.historyStatus); }).join('')) +
    selectField('Ενέργεια', 'history_type', option('', 'Όλες', state.historyType) + Object.entries(ACTIONS).map(function(p) { return option(p[0], p[1], state.historyType); }).join('')) + '</div>';
  return heading('Καταγραφές', 'Πλήρες ιστορικό, με διακριτές τις εκκρεμείς και τις ακυρωμένες κινήσεις.', canRecord() && !readOnly ? button('Νέα διόρθωση', 'open-correction', 'data-id="' + esc(state.historyId) + '"', 'primary') : '') +
    '<section class="card">' + filters + (readOnly ? archiveNotice() : '') + (canDelete ? '<div id="bulk-bar" class="bulk-bar history-delete-bar"><span id="bulk-label">0 επιλεγμένες κινήσεις</span>' + button('Διαγραφή επιλεγμένων', 'void-selected', 'id="delete-selected-events" disabled', 'danger small') + '</div>' : '') +
    (state.historyData?.history_limited ? '<p class="field-help">Στο τερματικό εμφανίζονται έως 200 πρόσφατες κινήσεις. Το πλήρες ιστορικό είναι διαθέσιμο στη διαχείριση.</p>' : '') +
    (rows.length ? '<div class="table-wrap"><table><thead><tr><th>Ημερομηνία & ώρα</th><th>Ενέργεια</th><th>Κατάσταση</th><th>Σημείωση</th>' + (canEdit ? '<th>Ενέργειες</th>' : '') + (canDelete ? '<th class="history-selection-col"><label class="check-label"><input type="checkbox" id="select-all-events" data-mutate aria-label="Επιλογή όλων των εμφανιζόμενων κινήσεων που μπορούν να διαγραφούν">Επιλογή όλων</label></th>' : '') + '</tr></thead><tbody>' + rows.map(function(ev) {
      const editable = ['approved', 'pending'].includes(ev.status);
      const deletable = canDelete && ['approved', 'pending', 'draft'].includes(ev.status);
      return '<tr><td class="mono">' + esc(displayDate(ev.event_at)) + '<br><strong>' + esc(displayTime(ev.event_at, true)) + '</strong></td><td>' + esc(ACTIONS[ev.type] || ev.type) + '</td><td>' + eventStatusBadge(ev) + '</td><td class="wrap">' + esc(ev.reason || '—') + (ev.source === 'history_cleanup' ? '<small class="shift-line">Εκτιμώμενη παλιά ώρα</small>' : (ev.source === 'admin' || ev.source === 'admin_edit' ? '<small class="shift-line">Ώρα διαχειριστή</small>' : '')) + '</td>' +
        (canEdit ? '<td><div class="actions">' + (editable ? button('Αλλαγή ώρας', 'edit-event', 'data-id="' + esc(ev.id) + '"', 'small') : '') + (deletable ? button('Διαγραφή', 'delete-history-event', 'data-id="' + esc(ev.id) + '" data-mutate', 'danger small') : '') + '</div></td>' : '') + (canDelete ? '<td class="history-selection-col">' + (deletable ? '<input type="checkbox" class="event-check" value="' + esc(ev.id) + '" data-mutate aria-label="' + esc('Επιλογή κίνησης: ' + (ACTIONS[ev.type] || ev.type) + ', ' + displayDate(ev.event_at) + ' ' + displayTime(ev.event_at)) + '">' : '') + '</td>' : '') + '</tr>';
    }).join('') + '</tbody></table></div><div class="table-footer"><span>' + rows.length + ' καταγραφές</span><span>Οι ακυρωμένες κινήσεις εμφανίζονται με κατάσταση «Ακυρωμένη» και δεν υπολογίζονται στις ώρες.</span></div>' : empty('Δεν υπάρχουν κινήσεις', 'Άλλαξε τα φίλτρα ή επίλεξε διαφορετικό εργαζόμενο.')) + '</section>';
}
function visibleRequestRows() { return (state.requests?.events || []).filter(function(ev) { return !(state.context?.employees || []).some(function(e) { return String(e.id) === String(ev.employee_id) && (e.archived || e.deleted_at); }); }); }
function pendingRequestRows() {
  return visibleRequestRows().filter(function(ev) {
    return ev.status === 'pending' && (!state.requestEmployee || String(ev.employee_id) === String(state.requestEmployee)) && (!state.requestStatus || ['all','pending'].includes(state.requestStatus));
  });
}
function reconcileRequestSelection() {
  const scope = JSON.stringify([state.requestStatus,state.requestEmployee]);
  if (!isAdmin() || scope !== state.requestSelectionScope) { state.requestSelection = new Set(); state.requestBulkResult = null; }
  state.requestSelectionScope = scope;
  const visible = new Set(pendingRequestRows().map(function(ev) { return String(ev.id); }));
  state.requestSelection = new Set([...state.requestSelection].filter(function(id) { return visible.has(String(id)); }));
  return visible;
}
function requestBulkSummaryHtml() {
  const result = state.requestBulkResult;
  if (!result) return '';
  if (result.uncertain && !state.pendingCommand) { state.requestBulkResult = null; return ''; }
  let message = 'Εγκρίθηκαν ' + result.approved + ' από ' + result.total + ' επιλεγμένα αιτήματα.';
  if (result.failed.length) message += ' Δεν εγκρίθηκαν ' + result.failed.length + '.';
  const unattempted = result.total-result.approved-result.failed.length-(result.uncertain ? 1 : 0);
  if (unattempted > 0) message += ' Δεν επιχειρήθηκε ακόμη η έγκριση ' + unattempted + ' αιτημάτων.';
  if (result.uncertain) message += ' Η τελευταία έγκριση δεν έχει επιβεβαιωθεί. Χρησιμοποίησε τον έλεγχο αποθήκευσης στην κορυφή πριν συνεχίσεις.';
  if (result.failed.length) message += '<ul>' + result.failed.map(function(failure) { return '<li>' + esc(failure.name + ': ' + failure.message) + '</li>'; }).join('') + '</ul>';
  return banner(message,result.failed.length || result.uncertain ? 'warning' : 'success');
}
function renderRequests() {
  const rows = visibleRequestRows(), pending = reconcileRequestSelection(), bulk = isAdmin();
  const selected = state.requestSelection.size;
  const selection = bulk && pending.size ? '<div class="request-bulk-actions"><span class="request-selection" role="status">' + selected + ' επιλεγμένα</span>' + button('Έγκριση επιλεγμένων (' + selected + ')','approve-selected-requests',(!selected || state.pendingCommand ? 'disabled' : 'data-mutate'),'primary') + '</div>' : '';
  const selectAll = bulk ? '<th scope="col" class="request-checkbox-col">' + (pending.size ? '<label class="check-label"><input type="checkbox" id="select-all-requests" data-mutate' + (selected === pending.size ? ' checked' : '') + ' aria-label="Επιλογή όλων των εμφανιζόμενων εκκρεμών αιτημάτων">Επιλογή όλων</label>' : '<span class="sr-only">Επιλογή</span>') + '</th>' : '';
  return '<div class="requests-content">' + heading('Διορθώσεις', 'Έλεγξε τις δηλωμένες κινήσεις και την ακολουθία στην οποία ανήκουν.') +
    '<section class="card requests-card"><div class="filter-row">' + selectField('Κατάσταση', 'request_status', option('', 'Όλες', state.requestStatus) + Object.entries(STATUS).filter(function(p) { return p[0] !== 'void'; }).map(function(p) { return option(p[0], p[1], state.requestStatus); }).join(''),'data-mutate') +
    selectField('Εργαζόμενος', 'request_employee', employeeOptions(state.requestEmployee, true),'data-mutate') + '</div>' + requestBulkSummaryHtml() + selection +
    (rows.length ? '<div class="table-wrap"><table><thead><tr><th>Εργαζόμενος</th><th>Ενέργεια</th><th>Δηλωμένη ώρα</th><th>Αίτημα</th><th>Κατάσταση</th><th></th>' + selectAll + '</tr></thead><tbody>' + rows.map(function(ev) {
      const id = String(ev.id);
      return '<tr><td><strong>' + esc(ev.employee_name || personName(ev.employee_id)) + '</strong></td><td>' + esc(ACTIONS[ev.type] || ev.type) + '</td><td class="mono">' + esc(displayDate(ev.event_at)) + '<br>' + esc(displayTime(ev.event_at, true)) + '</td><td class="wrap">' + esc(ev.reason || '—') + '<small class="shift-line">' + esc(displayDate(ev.created_at)) + ' ' + esc(displayTime(ev.created_at)) + '</small></td><td>' + statusBadge(ev.status) + '</td><td>' +
        (ev.status === 'pending' && isAdmin() ? button('Έλεγχος', 'review-event', 'data-id="' + esc(ev.id) + '" data-mutate', 'small primary') : button('Ιστορικό', 'person-history', 'data-id="' + esc(ev.employee_id) + '"', 'small')) + '</td>' + (bulk ? '<td class="request-checkbox-col">' + (pending.has(id) ? '<input type="checkbox" class="request-checkbox" data-request-id="' + esc(id) + '" data-mutate aria-label="' + esc('Επιλογή αιτήματος: ' + (ev.employee_name || personName(ev.employee_id)) + ', ' + (ACTIONS[ev.type] || ev.type) + ', ' + displayDate(ev.event_at) + ' ' + displayTime(ev.event_at)) + '"' + (state.requestSelection.has(id) ? ' checked' : '') + '>' : '') + '</td>' : '') + '</tr>';
    }).join('') + '</tbody></table></div>' : empty('Η λίστα είναι καθαρή', 'Δεν υπάρχουν αιτήματα με τα επιλεγμένα φίλτρα.')) + '</section></div>';
}
async function approveSelectedRequests() {
  if (!isAdmin() || state.view !== 'requests' || state.busy || state.requestBulkRunning || state.pendingCommand) return;
  reconcileRequestSelection();
  const rows = pendingRequestRows().filter(function(ev) { return state.requestSelection.has(String(ev.id)); }).sort(function(a,b) {
    return Date.parse(a.event_at)-Date.parse(b.event_at) || Number(a.tie_order || 0)-Number(b.tie_order || 0) || String(a.id).localeCompare(String(b.id));
  });
  if (!rows.length) return;
  const session = state.sessionLoadToken, result = {approved:0,total:rows.length,failed:[],uncertain:false};
  state.requestBulkRunning = true; state.requestBulkResult = null; setBusy(false);
  try {
    for (const ev of rows) {
      if (session !== state.sessionLoadToken || !isAdmin() || state.browserGate) break;
      try {
        await command('review',{event_id:ev.id,decision:'approve'});
        result.approved++; state.requestSelection.delete(String(ev.id)); ev.status = 'approved';
      } catch (error) {
        if (await recoverDatasetChanged(error)) return;
        if (state.pendingCommand || error.uncertain) { result.uncertain = true; break; }
        result.failed.push({name:ev.employee_name || personName(ev.employee_id),message:error.message || 'Η έγκριση δεν ολοκληρώθηκε.'});
        if (state.browserGate || [401,403,429].includes(error.status)) break;
      }
    }
    if (session !== state.sessionLoadToken || !isAdmin() || state.browserGate) return;
    state.requestBulkResult = result;
    renderCurrentView();
    await refreshApp();
    if (!state.context || state.view !== 'requests') return;
    const summary = 'Εγκρίθηκαν ' + result.approved + ' από ' + result.total + ' επιλεγμένα αιτήματα.' + (result.uncertain ? ' Η τελευταία έγκριση χρειάζεται επιβεβαίωση αποθήκευσης.' : result.failed.length ? ' Τα αιτήματα που δεν εγκρίθηκαν παραμένουν για έλεγχο.' : '');
    toast(summary,result.failed.length || result.uncertain ? 'error' : 'success');
  } finally {
    state.requestBulkRunning = false; setBusy(false);
    if (state.context && state.view === 'requests') renderCurrentView();
  }
}

function timeCell(iso, id, employeeId, context = {}) {
  const estimated = Boolean(iso && id && allKnownEvents().some(function(e) { return String(e.id) === String(id) && e.source === 'history_cleanup'; }));
  const title = estimated ? ' title="Εκτιμώμενη παλιά ώρα"' : '';
  const text = esc(displayTime(iso)) + (estimated ? '<sup aria-label="Εκτιμώμενη παλιά ώρα">*</sup>' : '');
  if (!isAdmin() || isArchiveView('stats')) return '<span class="mono"' + title + '>' + text + '</span>';
  const day = iso ? dateKey(iso) : context.date;
  return '<button type="button" class="time-button mono' + (!iso ? ' empty-time' : '') + '"' + title + ' data-action="admin-day" data-id="' + esc(id || '') + '" data-employee="' + esc(employeeId) + '" data-date="' + esc(day || today()) + '" data-type="' + esc(context.type || '') + '" data-shift="' + esc(context.shift_ref || '') + '" data-break="' + esc(context.break_ref || '') + '"' + (iso ? ' data-time="' + esc(iso) + '"' : '') + '>' + (iso ? text : '+ ' + esc(ACTIONS[context.type] || 'Ώρα')) + '</button>';
}

function newAdminSlot(type, id = crypto.randomUUID(), event = null, date = state.adminDay?.date || today(), options = {}) {
  const values = event?.event_at ? dateTimeValues(event.event_at) : { date, time: '' };
  let occurrence = '';
  if (event?.event_at) { try { const candidates = possibleInstants(values.date, values.time); if (candidates.length > 1) occurrence = Date.parse(event.event_at) < Date.parse(candidates[1]) ? 'earlier' : 'later'; } catch {} }
  return { id, type, key: crypto.randomUUID(), original: event, date: values.date, time: values.time,
    occurrence, initial_occurrence: occurrence, closes_open_break: type === 'clock_out' ? (event ? Boolean(event.closes_open_break) : true) : false,
    readonly: Boolean(event && options.anchor && dateKey(event.event_at) !== date), remove: false };
}
function newAdminBreak(group, startId = crypto.randomUUID()) {
  return { id: startId, start: newAdminSlot('break_start', startId, null, group.date), end: newAdminSlot('break_end', crypto.randomUUID(), null, group.date) };
}
function newAdminShift(date, id = crypto.randomUUID(), anchor = null) {
  const group = { id, date, entry: newAdminSlot('clock_in', id, anchor, date, { anchor: true }), exit: newAdminSlot('clock_out', crypto.randomUUID(), null, date), breaks: [] };
  return group;
}
function adminSlots(model = state.adminDay) {
  return (model?.groups || []).flatMap(function(group) { return [group.entry, ...group.breaks.flatMap(function(br) { return [br.start, br.end]; }), group.exit]; });
}
function buildAdminDayModel(data, preferred = {}) {
  const raw = (data.entries || []).filter(function(e) { return !['void', 'rejected'].includes(e.status); });
  const unique = new Map();
  [...(state.monthData?.events || []), ...(data.relevant_anchors || []), ...raw].forEach(function(e) { if (e?.id) unique.set(String(e.id), e); });
  const all = [...unique.values()]; const references = new Map();
  let shift = null, activeBreak = null;
  effectiveEvents(all).forEach(function(e) {
    if (e.type === 'clock_in') { shift = e.shift_ref || e.id; activeBreak = null; }
    const sr = e.shift_ref || shift;
    if (e.type === 'break_start') activeBreak = e.break_ref || e.id;
    references.set(String(e.id), { shift_ref: sr, break_ref: e.break_ref || activeBreak });
    if (e.type === 'break_end') activeBreak = null;
    if (e.type === 'clock_out') { shift = null; activeBreak = null; }
  });
  const model = { employeeId: data.employee?.id || state.statsId, date: data.date, revision: data.revision, groups: [], preferred, source: data };
  function groupFor(id) {
    id = id || crypto.randomUUID();
    let group = model.groups.find(function(g) { return String(g.id) === String(id); });
    if (!group) { const anchor = unique.get(String(id)); group = newAdminShift(model.date, id, anchor?.type === 'clock_in' ? anchor : null); model.groups.push(group); }
    return group;
  }
  function breakFor(group, id) {
    id = id || crypto.randomUUID(); let br = group.breaks.find(function(b) { return String(b.id) === String(id); });
    if (!br) { br = newAdminBreak(group, id); const anchor = unique.get(String(id)); if (anchor?.type === 'break_start') br.start = newAdminSlot('break_start', id, anchor, model.date, { anchor: true }); group.breaks.push(br); }
    return br;
  }
  for (const e of raw) {
    const refs = references.get(String(e.id)) || {};
    const group = groupFor(e.shift_ref || refs.shift_ref || (e.type === 'clock_in' ? e.id : model.groups.at(-1)?.id));
    if (e.type === 'clock_in') group.entry = newAdminSlot(e.type, e.id, e, model.date);
    else if (e.type === 'clock_out') group.exit = newAdminSlot(e.type, e.id, e, model.date);
    else {
      const br = breakFor(group, e.break_ref || refs.break_ref || (e.type === 'break_start' ? e.id : group.breaks.at(-1)?.id));
      br[e.type === 'break_start' ? 'start' : 'end'] = newAdminSlot(e.type, e.id, e, model.date);
    }
  }
  if (preferred.break_ref && model.groups.length) breakFor(groupFor(preferred.shift_ref || model.groups[0].id), preferred.break_ref);
  if (!model.groups.length) {
    let carry = preferred.shift_ref;
    if (!carry) {
      try { const boundary = localToIso(model.date, '00:00'); const before = replay(all.filter(function(e) { return Date.parse(e.event_at) < Date.parse(boundary); }), { now: boundary, includeScheduled: true }); if (before.valid) carry = before.open_shift_id; } catch {}
    }
    const group = groupFor(carry);
    if (preferred.break_ref) breakFor(group, preferred.break_ref);
  }
  model.groups.forEach(function(group) {
    if (!group.exit.original) {
      const anchor = all.find(function(e) { return !['void','rejected','draft'].includes(e.status) && e.type === 'clock_out' && String(e.shift_ref || references.get(String(e.id))?.shift_ref) === String(group.id); });
      if (anchor) group.exit = newAdminSlot('clock_out', anchor.id, anchor, model.date, { anchor: true });
    }
    group.breaks.forEach(function(br) {
      if (!br.end.original) {
        const anchor = all.find(function(e) { return !['void','rejected','draft'].includes(e.status) && e.type === 'break_end' && String(e.break_ref || references.get(String(e.id))?.break_ref) === String(br.id); });
        if (anchor) br.end = newAdminSlot('break_end', anchor.id, anchor, model.date, { anchor: true });
      }
    });
    if (!group.breaks.length) group.breaks.push(newAdminBreak(group));
  });
  return model;
}
function adminSlotHtml(slot, group, br = null) {
  const prefix = 'admin_' + slot.key;
  const label = ACTIONS[slot.type];
  const saved = slot.original;
  const marker = saved?.source === 'history_cleanup' ? '<span class="badge amber">Εκτιμώμενη παλιά ώρα</span>' : (saved?.status === 'draft' ? '<span class="badge">Πρόχειρη · αναμονή προϋποθέσεων</span>' : (saved && isScheduledEvent(saved) ? '<span class="badge planned">Ορισμένη ώρα</span>' : (saved?.source === 'admin' ? '<span class="badge">Από διαχειριστή</span>' : '')));
  if (slot.readonly) return '<section class="admin-slot anchor"><div class="admin-slot-title"><strong>' + esc(label) + '</strong>' + marker + '<span class="badge">Άλλη ημέρα</span></div><p class="mono">' + esc(displayDate(saved.event_at)) + ' · ' + esc(displayTime(saved.event_at, true)) + '</p><small>Η αρχική κίνηση διατηρείται. Άλλαξέ την από την αντίστοιχη ημέρα.</small></section>';
  return '<section class="admin-slot' + (slot.remove ? ' removed' : '') + '" data-admin-slot="' + esc(slot.key) + '"><div class="admin-slot-title"><strong>' + esc(label) + '</strong>' + marker +
    (saved && isOwner() ? button(slot.remove ? 'Αναίρεση διαγραφής' : 'Διαγραφή ώρας', 'admin-remove-slot', 'data-key="' + esc(slot.key) + '"', slot.remove ? 'text small' : 'text small danger') : '') + '</div>' +
    (slot.remove ? '<p class="muted">Η ώρα ' + esc(displayDate(saved.event_at)) + ' στις <strong class="mono">' + esc(displayTime(saved.event_at)) + '</strong> θα αφαιρεθεί από το παρουσιολόγιο όταν πατήσεις «Αποθήκευση ωρών». Το ίχνος της αλλαγής διατηρείται στο ιστορικό.</p>' : '<div class="admin-time-fields">' +
      field('Ημερομηνία', prefix + '_date', slot.date, 'date', 'data-dst="' + esc(prefix) + '"') +
      field('Ώρα', prefix + '_time', slot.time, 'time', 'data-dst="' + esc(prefix) + '"') +
      '<div class="field full dst-choice hidden" data-dst-choice="' + esc(prefix) + '"><label>Εμφάνιση ώρας</label><select name="' + esc(prefix) + '_occurrence">' + option('', 'Επίλεξε εμφάνιση', slot.occurrence) + option('earlier', 'Πρώτη εμφάνιση', slot.occurrence) + option('later', 'Δεύτερη εμφάνιση', slot.occurrence) + '</select></div></div>' +
      (slot.type === 'clock_out' ? '<label class="check-label admin-close-break"><input type="checkbox" name="' + esc(prefix) + '_close"' + (slot.closes_open_break ? ' checked' : '') + '>Στην έξοδο κλείνει και τυχόν ανοιχτό διάλειμμα</label>' : '')) + '</section>';
}
function captureAdminDayFields(form = document.getElementById('modal-form')) {
  if (!form?.elements || !state.adminDay) return;
  adminSlots().forEach(function(slot) {
    const prefix = 'admin_' + slot.key; const f = form.elements;
    if (slot.readonly || slot.remove) return;
    if (f[prefix + '_date']) slot.date = f[prefix + '_date'].value;
    if (f[prefix + '_time']) slot.time = f[prefix + '_time'].value;
    if (f[prefix + '_occurrence']) slot.occurrence = f[prefix + '_occurrence'].value;
    if (f[prefix + '_close']) slot.closes_open_break = f[prefix + '_close'].checked;
  });
  if (form.elements.admin_reason) state.adminDay.reason = form.elements.admin_reason.value;
}
function renderAdminDayEditor() {
  const model = state.adminDay; if (!model || !isAdmin()) return;
  const removals = adminSlots(model).filter(function(slot) { return slot.original && slot.remove && !slot.readonly; }).length;
  const body = banner('Μπορείς να ορίσεις ώρες χωρίς προηγούμενα χτυπήματα. Οι μελλοντικές ώρες ισχύουν όταν φτάσει η ώρα τους. Ελλιπείς νέες κινήσεις μένουν πρόχειρες μέχρι να συμπληρωθούν οι προϋποθέσεις.', '') +
    '<div class="admin-day-groups">' + model.groups.map(function(group, index) {
      return '<section class="admin-shift"><div class="admin-shift-title"><h3>' + (index + 1) + 'η βάρδια</h3></div><div class="admin-shift-ends">' + adminSlotHtml(group.entry, group) + adminSlotHtml(group.exit, group) + '</div>' +
        '<div class="admin-breaks">' + group.breaks.map(function(br, i) { return '<div class="admin-break"><h4>' + (i + 1) + 'ο διάλειμμα</h4><div class="admin-shift-ends">' + adminSlotHtml(br.start, group, br) + adminSlotHtml(br.end, group, br) + '</div></div>'; }).join('') + '</div>' +
        button('+ Νέο διάλειμμα', 'admin-add-break', 'data-group="' + esc(group.id) + '"', 'text small') + '</section>';
    }).join('') + '</div>' + button('+ Νέα βάρδια', 'admin-add-shift', '', 'text') +
    deletionPasswordField(removals) +
    '<div class="field"><label for="f-admin_reason">Αιτιολογία καταχώρησης · προαιρετική</label><textarea name="admin_reason" id="f-admin_reason" maxlength="1000" placeholder="Π.χ. ορισμός ωρών από τον διαχειριστή">' + esc(model.reason || '') + '</textarea></div>' +
    '<p class="field-help">Συμπλήρωσε μόνο όσα θέλεις να ορίσεις. Τα κενά πεδία παραμένουν διαθέσιμα και δεν δημιουργούν χτυπήματα. Οι αλλαγές αποθηκεύονται όλες μαζί.</p>' +
    '<p class="field-help">Για λανθασμένη υπάρχουσα καταγραφή, επίλεξε «Διαγραφή ώρας» και αποθήκευσε. Δεν αφαιρούνται αυτόματα άλλες κινήσεις: αν εξαρτώνται από αυτήν, επίλεξέ τες επίσης για διαγραφή, ώστε η ακολουθία να παραμένει σωστή.</p>';
  openModal('Ώρες ημέρας', personName(model.employeeId) + ' · ' + dateDisplay(model.date), body, submitButton('Αποθήκευση ωρών'), 'admin-day', removals ? 'cancel' : '');
}
async function openAdminDay(employeeId, date, preferred = {}) {
  if (!isAdmin() || isArchiveView() || !employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return;
  const token = ++state.adminDayLoadToken;
  const view = state.view, selected = view === 'stats' ? state.statsId : (view === 'history' ? state.historyId : null), reportScope = statsScope();
  try {
    const data = await api.read('admin_day', { employee_id: employeeId, date });
    if (token !== state.adminDayLoadToken || !isAdmin() || isArchiveView() || state.view !== view || (view === 'stats' && (state.statsId !== selected || reportScope !== statsScope())) || (view === 'history' && state.historyId !== selected)) return;
    setServerTime(data.server_now);
    state.adminDay = buildAdminDayModel({ ...data, date, employee: data.employee || employee(employeeId) }, preferred);
    const model = state.adminDay;
    let group = model.groups.find(function(g) { return String(g.id) === String(preferred.shift_ref); }) || model.groups[0];
    if (preferred.add === 'shift') { group = newAdminShift(date); group.breaks.push(newAdminBreak(group)); model.groups.push(group); }
    if (preferred.add === 'break') {
      const blank = group.breaks.find(function(br) { return !br.start.original && !br.end.original && !br.start.time && !br.end.time; });
      if (!blank) group.breaks.push(newAdminBreak(group));
    }
    const slots = adminSlots(model);
    let focus = preferred.event_id ? slots.find(function(s) { return String(s.id) === String(preferred.event_id); }) : null;
    if (!focus && preferred.type) {
      const br = preferred.break_ref ? group.breaks.find(function(b) { return String(b.id) === String(preferred.break_ref); }) : null;
      focus = br ? br[preferred.type === 'break_end' ? 'end' : 'start'] : slots.find(function(s) { return s.type === preferred.type && !s.readonly && !s.time; });
    }
    if (focus && !focus.original && preferred.time) { const v = dateTimeValues(preferred.time); focus.date = v.date; focus.time = v.time; }
    renderAdminDayEditor();
    if (focus) setTimeout(function() { modal.querySelector('[name="admin_' + focus.key + '_time"]')?.focus(); }, 50);
  } catch (error) { toast(error.message || 'Δεν φορτώθηκαν οι ώρες ημέρας.', 'error'); }
}
function adminDayEntriesFromForm(form) {
  captureAdminDayFields(form);
  const model = state.adminDay; const entries = [];
  for (const group of model.groups) {
    for (const slot of [group.entry, ...group.breaks.flatMap(function(br) { return [br.start, br.end]; }), group.exit]) {
      if (slot.readonly) continue;
      if (slot.remove) { if (slot.original) entries.push({ id: slot.id, remove: true }); continue; }
      if (!slot.time) { if (slot.original?.event_at) throw new Error('Για να αφαιρέσεις υπάρχουσα ώρα, επίλεξε «Διαγραφή ώρας» στην αντίστοιχη κίνηση και μετά «Αποθήκευση ωρών».'); continue; }
      const at = minuteTimeToIso(slot.date, slot.time, {original: slot.original?.event_at, choice: slot.occurrence || 'reject', allowSeconds: true});
      const br = group.breaks.find(function(b) { return b.start === slot || b.end === slot; });
      if (slot.original && at === slot.original.event_at && slot.closes_open_break === Boolean(slot.original.closes_open_break)) continue;
      entries.push({ id: slot.id, type: slot.type, event_at: at, shift_ref: group.id,
        ...(br ? { break_ref: br.id } : {}), ...(slot.type === 'clock_out' ? { closes_open_break: slot.closes_open_break } : {}) });
    }
  }
  return entries;
}
const STATS_MONTHS = ['Ιανουάριος', 'Φεβρουάριος', 'Μάρτιος', 'Απρίλιος', 'Μάιος', 'Ιούνιος', 'Ιούλιος', 'Αύγουστος', 'Σεπτέμβριος', 'Οκτώβριος', 'Νοέμβριος', 'Δεκέμβριος'];
function statsFullDate(key) {
  const value = new Intl.DateTimeFormat('el-GR', { timeZone: 'Europe/Athens', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(key + 'T12:00:00Z'));
  return value.charAt(0).toLocaleUpperCase('el-GR') + value.slice(1);
}
function statsHours(minutes) { return formatMinutes(Number(minutes) || 0); }
function statsMinuteText(minutes) { return Math.round(Number(minutes) || 0) + 'λ'; }
function statsScope() { return viewDataset('stats') + ':' + state.statsId + ':' + state.month; }
function statsYears() {
  const current = Number(today().slice(0, 4)), selected = Number(String(state.month).slice(0, 4));
  const years = new Set();
  for (let year = Math.max(2000, current - 10); year <= Math.min(9999, current + 5); year++) years.add(year);
  if (Number.isInteger(selected) && selected >= 2000 && selected <= 9999) years.add(selected);
  const range = state.context?.history_archive;
  const from = Number(String(range?.from || '').slice(0, 4)), to = Number(String(range?.to || '').slice(0, 4));
  if (from >= 2000 && to <= 9999 && to >= from && to - from <= 100) for (let year = from; year <= to; year++) years.add(year);
  for (const raw of [range?.from, range?.to, ...(state.monthData?.events || []).map(function(e) { return e.event_at; })]) {
    const year = Number(String(raw || '').slice(0, 4)); if (Number.isInteger(year) && year >= 2000 && year <= 9999) years.add(year);
  }
  return [...years].sort(function(a, b) { return a - b; });
}
function statsEmployeeList() {
  const search = state.statsSearch.trim().toLocaleLowerCase('el-GR');
  const people = visibleEmployees(state.statsShowArchived).filter(function(e) {
    return (state.statsShowArchived || !e.archived) &&
      (!state.statsDepartment || e.department === state.statsDepartment) &&
      (!search || (e.name + ' ' + (e.department || '')).toLocaleLowerCase('el-GR').includes(search));
  });
  return people.length ? people.map(function(e) {
    const selected = String(e.id) === String(state.statsId);
    return '<button type="button" class="attendance-person' + (selected ? ' selected' : '') + '" data-action="stats-select-employee" data-id="' + esc(e.id) + '" aria-pressed="' + selected + '">' + avatar(e) + '<span><strong>' + esc(e.name) + '</strong><small>' + esc(e.department || 'Χωρίς τμήμα') + (e.archived ? ' · Αρχειοθετημένος' : '') + '</small></span>' + (selected ? '<span class="attendance-person-check" aria-hidden="true">✓</span>' : '') + '</button>';
  }).join('') : '<p class="attendance-list-empty" role="status">Δεν βρέθηκαν εργαζόμενοι με αυτά τα φίλτρα.</p>';
}
function statsPeoplePanel() {
  const departments = [...new Set(visibleEmployees(state.statsShowArchived).map(function(e) { return e.department; }).filter(Boolean))].sort();
  return '<aside class="attendance-people" aria-label="Εργαζόμενοι"><div class="attendance-people-heading"><h2>Εργαζόμενοι</h2><span>' + visibleEmployees(state.statsShowArchived).filter(function(e) { return !e.archived; }).length + '</span></div>' +
    '<div class="field attendance-search"><label class="sr-only" for="attendance-search">Αναζήτηση εργαζομένου</label><input id="attendance-search" type="search" placeholder="Αναζήτηση εργαζομένου…" value="' + esc(state.statsSearch) + '"></div>' +
    (departments.length > 1 ? selectField('Τμήμα', 'stats_department', option('', 'Όλα τα τμήματα', state.statsDepartment) + departments.map(function(d) { return option(d, d, state.statsDepartment); }).join('')) : '') +
    '<label class="check-label attendance-archive-toggle"><input type="checkbox" name="stats_show_archived"' + (state.statsShowArchived ? ' checked' : '') + '>Και αρχειοθετημένοι</label>' +
    '<div id="attendance-employee-list" class="attendance-employee-list" role="group" aria-label="Επιλογή εργαζομένου">' + statsEmployeeList() + '</div>' +
    '</aside>';
}
function statsNoteCell(day, canEdit) {
  return (canEdit ? '<button type="button" class="note-chip" data-action="edit-note" data-date="' + esc(day.date) + '">' : '<span class="note-chip">') +
    (day.note ? '<strong>' + esc(NOTES[day.note.kind] || 'Σημείωση') + '</strong>' + (day.note.text ? '<br>' + esc(day.note.text) : '') : (canEdit ? 'Προσθέστε σημείωση για την ημέρα…' : 'Δεν υπάρχει σημείωση.')) +
    (canEdit ? '</button>' : '</span>');
}
function statsDayDrafts(day, rawEvents) { return rawEvents.filter(function(e) { return e.status === 'draft' && (e.admin_day || dateKey(e.event_at)) === day.date; }); }
function sharedBreakNoteHtml(day) {
  const names = (day.shared_break_colleagues || []).map(function(person) { return person.name; });
  return names.length ? '<span class="attendance-shared-break-note">Μαζί σε διάλειμμα με: ' + esc(names.join(', ')) + '</span>' : '';
}
function statsNeedsAttention(day, rawEvents) {
  return Boolean(day.shared_break_colleagues?.length || day.pending_count || day.issues.length || day.shortfall_minutes || day.break_excess_minutes || day.late_minutes || day.early_departure_minutes || statsDayDrafts(day, rawEvents).length || (day.has_open_shift && day.date < today()));
}
function statsHasPresence(day, preview) { return Boolean(day.shifts.length || preview.shifts.length); }
function statsDayStatus(day, preview, rawEvents) {
  const tags = [];
  if (day.pending_count) tags.push(pendingBadge(day.pending_count, state.statsId, day.pending_count === 1 ? 'Διόρθωση υποβλήθηκε' : day.pending_count + ' εκκρεμείς διορθώσεις'));
  if (day.issues.length || (day.has_open_shift && day.date < today())) tags.push('<span class="badge red">Χρειάζεται έλεγχο</span>');
  else if (day.has_open_shift || (day.shifts.length && day.date === today() && !day.evaluation_complete)) tags.push('<span class="badge blue">Σε εξέλιξη</span>');
  else if (day.shortfall_minutes || day.break_excess_minutes || day.late_minutes || day.early_departure_minutes) tags.push('<span class="badge red">Απόκλιση</span>');
  else if (day.evaluation_complete) tags.push('<span class="badge green">Πλήρης</span>');
  if (statsDayDrafts(day, rawEvents).length) tags.push('<span class="badge amber">Πρόχειρη</span>');
  if (preview.shifts.some(function(s) { return isScheduledEvent({source:'admin',status:'approved',event_at:s.start_at}) || isScheduledEvent({source:'admin',status:'approved',event_at:s.end_at}); })) tags.push('<span class="badge blue">Ορισμένη ώρα</span>');
  if (day.note) tags.push('<span class="attendance-note-indicator" title="' + esc(day.note.text || NOTES[day.note.kind]) + '">' + esc(NOTES[day.note.kind] || 'Σημείωση') + '</span>');
  return tags.length ? tags.join('') : '<span class="attendance-empty-label">—</span>';
}
function statsDayRow(day, preview, rawEvents) {
  const selected = state.statsSelectedDay === day.date, present = statsHasPresence(day, preview);
  const presence = preview.shifts.map(function(shift, index) {
    const early = day.early_departure_minutes > 0 && String(shift.end_id) === String(day.final_departure_id);
    return '<div class="attendance-presence-line mono"><span' + (shift.late_minutes ? ' class="attendance-negative"' : '') + '>' + esc(displayTime(shift.start_at)) + '</span><span class="attendance-time-separator" aria-label="έως">→</span><span' + (early ? ' class="attendance-negative"' : '') + '>' + (shift.end_at ? esc(displayTime(shift.end_at)) : '…') + '</span>' +
      (shift.carried_in || shift.carried_out ? '<span class="attendance-crossday" title="Παρουσία μεταξύ ημερών">↗</span>' : '') + '</div>' +
      (shift.late_minutes ? '<small class="attendance-negative">Αργοπορία ' + statsMinuteText(shift.late_minutes) + '</small>' : '') +
      (early ? '<small class="attendance-negative">Πρόωρη έξοδος ' + statsMinuteText(day.early_departure_minutes) + '</small>' : '');
  }).join('');
  const planned = rawEvents.some(function(e) { return isScheduledEvent(e) && dateKey(e.event_at) === day.date; });
  return '<tr data-stats-day="' + esc(day.date) + '" class="' + (selected ? 'attendance-selected-day ' : '') + (!present ? 'attendance-empty-day ' : '') + ([0,6].includes(day.weekday) ? 'attendance-weekend' : '') + '">' +
    '<td><button type="button" class="attendance-day-select" data-action="stats-select-day" data-date="' + esc(day.date) + '" aria-pressed="' + selected + '" aria-controls="attendance-day-detail" aria-label="Λεπτομέρειες: ' + esc(statsFullDate(day.date)) + '"><strong>' + esc(new Intl.DateTimeFormat('el-GR', {weekday:'short',timeZone:'Europe/Athens'}).format(new Date(day.date + 'T12:00:00Z'))) + '</strong><small>' + esc(day.date.slice(8)) + '</small></button></td>' +
    '<td>' + (presence || '<span class="attendance-empty-label">—</span>') + '</td>' +
    '<td><span class="attendance-break-summary">' + (day.break_count ? day.break_count + (day.break_count === 1 ? ' διάλειμμα · ' : ' διαλείμματα · ') : '') + '<strong class="mono">' + (day.break_count || day.break_minutes ? statsMinuteText(day.break_minutes) : '—') + '</strong></span>' +
    (day.break_excess_minutes ? '<small class="attendance-negative">+' + statsMinuteText(day.break_excess_minutes) + ' υπέρβαση</small>' : '') + '</td>' +
    '<td><strong class="mono' + (day.shortfall_minutes ? ' attendance-negative' : '') + '">' + (day.shifts.some(function(s) { return s.closed; }) ? statsHours(day.gross_minutes) : '—') + '</strong>' +
    (day.shortfall_minutes > 0 ? '<small class="attendance-negative">−' + Math.round(day.shortfall_minutes) + ' λ από το ' + (day.target_minutes === 480 ? '8ωρο' : esc(formatMinutes(day.target_minutes))) + '</small>' : '') +
    (day.has_open_shift ? '<small>Ανοιχτή: ' + esc(formatMinutes(day.estimated_open_minutes)) + '</small>' : '') +
    (planned && preview.gross_minutes ? '<small class="planned-line">Ορισμένη παρουσία: ' + esc(formatMinutes(preview.gross_minutes)) + '</small>' : '') + '</td>' +
    '<td><div class="attendance-day-status">' + statsDayStatus(day, preview, rawEvents) + '</div></td><td>' + (sharedBreakNoteHtml(day) || '<span class="attendance-empty-label">—</span>') + '</td></tr>';
}
const ATTENDANCE_EDIT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 4 5 5M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15Z"/></svg>';
function statsMovementParts(value, id, day, type, refs, generated = false) {
  const control = generated ? '<span class="mono">' + esc(displayTime(value)) + '</span>' : timeCell(value,id,state.statsId,{date:day.date,type,...refs});
  if (!control.startsWith('<button')) return {time:control,inline:control,edit:''};
  const end = control.indexOf('>'), content = control.slice(end+1,-9);
  const edit = control.slice(0,end).replace(/class="[^"]*"/,'class="icon-button attendance-edit-button"') + ' aria-label="Αλλαγή: ' + esc(ACTIONS[type]) + (value ? ' ' + esc(displayTime(value)) : '') + '">' + ATTENDANCE_EDIT_ICON + '</button>';
  return {time:'<span class="mono">' + content + '</span>',inline:control.replace('>',' tabindex="-1">'),edit};
}
function statsTimelineEntry(type, value, id, day, refs, rawById, description = '', generated = false) {
  const raw = rawById.get(String(id)), planned = isScheduledEvent(raw), pending = raw?.status === 'pending';
  const parts = statsMovementParts(value,id,day,type,refs,generated);
  return '<li class="attendance-timeline-event' + (type.startsWith('break_') ? ' attendance-timeline-break' : '') + (type === 'clock_out' ? ' attendance-timeline-exit' : '') + (planned ? ' attendance-timeline-planned' : '') + '"><span class="attendance-event-dot" aria-hidden="true"></span><div class="attendance-event-time' + (description.includes('attendance-negative') ? ' attendance-negative' : '') + '">' + parts.time + '</div><div class="attendance-event-label"><strong>' + esc(ACTIONS[type]) + '</strong>' +
    (value && dateKey(value) !== day.date ? '<small>' + esc(displayDate(value)) + ' · άλλη ημέρα</small>' : '') +
    (description ? '<small>' + description + '</small>' : '') + (generated ? '<small>Κλείσιμο με την έξοδο</small>' : '') +
    (planned ? '<small class="planned-line">Ορισμένη ώρα · εκτός πραγματικών συνόλων</small>' : '') + (pending ? '<small class="attendance-pending">Προσωρινή · εκκρεμεί έγκριση</small>' : '') + '</div><div class="attendance-event-edit">' + parts.edit + '</div></li>';
}
function statsBreakPair(br, number, shift, day, rawById) {
  const refs = {shift_ref:shift.start_id,break_ref:br.start_id};
  const start = statsMovementParts(br.start_at,br.start_id,day,'break_start',refs);
  const end = statsMovementParts(br.end_at,br.generated_end ? null : br.end_id,day,'break_end',refs,br.generated_end);
  const planned = isScheduledEvent(rawById.get(String(br.start_id))) || isScheduledEvent(rawById.get(String(br.end_id)));
  const otherDate = [br.start_at,br.end_at].filter(Boolean).some(function(value) { return dateKey(value) !== day.date; });
  return '<li class="attendance-timeline-event attendance-timeline-break attendance-timeline-break-pair' + (planned ? ' attendance-timeline-planned' : '') + '"><span class="attendance-event-dot" aria-hidden="true"></span><div class="attendance-event-time attendance-time-range">' + start.inline + '<span aria-hidden="true">–</span>' + end.inline + '</div><div class="attendance-event-label"><strong>Διάλειμμα ' + number + '</strong>' +
    (otherDate ? '<small>' + [br.start_at,br.end_at].filter(Boolean).map(function(value) { return esc(displayDate(value)); }).join(' – ') + '</small>' : '') +
    (!br.closed ? '<small>Ανοιχτό διάλειμμα</small>' : '') + (br.generated_end ? '<small>Κλείσιμο με την έξοδο</small>' : '') +
    (planned ? '<small class="planned-line">Ορισμένη ώρα · εκτός πραγματικών συνόλων</small>' : '') + (br.pending ? '<small class="attendance-pending">Προσωρινή · εκκρεμεί έγκριση</small>' : '') + '</div><div class="attendance-event-edit">' + (start.edit || end.edit) + '</div></li>';
}
function statsDayPanel(day, preview, rawEvents, rawById, canEdit) {
  if (!day) return '<aside id="attendance-day-detail" class="attendance-detail attendance-detail-empty" aria-label="Λεπτομέρειες ημέρας">' + empty('Επίλεξε μια ημέρα', 'Δες αναλυτικά κάθε παρουσία, διάλειμμα και σημείωση.') + '</aside>';
  const attrs = 'data-employee="' + esc(state.statsId) + '" data-date="' + esc(day.date) + '"';
  const shown = new Set();let breakNumber = 0;
  const periods = preview.shifts.map(function(shift, index) {
    const refs = {shift_ref:shift.start_id}, items = [];
    function add(type, value, id, extra = {}, description = '', generated = false) { if (id) shown.add(String(id)); items.push({value,html:statsTimelineEntry(type,value,id,day,{...refs,...extra},rawById,description,generated)}); }
    add('clock_in',shift.start_at,shift.start_id,{},shift.late_minutes ? '<span class="attendance-negative">Αργοπορία ' + statsMinuteText(shift.late_minutes) + '</span>' : '');
    for (const br of shift.breaks || []) {
      if (br.start_id) shown.add(String(br.start_id));if (br.end_id) shown.add(String(br.end_id));
      items.push({value:br.start_at,html:statsBreakPair(br,++breakNumber,shift,day,rawById)});
    }
    add('clock_out',shift.end_at,shift.end_id,{},!shift.closed ? 'Χωρίς έξοδο · ανοιχτή βάρδια' : (day.early_departure_minutes && String(shift.end_id) === String(day.final_departure_id) ? '<span class="attendance-negative">Πρόωρη έξοδος ' + statsMinuteText(day.early_departure_minutes) + '</span>' : ''));
    items.sort(function(a,b) { return (a.value ? Date.parse(a.value) : Infinity) - (b.value ? Date.parse(b.value) : Infinity); });
    return '<section class="attendance-detail-period"><div class="attendance-detail-period-heading"><h3>' + (index + 1) + 'η παρουσία</h3>' + (shift.closed && !isScheduledEvent(rawById.get(String(shift.end_id))) ? '<span class="mono">' + esc(formatMinutes(shift.gross_minutes)) + '</span>' : '') + '</div><ol class="attendance-timeline">' + items.map(function(item) { return item.html; }).join('') + '</ol></section>';
  }).join('');
  const extra = rawEvents.filter(function(e) { return !shown.has(String(e.id)) && !['void','rejected'].includes(e.status) && (e.admin_day || dateKey(e.event_at)) === day.date; });
  return '<aside id="attendance-day-detail" class="attendance-detail" aria-label="Λεπτομέρειες ημέρας" tabindex="-1"><div class="attendance-detail-heading"><div><h2>' + esc(statsFullDate(day.date).replace(' '+day.date.slice(0,4),'')) + '</h2><p class="attendance-day-person">' + esc(personName(state.statsId)) + '</p></div><button type="button" class="icon-button" data-action="stats-close-day" aria-label="Κλείσιμο ανάλυσης ημέρας">×</button></div>' +
    '<div class="attendance-day-recap' + (day.has_open_shift ? ' in-progress' : '') + '"><span aria-hidden="true">◷</span><strong>' + esc(formatMinutes(day.gross_minutes)) + ' παρουσίας · ' + esc(statsMinuteText(day.break_minutes)) + ' διαλείμματα</strong></div>' +
    '<div class="attendance-detail-status">' + statsDayStatus(day, preview, rawEvents) + '</div>' +
    (day.issues.length ? '<p class="attendance-issue" role="status">' + day.issues.map(function(issue) { return esc(issue.message || 'Χρειάζεται έλεγχος ακολουθίας.'); }).join('<br>') + '</p>' : '') +
    (periods || '<div class="attendance-day-empty"><span aria-hidden="true">◷</span><p>Δεν υπάρχουν παρουσίες.</p>' + (canEdit ? timeCell(null,null,state.statsId,{date:day.date,type:'clock_in'}) : '') + '</div>') +
    (extra.length ? '<section class="attendance-detail-extra"><h3>Πρόσθετες κινήσεις</h3><ol class="attendance-timeline">' + [...extra].sort(function(a,b) { return Date.parse(a.event_at)-Date.parse(b.event_at); }).map(function(e) { return statsTimelineEntry(e.type,e.event_at,e.id,day,{shift_ref:e.shift_ref,break_ref:e.break_ref},rawById,e.status === 'draft' ? '<span class="draft-line">Πρόχειρη: ' + esc(ACTIONS[e.type]) + ' · εκτός συνόλων</span>' : (e.status === 'pending' && state.statsMode === 'approved' ? 'Εκκρεμής · εκτός εγκεκριμένων συνόλων' : 'Χρειάζεται έλεγχο')); }).join('') + '</ol></section>' : '') +
    (canEdit ? '<div class="attendance-detail-actions">' + button('+ Προσθήκη κίνησης','admin-day',attrs,'attendance-add-movement') + '</div>' : '') +
    '<section class="attendance-day-note"><h3>Σημείωση ημέρας</h3>' + sharedBreakNoteHtml(day) + statsNoteCell(day, canEdit) + '</section></aside>';
}
function statsTableHeader() { return '<tr><th scope="col">Ημέρα</th><th scope="col">Παρουσίες</th><th scope="col">Διαλείμματα</th><th scope="col">Ώρες</th><th scope="col">Κατάσταση</th><th scope="col">Σημείωση</th></tr>'; }
function statsSummary(totals, pending, target = 480) {
  const deficitLabel = Number(target) === 480 ? 'Έλλειμμα 8ώρου' : 'Έλλειμμα στόχου';
  const metrics = [['presence','Ώρες παρουσίας',statsHours(totals.gross_minutes),0],['worked_days','Ημέρες παρουσίας',totals.worked_days || 0,0],['breaks','Διαλείμματα',formatMinutes(totals.break_minutes),0],['late_days','Ημέρες αργοπορίας',totals.late_days || 0,totals.late_days],[ 'shortfall',deficitLabel,formatMinutes(totals.shortfall_minutes),totals.shortfall_minutes],['break_excess','Υπέρβαση διαλειμμάτων',formatMinutes(totals.break_excess_minutes),totals.break_excess_minutes],['combined','Συνολική απόκλιση',formatMinutes(totals.combined_deviation_minutes),totals.combined_deviation_minutes]];
  return (pending ? '<div class="attendance-summary-label"><span class="badge amber">Προσωρινά σύνολα · περιλαμβάνονται διορθώσεις</span></div>' : '') +
    '<div class="attendance-summary" aria-label="Σύνολα και αποκλίσεις μήνα">' + metrics.map(function(metric) { return '<div class="attendance-summary-item" data-metric="' + metric[0] + '"><span>' + metric[1] + '</span><strong class="mono' + (metric[3] > 0 ? ' attendance-negative' : '') + '">' + metric[2] + '</strong></div>'; }).join('') + '</div>';
}
function renderStats() {
  const data = state.monthData, readOnly = isArchiveView('stats'), canEdit = isAdmin() && !readOnly;
  const options = {month:state.month,employee:data?.employee,notes:data?.notes || [],settings:data?.settings || state.context.settings,now:now(),includePending:state.statsMode === 'effective'};
  state.stats = data && state.statsId ? monthlyStats(data.events || [], options) : null;
  const stats = state.stats, projected = stats ? monthlyStats(data.events || [], {...options,includeScheduled:true}) : null;
  const sharedDays = data?.shared_breaks?.[state.statsMode] || {};
  for (const day of stats?.days || []) day.shared_break_colleagues = Array.isArray(sharedDays[day.date]) ? sharedDays[day.date].filter(function(person) { return person && typeof person.name === 'string' && String(person.id) !== String(state.statsId); }) : [];
  const previewDays = new Map((projected?.days || []).map(function(day) { return [day.date,day]; }));
  const rawEvents = data?.events || [], rawById = new Map(rawEvents.map(function(e) { return [String(e.id),e]; }));
  const due = readOnly ? [] : rawEvents.filter(isScheduledEvent).map(function(e) { return Date.parse(e.event_at); });
  if (!readOnly) for (const day of stats?.days || []) {
    const deadline = Date.parse(day.scheduled_end_at);
    if (day.shifts.length && !day.evaluation_complete && deadline > now().getTime()) due.push(deadline);
  }
  state.nextScheduledRefresh = due.length ? Math.min(...due) : 0;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(state.month) ? state.month : today().slice(0,7);
  const days = stats?.days || [], attention = days.filter(function(day) { return statsNeedsAttention(day,rawEvents); });
  const visibleDays = days.filter(function(day) { return state.statsFilter === 'attention' ? statsNeedsAttention(day,rawEvents) : state.statsFilter === 'present' ? statsHasPresence(day,previewDays.get(day.date) || day) : true; });
  if (stats && state.statsSelectionScope !== statsScope()) {
    state.statsSelectionScope = statsScope();
    state.statsSelectedDay = (visibleDays.find(function(day) { return statsHasPresence(day,previewDays.get(day.date) || day) || statsDayDrafts(day,rawEvents).length; }) || visibleDays.find(function(day) { return day.date === today(); }) || visibleDays[0])?.date || '';
  }
  if (state.statsSelectedDay && !visibleDays.some(function(day) { return day.date === state.statsSelectedDay; })) state.statsSelectedDay = visibleDays[0]?.date || '';
  const selectedDay = days.find(function(day) { return day.date === state.statsSelectedDay; });
  const person = data?.employee || employee(state.statsId), entryDate = selectedDay?.date || (today().startsWith(month) ? today() : month + '-01');
  return '<div class="attendance-workspace">' + statsPeoplePanel() + '<section class="attendance-report" aria-label="Μηνιαία παρουσία"><h1 class="attendance-page-title">Παρουσιολόγιο</h1><div class="attendance-report-heading"><div class="attendance-report-person">' + (person ? avatar(person) : '') + '<div><h2>' + esc(person?.name || 'Επίλεξε εργαζόμενο') + '</h2><p>' + esc(person?.department || 'Παρουσίες και διαλείμματα') + (person?.archived ? ' · Αρχειοθετημένος' : '') + '</p></div></div>' +
    '<div class="attendance-report-controls"><div class="attendance-period-bar"><button type="button" class="icon-button" data-action="stats-shift-month" data-offset="-1" aria-label="Προηγούμενος μήνας">‹</button>' +
    selectField('Μήνας','stats_month_number',STATS_MONTHS.map(function(name,index) { return option(String(index+1).padStart(2,'0'),name,month.slice(5)); }).join('')) +
    '<button type="button" class="icon-button" data-action="stats-shift-month" data-offset="1" aria-label="Επόμενος μήνας">›</button>' +
    selectField('Έτος','stats_year',statsYears().map(function(year) { return option(year,year,month.slice(0,4)); }).join('')) + '</div>' +
    (canEdit && person ? button('+ Καταγραφή','admin-day','data-employee="' + esc(state.statsId) + '" data-date="' + esc(entryDate) + '"','primary') : '') + '</div></div>' +
    '<details class="attendance-options"><summary>Επιλογές προβολής</summary><div class="attendance-options-fields">' + datasetField('stats') + selectField('Υπολογισμός','stats_mode',option('effective','Μαζί με τις εκκρεμείς διορθώσεις',state.statsMode) + option('approved','Μόνο εγκεκριμένες καταγραφές',state.statsMode)) + '</div></details>' +
    (readOnly ? archiveNotice() : '') +
    (stats?.has_pending && state.statsMode === 'effective' ? banner('Τα σύνολα περιλαμβάνουν εκκρεμείς διορθώσεις και παραμένουν προσωρινά μέχρι να ελεγχθούν.','warning') : '') +
    (projected?.has_scheduled ? banner('Οι ορισμένες μελλοντικές ώρες εμφανίζονται με μπλε ένδειξη. Θα ισχύσουν όταν φτάσει η ώρα τους και δεν προστίθενται πρόωρα στα σημερινά σύνολα.') : '') +
    (stats?.issues?.length ? banner('Υπάρχουν κινήσεις που χρειάζονται έλεγχο. Επίλεξε «Χρειάζονται έλεγχο» για να τις δεις.','warning') : '') +
    (rawEvents.some(function(e) { return e.source === 'history_cleanup'; }) ? '<p class="field-help">* Εκτιμώμενη παλιά ώρα που συμπληρώθηκε κατά την τακτοποίηση του ιστορικού.</p>' : '') +
    (stats ? statsSummary(stats.totals,stats.has_pending && state.statsMode === 'effective',options.settings?.shift_target_minutes ?? 480) + '<div class="attendance-table-toolbar"><div class="attendance-row-filters" role="group" aria-label="Φίλτρο ημερών">' + [['all','Όλες οι ημέρες',days.length],['present','Με παρουσία',days.filter(function(d) { return statsHasPresence(d,previewDays.get(d.date) || d); }).length],['attention','Χρειάζονται προσοχή',attention.length]].map(function(item) { return '<button type="button" data-action="stats-filter-days" data-filter="' + item[0] + '" aria-pressed="' + (state.statsFilter === item[0]) + '">' + item[1] + ' <span>' + item[2] + '</span></button>'; }).join('') + '</div>' + button('↓ Εξαγωγή','export-stats',stats ? '' : 'disabled','small') + '</div>' +
    (visibleDays.length ? '<div class="table-wrap attendance-table-wrap" tabindex="0" aria-label="Μηνιαίο παρουσιολόγιο"><table class="attendance-table"><thead>' + statsTableHeader() + '</thead><tbody>' + visibleDays.map(function(day) { return statsDayRow(day,previewDays.get(day.date) || day,rawEvents); }).join('') + '</tbody><tfoot>' + statsTableHeader() + '<tr class="attendance-month-totals"><th scope="row">Σύνολα μήνα</th><td>' + stats.totals.worked_days + ' ημέρες</td><td class="mono">' + esc(formatMinutes(stats.totals.break_minutes)) + '</td><td class="mono">' + esc(formatMinutes(stats.totals.gross_minutes)) + '</td><td><small>Συνολική απόκλιση</small><strong class="mono' + (stats.totals.combined_deviation_minutes ? ' attendance-negative' : '') + '">' + esc(formatMinutes(stats.totals.combined_deviation_minutes)) + '</strong></td><td></td></tr></tfoot></table></div><p class="attendance-table-hint">Επίλεξε μια ημέρα για όλες τις καταγραφές και τις σημειώσεις της.</p>' : empty('Δεν υπάρχουν ημέρες με αυτό το φίλτρο','Επίλεξε «Όλες» για να δεις ολόκληρο τον μήνα.')) : empty('Επίλεξε μήνα και εργαζόμενο','Τα σύνολα και οι καθημερινές καταγραφές θα εμφανιστούν εδώ.')) +
    '</section>' + statsDayPanel(selectedDay,previewDays.get(selectedDay?.date) || selectedDay,rawEvents,rawById,canEdit) + '</div><p class="footer-note">Ημερολογιακή κατανομή σε ώρα Ελλάδας · οι νυχτερινές παρουσίες συνδέονται μεταξύ ημερών. Η διαφορά από τον στόχο δεν αποτελεί υπολογισμό νόμιμης υπερωρίας.</p>';
}
function renderEmployees() {
  const rows = visibleEmployees(state.showArchived);
  return heading('Προσωπικό', 'Η ομάδα, τα τμήματα και οι ατομικές ρυθμίσεις ωραρίου.', isAdmin() ? button('Τμήματα', 'manage-departments') + button('Προσθήκη εργαζομένου', 'edit-employee', '', 'primary') : '') +
    '<section class="card employees-card"><div class="card-heading"><h2>' + rows.length + ' εργαζόμενοι</h2><label class="check-label"><input id="show-archived" type="checkbox"' + (state.showArchived ? ' checked' : '') + '>Εμφάνιση αρχείου</label></div>' +
    (rows.length ? '<div class="table-wrap"><table><thead><tr><th>Εργαζόμενος</th><th>Τμήμα</th><th>Προσέλευση</th><th>Αποχώρηση</th><th>Κατάσταση</th><th></th></tr></thead><tbody>' +
      rows.map(function(e) {
        return '<tr><td><div class="employee-table-name">' + avatar(e) + '<strong>' + esc(e.name) + '</strong></div></td><td>' + esc(e.department || '—') + '</td><td class="mono">' + esc(e.shift1_start ? clockText(e.shift1_start) : '—') + (e.shift2_start ? ' / ' + esc(clockText(e.shift2_start)) : '') + '<small class="break-line">Ανοχή ' + esc(e.lateness_tolerance_minutes || 0) + ' λεπτά</small></td><td class="mono">' + esc(e.shift_end ? clockText(e.shift_end) : '—') + '</td><td>' + (e.archived ? '<span class="badge">Αρχείο</span>' : '<span class="badge green">Ενεργός</span>') + '</td><td><div class="actions">' +
          (isAdmin() ? button('Επεξεργασία', 'edit-employee', 'data-id="' + esc(e.id) + '"', 'small') + button(e.archived ? 'Επαναφορά' : 'Αρχειοθέτηση', 'archive-employee', 'data-id="' + esc(e.id) + '" data-archived="' + !e.archived + '" data-mutate', 'small') + (e.archived ? button('Διαγραφή','delete-employee','data-id="' + esc(e.id) + '"','small danger') : '') : button('Ιστορικό', 'person-history', 'data-id="' + esc(e.id) + '"', 'small')) + '</div></td></tr>';
      }).join('') + '</tbody></table></div>' : empty('Δεν υπάρχει προσωπικό', 'Πρόσθεσε τους εργαζομένους για να ξεκινήσουν οι καταγραφές.')) + '</section>';
}
function renderSettings() {
  const settings = state.adminData?.settings || state.context.settings;
  const members = state.adminData?.members || [];
  const emailMembers = members.filter(function(m) { return m.login_kind !== 'device'; });
  const devices = members.filter(function(m) { return m.login_kind === 'device'; });
  return heading('Ρυθμίσεις', 'Κοινοί κανόνες παρουσίας και πρόσβαση στην εφαρμογή.') +
    '<div class="settings-columns"><section class="card"><div class="card-heading"><h2>Χρόνος εργασίας</h2></div><form id="settings-form"><div class="form-grid">' +
    field('Ημερήσιο όριο διαλείμματος · λεπτά', 'break_limit_minutes', settings.break_limit_minutes, 'number', 'min="0" max="1440" required') +
    field('Ημερήσιος στόχος παρουσίας · ώρες', 'shift_target_hours', Number(settings.shift_target_minutes ?? 480) / 60, 'number', 'min="0.25" max="24" step="0.25" required') +
    field('Αδράνεια διαχείρισης · λεπτά', 'idle_timeout_minutes', settings.idle_timeout_minutes || 10, 'number', 'min="1" max="240" required') +
    '<div class="full">' + banner('Τα διαλείμματα περιλαμβάνονται στις ώρες παρουσίας. Το όριο διαλείμματος αφορά το ημερήσιο σύνολο. Οι ώρες εμφανίζονται πάντα σε ώρα Ελλάδας.') + '</div></div><button class="button primary" type="submit" data-submit>Αποθήκευση ρυθμίσεων</button><div class="form-error" role="alert"></div></form></section>' +
    '<div class="settings-account-stack"><section class="card"><div class="card-heading"><h2>Λογαριασμοί με email</h2>' + button('Προσθήκη', 'edit-member', '', 'small primary') + '</div><p class="muted">Προσωπικοί λογαριασμοί διαχείρισης και προβολής αναφορών.</p>' +
    (emailMembers.length ? '<div class="table-wrap"><table><thead><tr><th>Λογαριασμός</th><th>Ρόλος</th><th></th></tr></thead><tbody>' + emailMembers.map(function(m) {
      const protectedOwner = m.is_owner && !state.context.is_owner;
      return '<tr><td class="wrap"><strong>' + esc(m.display_name || m.email) + '</strong><small class="shift-line">' + esc(m.email) + '</small>' + (m.is_owner ? '<span class="badge blue owner-badge">Ιδιοκτήτης</span>' : '') + (m.disabled ? '<span class="badge">Ανενεργός</span>' : '') + '</td><td>' + esc(ROLES[m.role] || m.role) + '</td><td>' + button('Αλλαγή', 'edit-member', 'data-email="' + esc(m.email) + '"' + (protectedOwner ? ' disabled title="Ο λογαριασμός ιδιοκτήτη δεν αλλάζει από άλλον διαχειριστή."' : ''), 'small') + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="muted">Δεν υπάρχουν άλλοι λογαριασμοί.</p>') +
    '<p class="field-help">Η προσθήκη επιτρέπει την πρόσβαση. Ο χρήστης δημιουργεί τον δικό του λογαριασμό με το ίδιο email και επιβεβαιώνει τη διεύθυνσή του. Κάθε διαχειριστής έχει πλήρη διαχείριση, ενώ ο λογαριασμός ιδιοκτήτη προστατεύεται.</p></section>' +
    '<section class="card"><div class="card-heading"><h2>Υπολογιστές καταγραφής</h2>' + button('Νέος υπολογιστής', 'edit-device', '', 'small primary') + '</div><p class="muted">Ένας λογαριασμός για κάθε κοινό υπολογιστή ή tablet. Οι εργαζόμενοι δεν χρειάζονται email.</p>' +
    (devices.length ? '<div class="table-wrap"><table><thead><tr><th>Υπολογιστής</th><th>Πρόσβαση</th><th></th></tr></thead><tbody>' + devices.map(function(m) {
      return '<tr><td class="wrap"><strong>' + esc(m.display_name || m.username) + '</strong><small class="shift-line">' + esc(m.username) + '</small></td><td><span class="badge ' + (m.disabled ? '' : 'green') + '">' + (m.disabled ? 'Ανενεργός' : 'Ενεργός') + '</span></td><td>' + button('Αλλαγή', 'edit-device', 'data-id="' + esc(m.id) + '"', 'small') + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="muted">Πρόσθεσε υπολογιστή για να συνδέεσαι με όνομα χρήστη και κωδικό.</p>') +
    '<p class="field-help">Πρόσβαση μόνο στις καταγραφές και στα αιτήματα διόρθωσης. Κάθε νέος browser χρειάζεται έγκριση ιδιοκτήτη πριν ανοίξει η καταγραφή. Η συνεδρία δεν λήγει λόγω αδράνειας. Μπορείς να αλλάξεις τον κωδικό ή να απενεργοποιήσεις την πρόσβαση εδώ.</p></section>' + renderBrowserSettings() + '</div></div>';
}
function renderBrowserSettings() {
  if (!isOwner()) return '';
  const data = state.browserData; const devices = data?.devices || [];
  const mailConfigured = data?.mail_configured ?? data?.notification_configured;
  return '<section class="card browser-settings"><div class="card-heading"><h2>Εγκρίσεις browser</h2>' + button('Ανανέωση', 'browser-list-refresh', '', 'small') + '</div><p class="muted">Η έγκριση δίνει πρόσβαση μόνο στον συγκεκριμένο browser και στο προφίλ του, για τον αντίστοιχο υπολογιστή καταγραφής.</p>' +
    (mailConfigured === false ? banner('Η αποστολή email δεν έχει ρυθμιστεί. Ο διαχειριστής βλέπει το αίτημα στις Ρυθμίσεις.', 'warning') : '') +
    (data?.error ? banner(esc(data.error), 'error') : '') +
    (devices.length ? '<div class="table-wrap"><table><thead><tr><th>Υπολογιστής / browser</th><th>Κατάσταση</th><th></th></tr></thead><tbody>' + devices.map(function(device) {
      const id = device.device_id || device.id; const pending = device.status === 'pending'; const approved = device.status === 'approved';
      return '<tr><td class="wrap"><strong>' + esc(device.display_name || device.username || 'Υπολογιστής καταγραφής') + '</strong><small class="shift-line">' + esc(device.username || '') + '</small><span class="shift-line">' + esc(device.label || 'Browser καταγραφής') + '</span>' +
        (device.pending_request_id ? '<small class="shift-line">Κωδικός αιτήματος: <strong class="mono">' + esc(String(device.pending_request_id).slice(0,8).toUpperCase()) + '</strong></small>' : '') +
        '<small class="shift-line">Αίτημα: ' + esc(device.created_at ? displayDate(device.created_at) + ' ' + displayTime(device.created_at) : '—') + '</small>' +
        (device.last_seen_at ? '<small class="shift-line">Τελευταία σύνδεση: ' + esc(displayDate(device.last_seen_at) + ' ' + displayTime(device.last_seen_at)) + '</small>' : '') + '</td>' +
        '<td><span class="badge ' + (pending ? 'amber' : (approved ? 'green' : 'red')) + '">' + (pending ? 'Σε αναμονή' : (approved ? 'Εγκεκριμένος' : 'Ανακληθείς')) + '</span></td><td><div class="browser-row-actions">' +
        (pending && device.pending_request_id ? button('Έγκριση', 'browser-approve', 'data-request="' + esc(device.pending_request_id) + '"', 'small primary') : '') +
        (id && (pending || approved) ? button(pending ? 'Απόρριψη' : 'Ανάκληση', 'browser-revoke', 'data-id="' + esc(id) + '"', 'small danger') : '') + '</div></td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="muted">' + (data ? 'Δεν υπάρχουν αιτήματα browser.' : 'Φόρτωσε τις εγκρίσεις browser με την ανανέωση.') + '</p>') + '</section>';
}
async function refreshBrowserList() {
  if (!isOwner()) return;
  const token = state.sessionLoadToken;
  try {
    const data = await api.listBrowsers();
    if (!isOwner() || token !== state.sessionLoadToken) return;
    state.browserData = data; setServerTime(data.server_now);
  } catch (error) {
    if (!isOwner() || token !== state.sessionLoadToken) return;
    state.browserData = { devices: [], error: error.message || 'Δεν φορτώθηκαν οι εγκρίσεις browser.' };
  }
  if (state.view === 'settings') renderCurrentView();
}
function openBrowserDecision(action, id) {
  if (!isOwner()) { toast('Η έγκριση browser γίνεται μόνο από τον ιδιοκτήτη.', 'error'); return; }
  const browser = state.browserData?.devices?.find(function(device) { return action === 'approve' ? device.pending_request_id === id : String(device.device_id || device.id) === String(id); });
  if (!browser || (action === 'approve' && browser.status !== 'pending') || (action === 'revoke' && !['pending', 'approved'].includes(browser.status))) { toast('Το αίτημα δεν εκκρεμεί πλέον. Ανανέωσε τις εγκρίσεις browser.', 'error'); return; }
  state.modalBrowser = { action, request_id: browser.pending_request_id, device_id: browser.device_id || browser.id };
  openModal(action === 'approve' ? 'Έγκριση browser' : 'Ανάκληση πρόσβασης browser', browser.display_name || browser.username || 'Υπολογιστής καταγραφής',
    '<p>Browser: <strong>' + esc(browser.label || 'Browser καταγραφής') + '</strong></p>' +
    '<p>Λογαριασμός: <strong>' + esc(browser.username || browser.display_name || '') + '</strong></p>' +
    (browser.pending_request_id ? '<p>Κωδικός αιτήματος: <strong class="mono">' + esc(String(browser.pending_request_id).slice(0,8).toUpperCase()) + '</strong></p>' : '') +
    (browser.created_at ? '<p>Αίτημα: ' + esc(displayDate(browser.created_at) + ' ' + displayTime(browser.created_at)) + '</p>' : '') +
    '<p>' + (action === 'approve' ? 'Επιβεβαίωσε μόνο αν αναγνωρίζεις τον υπολογιστή. Η πρόσβαση καταγραφής ενεργοποιείται για αυτόν τον browser.' : 'Οι καταγραφές θα σταματήσουν από αυτόν τον browser. Οι αποθηκευμένες παρουσίες παραμένουν διαθέσιμες.') + '</p>',
    submitButton(action === 'approve' ? 'Επιβεβαίωση έγκρισης' : 'Επιβεβαίωση ανάκλησης'), 'browser-decision');
}
async function reviewBrowserLink(force = false) {
  const request = state.pendingBrowserRequest;
  if (!request || !isOwner() || (!force && state.openedBrowserRequest === request)) return;
  if (!state.browserData || state.browserData.error) await refreshBrowserList();
  if (!isOwner() || state.pendingBrowserRequest !== request) return;
  state.openedBrowserRequest = request;
  const browser = state.browserData?.devices?.find(function(device) { return device.pending_request_id === request && device.status === 'pending'; });
  if (browser) openBrowserDecision('approve', request);
  else {
    toast(state.browserData?.error || 'Το αίτημα δεν εκκρεμεί πλέον ή δεν είναι διαθέσιμο. Έλεγξε τη λίστα εγκρίσεων browser.', 'error');
    if (!state.browserData?.error) {
      clearBrowserRequest();
      const notice = document.getElementById('browser-link-notice'); if (notice && state.context) notice.innerHTML = browserLinkNotice();
    }
  }
}
async function saveBrowserDecision() {
  if (!isOwner() || !state.modalBrowser) throw new Error('Η έγκριση browser γίνεται μόνο από τον ιδιοκτήτη.');
  const decision = state.modalBrowser; const token = state.sessionLoadToken;
  const payload = decision.action === 'approve' ? { action: 'approve', request_id: decision.request_id } : { action: 'revoke', device_id: decision.device_id };
  setBusy(true);
  try {
    await api.manageBrowser(payload);
    if (token !== state.sessionLoadToken || !isOwner()) return;
    if (decision.request_id === state.pendingBrowserRequest) clearBrowserRequest();
    setBusy(false); closeModal(); toast(decision.action === 'approve' ? 'Ο browser εγκρίθηκε.' : 'Η πρόσβαση του browser ανακλήθηκε.', 'success');
    await refreshBrowserList();
    const notice = document.getElementById('browser-link-notice'); if (notice && state.context) notice.innerHTML = browserLinkNotice();
  } catch (error) {
    setBusy(false);
    if (!error.uncertain) throw error;
    closeModal(); await refreshBrowserList();
    toast('Δεν επιβεβαιώθηκε η αλλαγή. Έλεγξε τη λίστα εγκρίσεων πριν προσπαθήσεις ξανά.', 'error');
  } finally { setBusy(false); }
}
function renderAudit() {
  const labels = { record: 'Καταγραφή', correction: 'Αίτημα διόρθωσης', review: 'Έλεγχος διόρθωσης', event_edit: 'Αλλαγή ώρας', event_void: 'Ακύρωση κινήσεων', history_cleanup: 'Τακτοποίηση παλιού ιστορικού', employee_save: 'Αλλαγή προσωπικού', employee_archive: 'Αρχειοθέτηση / επαναφορά', employee_delete: 'Διαγραφή από την εφαρμογή', settings_save: 'Αλλαγή ρυθμίσεων', note_save: 'Σημείωση ημέρας', note_delete: 'Αφαίρεση σημείωσης', department_add: 'Προσθήκη τμήματος', department_delete: 'Αφαίρεση τμήματος', member_save: 'Αλλαγή πρόσβασης' };
  return heading('Ιστορικό αλλαγών', 'Οι καταγραφές διαχείρισης διατηρούνται για να είναι οι αλλαγές ελέγξιμες.') +
    '<section class="card">' + (state.audit.length ? '<div class="table-wrap"><table><thead><tr><th>Χρόνος</th><th>Λογαριασμός</th><th>Ενέργεια</th><th>Πληροφορίες</th></tr></thead><tbody>' +
      state.audit.map(function(row) {
        const p = row.payload || row.details || row.after_data || row.before_data || {};
        return '<tr><td class="mono">' + esc(displayDate(row.created_at)) + '<br>' + esc(displayTime(row.created_at, true)) + '</td><td class="wrap">' + esc(row.actor_email || row.email || '—') + '</td><td>' + esc(labels[row.action] || row.action) + '</td><td class="wrap">' +
          esc(row.reason || p.reason || (row.employee_id ? personName(row.employee_id) : '') || (p.employee_id ? personName(p.employee_id) : '') || p.name || p.email || '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : empty('Δεν υπάρχουν αλλαγές ακόμη', 'Οι μελλοντικές ενέργειες θα εμφανίζονται εδώ.')) +
    (state.auditCursor ? '<div class="table-footer">' + button('Παλαιότερες αλλαγές', 'more-audit') + '</div>' : '') + '</section>';
}
async function selectEmployee(id, navigateFirst = false) {
  if (isOperator()) {
    const e = employee(id);
    if (!e || e.archived || state.busy) return;
    if (state.pendingCommand) { toast('Έλεγξε πρώτα την τελευταία αποθήκευση από το μήνυμα στην κορυφή.', 'error'); return; }
    const token = ++state.personToken; const session = state.sessionLoadToken;
    state.selectedId = id; state.employeeData = null;
    openModal(e.name, '', loading(), '', 'kiosk-actions');
    try {
      const data = await api.read('employee', { employee_id: id });
      if (token !== state.personToken || session !== state.sessionLoadToken || state.selectedId !== id || !isOperator() || !modal.open) return;
      if (String(data.employee?.id) !== String(id)) throw new Error('Δεν φορτώθηκε ο εργαζόμενος. Δοκίμασε ξανά.');
      state.employeeData = data; setServerTime(data.server_now);
      openModal(e.name, '', kioskActions(id), '', 'kiosk-actions');
    } catch (error) {
      if (token !== state.personToken || session !== state.sessionLoadToken || state.selectedId !== id || !isOperator()) return;
      if (handleBrowserGate(error)) return;
      openModal(e.name, '', banner(esc(error.message || 'Δεν ήταν δυνατή η φόρτωση.'), 'error'), button('Δοκιμή ξανά', 'select-employee', 'data-id="' + esc(id) + '"'), 'kiosk-actions');
    }
    return;
  }
  const token = ++state.personToken;
  state.selectedId = id; state.employeeData = null;
  if (navigateFirst) await navigate('record'); else {
    const panel = document.getElementById('employee-panel'); if (panel) panel.innerHTML = loading();
    document.querySelectorAll('.employee-card').forEach(function(el) { el.classList.toggle('selected', el.dataset.id === id); el.setAttribute('aria-pressed', String(el.dataset.id === id)); });
    try {
      const data = await api.read('employee', { employee_id: id });
      if (state.selectedId !== id || token !== state.personToken || !state.context) return;
      state.employeeData = data; setServerTime(data.server_now);
      if (panel) { panel.innerHTML = renderSelectedPerson(); colorAvatars(); tick(); }
    } catch (error) { if (token !== state.personToken || handleBrowserGate(error)) return; if (panel) panel.innerHTML = banner(esc(error.message), 'error'); }
  }
}
function correctionSuggestionForState(current, requestedAction = null, details = {}) {
  current = stateOf(current);
  const issue = current.issues?.[0] || details.issues?.[0] || null;
  let plan;
  if (requestedAction) {
    try { plan = planNext(current, requestedAction, { now: now() }); } catch {}
  }
  let actions = issue ? issue.expected_actions : (details.expected_actions || plan?.expected_actions || []);
  if (!Array.isArray(actions)) actions = [];
  const at = issue ? (issue.repair_after_at || issue.open_break_at || issue.open_shift_at || issue.event_at) : (current.open_break_at || current.open_shift_at);
  return { actions: actions.filter(function(a) { return ACTIONS[a]; }), date: issue?.suggested_date || plan?.suggested_date || (at ? dateKey(at) : today()), current, issue, requestedAction };
}
function suggestionFrom(error, fallbackState, type) {
  const details = error?.details || {};
  const current = details.state && typeof details.state === 'object' ? details.state : fallbackState;
  return correctionSuggestionForState(current, type, details);
}
function shortCorrectionDate(day) {
  const parts = String(day || '').split('-');
  return parts.length === 3 ? Number(parts[2]) + '/' + Number(parts[1]) + '/' + parts[0].slice(-2) : dateDisplay(day);
}
function guidedCorrectionEntryHtml(action, date) {
  const timeLabels = {clock_in: 'εισόδου', clock_out: 'εξόδου', break_start: 'έναρξης διαλείμματος', break_end: 'επιστροφής από το διάλειμμα'};
  const labels = {clock_in: 'η Είσοδος', clock_out: 'η Έξοδος', break_start: 'η Έναρξη διαλείμματος', break_end: 'η Επιστροφή από το διάλειμμα'};
  return '<section class="correction-entry" data-entry="0"><p class="strong">' + esc(personName(state.modalEmployeeId)) + ', στις <span id="correction-date-label">' + esc(shortCorrectionDate(date)) + '</span> λείπει ' + esc(labels[action] || ACTIONS[action]) + '. Βάλε τη σωστή ώρα <strong class="attendance-negative">' + esc(timeLabels[action] || ACTIONS[action]) + '</strong> και πάτα «Αποστολή στον admin».</p>' +
    '<input type="hidden" name="entry_0_type" value="' + esc(action) + '">' + fixedDateTimeFields(date, 'entry_0') + '<p id="correction-date-notice" class="field-help" role="status"></p></section>';
}
function manualOperatorCorrectionHtml(date) {
  return '<section class="correction-entry" data-entry="0"><div class="correction-grid">' + selectField('Ενέργεια', 'entry_0_type', option('', 'Επίλεξε ενέργεια', '') + actionOptions(''), 'required') + dateTimeFields(null, 'entry_0', {emptyTime: true, date}) + '</div></section>';
}
function correctionCompletionMessage(type) {
  const done = {clock_in:'έγινε είσοδος',clock_out:'έγινε έξοδος',break_start:'έγινε έναρξη διαλείμματος',break_end:'έγινε επιστροφή από διάλειμμα'};
  return 'Οι διορθώσεις καταχωρήθηκαν και ' + done[type] + '.';
}
async function recordAction(type, {afterCorrection = false} = {}) {
  if (!canRecord() || !state.selectedId) return;
  const id = state.selectedId, session = state.sessionLoadToken, person = state.personToken;
  const completionMessage = afterCorrection ? correctionCompletionMessage(type) : null;
  try {
    const response = await command('record', { employee_id: id, type }, false, completionMessage);
    const result = response?.result || response || {};
    if (session !== state.sessionLoadToken || String(state.selectedId) !== String(id)) return;
    if (isOperator()) closeModal();
    if (result.already_recorded) toast((afterCorrection ? 'Οι διορθώσεις καταχωρήθηκαν. ' : '') + (result.message || (ACTIONS[type] + ' έχει ήδη οριστεί' + (result.event?.event_at ? ' στις ' + displayTime(result.event.event_at) : '') + '.')), 'success');
    else toast(completionMessage || result.message || (ACTIONS[type] + ' καταγράφηκε.'), 'success');
    await loadView('record', true);
  } catch (error) {
    if (session !== state.sessionLoadToken || person !== state.personToken || String(state.selectedId) !== String(id)) return;
    if (await recoverDatasetChanged(error)) return;
    if (state.browserGate || handleBrowserGate(error)) return;
    if (error.uncertain) { if (isOperator()) closeModal(); toast((afterCorrection ? 'Οι διορθώσεις καταχωρήθηκαν. ' : '') + 'Η αποθήκευση της ενέργειας δεν έχει επιβεβαιωθεί. Χρησιμοποίησε τον έλεγχο στην κορυφή.', 'error'); return; }
    const code = error.details?.code || error.code;
    if (['FLOW_INCOMPLETE', 'INVALID_SEQUENCE'].includes(code)) {
      // A rejected punch may appear in the error's trial replay, but was never
      // stored. Only persisted employee issues can be sent as gap guidance.
      let data;
      setBusy(true);
      try { data = await api.read('employee', {employee_id:id}); }
      catch (readError) { if (!handleBrowserGate(readError)) modalError(readError); return; }
      finally { setBusy(false); }
      if (session !== state.sessionLoadToken || person !== state.personToken || String(state.selectedId) !== String(id)) return;
      if (String(data.employee?.id) !== String(id)) { modalError(new Error('Δεν φορτώθηκε ο εργαζόμενος. Δοκίμασε ξανά.')); return; }
      state.employeeData = data; setServerTime(data.server_now);
      const suggestion = correctionSuggestionForState(stateOf(data), type);
      if (suggestion.actions.length || suggestion.issue) {
        openCorrection(id, suggestion);
        const persisted = stateOf(data);
        const attempt = {type, event_at: new Date(now()).toISOString()};
        const issues = persisted.issues?.length ? persisted.issues : [{
          type, event_at: attempt.event_at, state_before: persisted.state,
          expected_actions: suggestion.actions, open_shift_at: persisted.open_shift_at,
          open_break_at: persisted.open_break_at,
          repair_after_at: persisted.open_break_at || persisted.open_shift_at || null,
          repair_before_at: attempt.event_at
        }];
        const details = {state: {...persisted, issues}};
        modalError(describeFlowFailure(error, [attempt], details), 'correction');
        return;
      }
      modalError(new Error('Η κατάσταση άλλαξε. Επίλεξε ξανά την ενέργεια που θέλεις.')); return;
    }
    if (afterCorrection) {
      openModal('Η ενέργεια δεν καταγράφηκε', personName(id), banner(esc('Οι διορθώσεις καταχωρήθηκαν, αλλά η ενέργεια δεν καταγράφηκε. ' + error.message), 'error'), button('Δοκιμή ξανά', 'record-action', 'data-type="' + esc(type) + '" data-mutate', 'primary'), 'record-retry');
      return;
    }
    modalError(error);
  }
}
function correctionEntryHtml(index, action = 'clock_in', iso = null, date = today()) {
  return '<section class="correction-entry" data-entry="' + index + '"><div class="correction-entry-title"><span>Κίνηση ' + (index + 1) + '</span><button type="button" class="button text small" data-action="remove-correction-entry" data-entry="' + index + '">Αφαίρεση</button></div><div class="correction-grid">' +
    selectField('Ενέργεια', 'entry_' + index + '_type', actionOptions(action)) + dateTimeFields(iso, 'entry_' + index, {emptyTime: !iso, date}) + '</div></section>';
}
function openCorrection(id, suggestion = null) {
  if (!canRecord() || isArchiveView() || !id) return;
  if (suggestion?.issue && !suggestion.actions?.length) {
    openModal('Χρειάζεται έλεγχος ιστορικού', personName(id), banner(esc(suggestion.issue.message || 'Η υπάρχουσα καταγραφή χρειάζεται έλεγχο πριν προστεθεί άλλη ενέργεια.'), 'warning'), '');
    return;
  }
  const guided = isOperator() && Boolean(suggestion?.actions?.length);
  const actions = suggestion?.actions?.length ? (guided ? suggestion.actions.slice(0, 1) : suggestion.actions) : (isOperator() ? [''] : ['clock_in']);
  const defaultDate = suggestion?.date || today();
  state.modalEmployeeId = id; state.correctionEntryCount = actions.length;
  const body = (suggestion?.notice ? banner(esc(suggestion.notice), 'success') : '') +
    '<div id="correction-gap-info"></div>' +
    (isOperator() ? '' : banner('Καταχώρησε την πραγματική ώρα κάθε ελλείπουσας κίνησης. Η συνέχεια επιτρέπεται μόλις καλυφθούν όλες οι ελλείψεις.', '')) +
    '<div id="correction-entries">' + (guided ? guidedCorrectionEntryHtml(actions[0], defaultDate) : (isOperator() ? manualOperatorCorrectionHtml(defaultDate) : actions.map(function(action, index) { return correctionEntryHtml(index, action, null, defaultDate); }).join(''))) + '</div>' +
    (isOperator() ? '' : button('+ Προσθήκη κίνησης', 'add-correction-entry', '', 'text')) +
    '<div class="field"><label for="f-reason">Σύντομη αιτιολογία (προαιρετική)</label><textarea id="f-reason" name="reason" maxlength="1000" placeholder="Π.χ. ξέχασα να καταγράψω την επιστροφή από το διάλειμμα και την έξοδο."></textarea></div>';
  openModal(isOperator() ? '📝 Νέο Αίτημα Διόρθωσης' : 'Αίτημα διόρθωσης', personName(id), body, submitButton(isOperator() ? 'ΑΠΟΣΤΟΛΗ ΠΡΟΣ ADMIN' : 'Υποβολή διορθώσεων'), 'correction');
  state.correctionGuidance = suggestion ? {...suggestion, guided} : null;
}
function correctionIssueKey(suggestion) {
  const issue = suggestion?.issue;
  return issue ? JSON.stringify([issue.event_id, issue.type, issue.event_at, issue.expected_actions, issue.repair_after_at, issue.repair_before_at]) : '';
}
function updateGuidedCorrectionDate(form) {
  const guidance = state.correctionGuidance;
  if (!guidance?.guided || !form?.elements) return {};
  const timeField = form.elements.entry_0_time;
  const dateField = form.elements.entry_0_date;
  if (!timeField?.value || !dateField) return {};
  let time;
  try { time = normalizeTime(timeField.value); } catch { return {}; }
  // A duplicate in the raw history does not define the employee's real exit.
  // Keep the identified shift day; only infer midnight crossing from its
  // recorded opening, never from a later contradictory punch.
  let date = guidance.date || dateField.value;
  const action = guidance.actions?.[0];
  const anchor = action === 'break_end' ? (guidance.issue?.open_break_at || guidance.current?.open_break_at) :
    (action === 'clock_out' ? (guidance.issue?.open_shift_at || guidance.current?.open_shift_at) : null);
  if (anchor && dateKey(anchor) === date && time < dateTimeValues(anchor).time.slice(0, 5)) {
    const next = new Date(date + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 1); date = next.toISOString().slice(0, 10);
  }
  dateField.value = date;
  const label = document.getElementById('correction-date-label'); if (label) label.textContent = shortCorrectionDate(date);
  const notice = document.getElementById('correction-date-notice'); if (notice) notice.textContent = date === guidance.date ? '' : 'Η ώρα αντιστοιχεί στις ' + shortCorrectionDate(date) + ' για αυτή τη νυχτερινή βάρδια.';
  updateDstChoices(form);
  return {date};
}
function cacheCorrectionState(id, current, events = [], data = null) {
  const previous = data || (String(state.employeeData?.employee?.id) === String(id) ? state.employeeData : null) || {employee: employee(id), events: []};
  const combined = (previous.events || []).concat(events || []);
  const seen = new Set();
  const saved = combined.filter(function(event) { if (event.id && seen.has(event.id)) return false; if (event.id) seen.add(event.id); return true; });
  const fresh = {...previous, events: saved, state: current, effective_state: current};
  if (isOperator() || String(state.selectedId) === String(id)) { state.selectedId = id; state.employeeData = fresh; }
  if (String(state.historyId) === String(id) && state.historyData) state.historyData = {...state.historyData, state: current, effective_state: current};
  return fresh;
}
async function completeCorrection(id, response, guidance, token, session) {
  if (session !== state.sessionLoadToken || token !== state.correctionToken || !state.context || !modal.open) return;
  const result = response?.result || response || {};
  let data = null;
  let current = result.state ? stateOf(result.state) : null;
  if (!current) {
    try { data = await api.read('employee', {employee_id: id}); current = stateOf(data); }
    catch (error) {
      if (session !== state.sessionLoadToken || token !== state.correctionToken) return;
      if (handleBrowserGate(error)) return;
      closeModal(); toast('Η διόρθωση καταχωρήθηκε. Η νέα κατάσταση δεν φορτώθηκε· επίλεξε ξανά το όνομά σου.', 'success'); return;
    }
  }
  if (session !== state.sessionLoadToken || token !== state.correctionToken || !state.context || !modal.open) return;
  cacheCorrectionState(id, current, result.events, data);
  const next = correctionSuggestionForState(current, guidance?.requestedAction || null);
  if (next.issue || next.actions.length) {
    next.notice = 'Οι διορθώσεις καταχωρήθηκαν και υπολογίζονται ήδη. Συνέχισε με την επόμενη εκκρεμότητα.';
    openCorrection(id, next);
    return;
  }
  if (guidance?.requestedAction && String(state.selectedId) === String(id)) {
    await recordAction(guidance.requestedAction, {afterCorrection:true}); return;
  }
  closeModal(); toast('Οι διορθώσεις καταχωρήθηκαν και υπολογίζονται ήδη. Μπορείς να συνεχίσεις.', 'success');
  await refreshApp();
}
async function refreshDuplicateCorrection(id, guidance, token, session, code = 'DUPLICATE_EVENT') {
  const duplicate = code === 'DUPLICATE_EVENT';
  setBusy(true);
  let data;
  try { data = await api.read('employee', {employee_id: id}); }
  catch (error) {
    if (session !== state.sessionLoadToken || token !== state.correctionToken) return;
    setBusy(false);
    if (!handleBrowserGate(error)) modalError(new Error((duplicate ? 'Η κίνηση υπάρχει ήδη' : 'Οι εκκρεμότητες άλλαξαν') + ', αλλά η νέα κατάσταση δεν φορτώθηκε. Δοκίμασε ξανά όταν επανέλθει η σύνδεση.'));
    return;
  } finally { setBusy(false); }
  if (session !== state.sessionLoadToken || token !== state.correctionToken || !state.context || !modal.open) return;
  const current = stateOf(data);
  cacheCorrectionState(id, current, [], data);
  const next = correctionSuggestionForState(current, guidance?.requestedAction || null);
  if (next.issue && correctionIssueKey(next) === correctionIssueKey(guidance)) {
    state.correctionGuidance = {...next, guided: guidance?.guided === true};
    modalError(new Error((duplicate ? 'Αυτή η ώρα υπάρχει ήδη και υπολογίζεται στη ροή.' : 'Οι εκκρεμότητες ενημερώθηκαν.') + ' Η παρακάτω εκκρεμότητα παραμένει. Συμπλήρωσε την πραγματική ώρα.'));
    return;
  }
  if (next.issue || next.actions.length) {
    next.notice = duplicate ? 'Η κίνηση υπάρχει ήδη και υπολογίζεται στη ροή. Εμφανίζεται η επόμενη εκκρεμότητα.' : 'Οι εκκρεμότητες ενημερώθηκαν από άλλη καταχώρηση. Εμφανίζεται η επόμενη εκκρεμότητα.';
    openCorrection(id, next);
    return;
  }
  closeModal(); toast(duplicate ? 'Η κίνηση υπάρχει ήδη και υπολογίζεται. Μπορείς να συνεχίσεις.' : 'Η ακολουθία έχει ήδη συμπληρωθεί. Μπορείς να συνεχίσεις.', 'success'); await refreshApp();
}
function allKnownEvents({ currentOnly = false } = {}) {
  return [state.historyData, state.employeeData, state.monthData, state.requests].filter(function(data) { return !currentOnly || dataDataset(data) !== 'archive'; }).flatMap(function(data) { return data?.events || []; });
}
async function openEventEdit(id, employeeId) {
  if (!isAdmin() || isArchiveView()) return;
  const view = state.view, token = state.loadToken;
  let ev = allKnownEvents({ currentOnly: true }).find(function(e) { return String(e.id) === String(id); });
  if (!ev && employeeId) {
    const data = await api.read('employee', { employee_id: employeeId });
    if (!isAdmin() || isArchiveView() || state.view !== view || state.loadToken !== token || dataDataset(data) === 'archive') return;
    state.historyData = data;
    ev = data.events.find(function(e) { return String(e.id) === String(id); });
  }
  if (!ev) { toast('Η κίνηση δεν βρέθηκε. Ανανέωσε την οθόνη.', 'error'); return; }
  if (ev.source === 'admin' || ev.status === 'draft') { await openAdminDay(ev.employee_id, ev.admin_day || dateKey(ev.event_at), { event_id: ev.id, type: ev.type, shift_ref: ev.shift_ref, break_ref: ev.break_ref }); return; }
  state.modalEvent = ev;
  openModal('Αλλαγή ώρας καταγραφής', personName(ev.employee_id) + ' · ' + ACTIONS[ev.type],
    '<div class="form-grid">' + dateTimeFields(ev.event_at, 'edit') + '<div class="field full"><label for="f-reason">Αιτιολογία αλλαγής · προαιρετική</label><textarea name="reason" id="f-reason" maxlength="1000"></textarea></div></div>' +
    '<p class="field-help">Η αλλαγή γίνεται μόνο αν διατηρεί σωστή την αλληλουχία. Η προηγούμενη τιμή παραμένει στο ιστορικό αλλαγών.</p>', submitButton('Αποθήκευση αλλαγής'), 'event-edit');
}
function openReview(id) {
  if (!isAdmin()) return;
  const ev = state.requests?.events?.find(function(e) { return String(e.id) === String(id); });
  if (!ev) return;
  state.modalEvent = ev;
  openModal('Έλεγχος διόρθωσης', (ev.employee_name || personName(ev.employee_id)) + ' · ' + ACTIONS[ev.type],
    banner(esc(ev.reason || 'Δεν έχει δοθεί αιτιολογία.')) + '<div class="form-grid">' + dateTimeFields(ev.event_at, 'review') + '</div>' +
    '<p class="field-help">Η έγκριση της ίδιας ώρας διατηρεί την υπάρχουσα ακολουθία. Η απόρριψη επιτρέπεται όταν δεν αφήνει άλλες καταγραφές χωρίς τις απαραίτητες προηγούμενες κινήσεις.</p>',
    '<button type="submit" class="button danger" data-submit value="reject" formnovalidate>Απόρριψη</button>' + submitButton('Έγκριση', 'approve'), 'review');
}
function departmentKey(value) { return String(value || '').trim().toLocaleLowerCase('el-GR'); }
function departmentNames() {
  const source = Array.isArray(state.context?.settings?.departments) ? state.context.settings.departments : (state.context?.employees || []).map(function(e) { return e.department; });
  const unique = new Map();
  for (const name of source) {
    const text = String(name || '').trim(), key = departmentKey(text);
    if (key && !unique.has(key)) unique.set(key,text);
  }
  return [...unique.values()].sort(function(a,b) { return a.localeCompare(b,'el'); });
}
function openDepartments() {
  if (!isAdmin()) return;
  const names = departmentNames();
  const body = '<p class="muted">Τα τμήματα εμφανίζονται στη λίστα επιλογής κάθε εργαζομένου.</p>' +
    (names.length ? '<ul class="department-list">' + names.map(function(name) {
      const count = (state.context?.employees || []).filter(function(e) { return departmentKey(e.department) === departmentKey(name); }).length;
      return '<li><div><strong>' + esc(name) + '</strong><small>' + count + (count === 1 ? ' εργαζόμενος' : ' εργαζόμενοι') + '</small></div>' + button('Αφαίρεση','delete-department','data-name="' + esc(name) + '"' + (count ? ' disabled title="Μετέφερε πρώτα τους εργαζομένους σε άλλο τμήμα, μαζί με τους αρχειοθετημένους."' : ' data-mutate'),'small') + '</li>';
    }).join('') + '</ul>' : '<p class="empty-departments">Δεν υπάρχουν τμήματα. Πρόσθεσε το πρώτο παρακάτω.</p>') +
    '<p class="field-help">Για να αφαιρέσεις ένα τμήμα, μετέφερε πρώτα όσους του ανήκουν σε άλλο τμήμα, μαζί με τους αρχειοθετημένους.</p>' +
    field('Νέο τμήμα','department_name','','text','required maxlength="100" autocomplete="off"');
  openModal('Διαχείριση τμημάτων','Προσθήκη και αφαίρεση τμημάτων προσωπικού.',body,submitButton('Προσθήκη τμήματος'),'departments');
}
function openEmployee(id) {
  if (!isAdmin() || (id && !employee(id))) return;
  const e = employee(id) || {};
  state.modalEmployeeId = e.id || null;
  const departments = departmentNames();
  const selectedDepartment = departments.find(function(name) { return departmentKey(name) === departmentKey(e.department); }) || '';
  const body = '<div class="form-grid">' + field('Ονοματεπώνυμο', 'name', e.name || '', 'text', 'required maxlength="120" autocomplete="off"') +
    selectField('Τμήμα', 'department', option('', 'Χωρίς τμήμα', selectedDepartment) + departments.map(function(name) { return option(name,name,selectedDepartment); }).join('')) +
    field('Χρώμα', 'color', /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#2d8d7a', 'color') +
    field('Σειρά εμφάνισης', 'sort_order', e.sort_order ?? 0, 'number', 'min="0" max="100000" required') +
    field('Ώρα προσέλευσης', 'shift1_start', e.shift1_start?.slice(0, 5) || '', 'time') +
    field('Ώρα αποχώρησης', 'shift_end', e.shift_end?.slice(0, 5) || '', 'time') +
    field('Δεύτερη προσέλευση · προαιρετική', 'shift2_start', e.shift2_start?.slice(0, 5) || '', 'time') +
    field('Ανοχή καθυστέρησης · λεπτά', 'lateness_tolerance_minutes', e.lateness_tolerance_minutes || 0, 'number', 'min="0" max="240" required') + '</div>';
  openModal(e.id ? 'Επεξεργασία εργαζομένου' : 'Νέος εργαζόμενος', 'Οι ώρες χρησιμοποιούνται για τις ενδείξεις αργοπορίας και πρόωρης αποχώρησης.', body, submitButton('Αποθήκευση'), 'employee');
}
function deletionPasswordField(count) {
  return count > 1 ? '<div class="field"><label for="f-deletion_password">Κωδικός κύριου διαχειριστή</label><input id="f-deletion_password" name="deletion_password" type="password" autocomplete="current-password" maxlength="1024" required><p class="field-help">Για διαγραφή πολλών καταγραφών, επιβεβαίωσε τον κωδικό σύνδεσής σου στο Time Tracker.</p></div>' : '';
}
function openVoid(ids) {
  if (!isOwner() || isArchiveView() || !ids.length) return;
  ids = [...new Set(ids.map(String))];
  if (ids.length > 100) { toast('Μπορείς να διαγράψεις έως 100 κινήσεις μαζί. Μείωσε τις επιλεγμένες κινήσεις και δοκίμασε ξανά.', 'error'); return; }
  state.modalVoidIds = ids;
  openModal(ids.length === 1 ? 'Επιβεβαίωση διαγραφής καταγραφής' : 'Επιβεβαίωση διαγραφής καταγραφών', ids.length + (ids.length === 1 ? ' επιλεγμένη κίνηση' : ' επιλεγμένες κινήσεις'),
    banner('Προσοχή: οι επιλεγμένες κινήσεις θα αφαιρεθούν από τους υπολογισμούς. Θα παραμείνουν στις «Καταγραφές» με κατάσταση «Ακυρωμένη», για έλεγχο. Η διαγραφή επιτρέπεται μόνο όταν διατηρείται σωστή η ακολουθία των υπόλοιπων κινήσεων.', 'warning') +
    '<div class="field"><label for="f-reason">Αιτιολογία διαγραφής</label><textarea id="f-reason" name="reason" minlength="3" maxlength="1000" required></textarea></div>' + deletionPasswordField(ids.length),
    '<button class="button danger" type="submit" data-submit>Επιβεβαίωση διαγραφής</button>', 'void', 'cancel');
}
function protectDeletionEnter(event) {
  if (event.key !== 'Enter' || !event.target?.closest?.('input')) return;
  const form = event.target.closest('form');
  if (form?.dataset.kind !== 'void' && !(form?.dataset.kind === 'admin-day' && adminSlots().some(function(slot) { return slot.original && slot.remove; }))) return;
  event.preventDefault(); modal.querySelector('button[data-action="close-modal"]')?.focus();
}

function openNote(day) {
  if (!isAdmin() || isArchiveView() || isArchiveView('stats') || !state.statsId) return;
  const note = state.stats?.days?.find(function(d) { return d.date === day; })?.note;
  state.modalNoteDate = day;
  openModal('Σημείωση ημέρας', personName(state.statsId) + ' · ' + dateDisplay(day),
    '<div class="form-grid full">' + selectField('Κατηγορία', 'kind', Object.entries(NOTES).map(function(p) { return option(p[0], p[1], note?.kind || 'note'); }).join('')) +
    '<div class="field full"><label for="f-note-text">Κείμενο</label><textarea name="text" id="f-note-text" maxlength="2000">' + esc(note?.text || '') + '</textarea></div></div>',
    (note ? '<button class="button danger" type="submit" data-submit value="delete" formnovalidate>Αφαίρεση σημείωσης</button>' : '') + submitButton('Αποθήκευση', 'save'), 'note');
}
function openMember(email) {
  if (!isAdmin()) return;
  const member = state.adminData?.members?.find(function(m) { return m.email === email; }) || {};
  if (member.login_kind === 'device') { openDevice(member.id); return; }
  if (member.is_owner && !state.context.is_owner) { toast('Ο λογαριασμός ιδιοκτήτη δεν αλλάζει από άλλον διαχειριστή.', 'error'); return; }
  const owner = Boolean(member.is_owner);
  state.modalMember = member.email ? { email: member.email, is_owner: owner } : null;
  openModal(email ? 'Αλλαγή πρόσβασης' : 'Νέος λογαριασμός πρόσβασης', 'Κάθε λογαριασμός έχει συγκεκριμένα δικαιώματα.',
    '<div class="form-grid">' + field('Email', 'email', member.email || '', 'email', 'required autocomplete="off"' + (email ? ' readonly' : '')) +
    field('Όνομα εμφάνισης', 'display_name', member.display_name || '', 'text', 'maxlength="120"') +
    selectField('Ρόλος', 'role', Object.entries(ROLES).filter(function(p) { return p[0] !== 'operator' || member.role === 'operator'; }).map(function(p) { return option(p[0], p[1], member.role || 'admin'); }).join(''), owner ? 'disabled' : '') +
    '<label class="check-label"><input name="disabled" type="checkbox"' + (member.disabled ? ' checked' : '') + (owner ? ' disabled' : '') + '>Απενεργοποίηση πρόσβασης</label></div>' +
    '<p class="field-help">' + (owner ? 'Στον λογαριασμό ιδιοκτήτη αλλάζει μόνο το όνομα εμφάνισης.' : 'Ο διαχειριστής έχει πλήρη διαχείριση. Για κοινό υπολογιστή, δημιούργησε ξεχωριστό λογαριασμό στην ενότητα «Υπολογιστές καταγραφής».') + '</p>',
    submitButton('Αποθήκευση πρόσβασης'), 'member');
}
function openDevice(id) {
  if (!isAdmin()) return;
  const member = id ? state.adminData?.members?.find(function(m) { return String(m.id) === String(id) && m.login_kind === 'device'; }) : null;
  if (id && !member) { toast('Ο λογαριασμός υπολογιστή δεν βρέθηκε. Ανανέωσε τους λογαριασμούς.', 'error'); return; }
  state.modalDevice = member ? { id: member.id, username: member.username } : null;
  openModal(member ? 'Αλλαγή υπολογιστή καταγραφής' : 'Νέος υπολογιστής καταγραφής', 'Ο λογαριασμός επιτρέπει μόνο καταγραφές και αιτήματα διόρθωσης.',
    '<div class="form-grid">' + field('Όνομα χρήστη', 'username', member?.username || '', 'text', 'required minlength="3" maxlength="48" pattern="[a-zA-Z0-9][a-zA-Z0-9._\\-]{2,47}" autocomplete="off" autocapitalize="none" spellcheck="false"' + (member ? ' readonly' : '')) +
    field('Όνομα υπολογιστή', 'display_name', member?.display_name || '', 'text', 'required maxlength="120" autocomplete="off"') +
    '<div class="full">' + field(member ? 'Νέος κωδικός · προαιρετικά' : 'Κωδικός πρόσβασης', 'password', '', 'password', (member ? '' : 'required ') + 'minlength="5" maxlength="128" autocomplete="new-password"') + '</div>' +
    (member ? '<label class="check-label full"><input name="disabled" type="checkbox"' + (member.disabled ? ' checked' : '') + '>Απενεργοποίηση πρόσβασης υπολογιστή</label>' : '') + '</div>' +
    '<p class="field-help">Το όνομα χρήστη έχει 3–48 λατινικούς χαρακτήρες, αριθμούς, τελεία, παύλα ή κάτω παύλα και ξεκινά με γράμμα ή αριθμό. Ο κωδικός έχει τουλάχιστον 5 χαρακτήρες. Αρκούν μικρά λατινικά γράμματα, χωρίς υποχρεωτικά κεφαλαία, αριθμούς ή σύμβολα.' + (member ? ' Άφησέ τον κενό για να διατηρηθεί ο υπάρχων. Το όνομα χρήστη δεν αλλάζει.' : ' Αποθήκευσέ τον για τη σύνδεση στον συγκεκριμένο υπολογιστή.') + '</p>',
    submitButton(member ? 'Αποθήκευση υπολογιστή' : 'Δημιουργία υπολογιστή'), 'device-account');
}
function updateBulkSelection() {
  if (!isOwner() || isArchiveView()) return;
  const checked = document.querySelectorAll('.event-check:checked').length;
  const box = document.getElementById('bulk-bar'); if (!box) return;
  box.classList.remove('hidden');
  document.getElementById('bulk-label').textContent = checked + ' επιλεγμένες κινήσεις' + (checked > 100 ? ' · Έως 100 ανά διαγραφή' : '');
  const remove = document.getElementById('delete-selected-events');
  if (remove) remove.disabled = checked === 0 || state.busy || Boolean(state.pendingCommand);
  const all = document.getElementById('select-all-events');
  if (all) { const total = document.querySelectorAll('.event-check').length; all.checked = total > 0 && checked === total; all.indeterminate = checked > 0 && checked < total; }
}
function exportStats() {
  if (!state.stats || !state.monthData) return;
  const archived = isArchiveView('stats');
  const estimatedEvents = archived ? (state.monthData.events || []).filter(function(e) { return e.source === 'history_cleanup'; }) : [];
  const estimatedIds = new Set(estimatedEvents.map(function(e) { return String(e.id); }));
  const estimatedDates = new Set(estimatedEvents.map(function(e) { return dateKey(e.event_at); }));
  const rows = [['Εργαζόμενος', 'Ημερομηνία', 'Βάρδιες', 'Παρουσία λεπτά', 'Διαλείμματα λεπτά', 'Καθυστέρηση λεπτά', 'Εκκρεμείς κινήσεις', 'Ανοιχτή βάρδια', 'Κατηγορία σημείωσης', 'Σημείωση']];
  if (archived) rows[0].push('Εκτιμώμενη παλιά ώρα');
  for (const day of state.stats.days) {
    const row = [state.monthData.employee.name, dateDisplay(day.date), day.shifts.map(function(s) { return displayTime(s.start_at) + '–' + displayTime(s.end_at); }).join(' / '),
      Math.round(day.gross_minutes), Math.round(day.break_minutes), Math.round(day.late_minutes), day.pending_count, day.has_open_shift ? 'Ναι' : 'Όχι', day.note ? NOTES[day.note.kind] : '', day.note?.text || ''];
    if (archived) {
      const estimated = estimatedDates.has(day.date) || day.shifts.some(function(shift) {
        return [shift.start_id, shift.end_id, ...(shift.breaks || []).flatMap(function(br) { return [br.start_id, br.end_id]; })].some(function(id) { return id != null && estimatedIds.has(String(id)); });
      });
      row.push(estimated ? 'Ναι' : '');
    }
    rows.push(row);
  }
  const csv = '\ufeff' + rows.map(function(row) {
    return row.map(function(value) { let s = String(value ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }).join(';');
  }).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a'); link.href = url; link.download = 'parousies-' + state.month + (archived ? '-palio-istoriko' : '') + '.csv'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}
async function logout(message = '') {
  if (state.busy) return;
  if (pageMode.admin) { clearAdminIdle(); state.adminIdleEstablished = false; }
  state.authMode = pageMode.admin ? 'admin' : 'device'; state.signup = false; state.authResend = false; state.authRetryRestore = false;
  state.sessionLoadToken++; state.browserCheckToken++; state.browserCheckBusy = false; state.browserGate = null; state.browserData = null; state.browserPollAt = 0;
  closeModal(); state.loadToken++; state.context = null; state.employeeData = null; state.historyData = null; state.monthData = null;
  state.selectedId = ''; state.historyId = ''; state.statsId = ''; state.historyDataset = 'current'; state.statsDataset = 'current'; state.overview = null; state.requests = null; state.adminData = null; state.adminDay = null; state.adminDayLoadToken++; state.nextScheduledRefresh = 0;
  let signedOut;
  try { signedOut = api.signOut(); } catch {}
  state.authMessage = message; state.authError = false; renderLogin();
  try { await signedOut; } catch {}
}
async function returnToShop() {
  if (!pageMode.admin || state.busy || state.authBusy || state.returningToShop) return;
  if (state.pendingCommand) { toast('Έλεγξε πρώτα την τελευταία αποθήκευση πριν επιστρέψεις στο κατάστημα.', 'error'); return; }
  state.authBusy = true; state.returningToShop = true;
  try { window.location.assign(pageMode.shopUrl); }
  catch (error) { state.returningToShop = false; throw error; }
  finally { state.authBusy = false; }
}
async function handleAction(action, node) {
  if (state.sessionReloadPending || expireAdminIdle()) return;
  if (state.busy || state.authBusy || state.requestBulkRunning) return;
  if (action === 'approve-selected-requests') { await approveSelectedRequests(); return; }
  if (action === 'return-shop') { await returnToShop(); return; }
  if (action === 'open-requests') {
    if (!['admin','reviewer'].includes(state.context?.role)) return;
    state.requestEmployee = node.dataset.employee || ''; state.requestStatus = 'pending'; state.requests = null;
    await navigate('requests'); return;
  }
  if (action === 'manage-departments') { openDepartments(); return; }
  if (action === 'delete-department') {
    if (!isAdmin()) return;
    try {
      await command('department_delete',{name:node.dataset.name});
      await refreshApp(); if (isAdmin()) openDepartments(); toast('Το τμήμα αφαιρέθηκε.','success');
    } catch (error) { if (!handleBrowserGate(error)) modalError(error); }
    return;
  }
  if (action === 'auth-mode' || action === 'toggle-signup' || action === 'resend-confirmation') {
    if (!pageMode.admin && (action !== 'auth-mode' || node.dataset.mode === 'admin')) { window.location.assign(pageMode.adminUrl); return; }
    if (pageMode.admin && action === 'auth-mode' && node.dataset.mode === 'device') { await returnToShop(); return; }
    rememberAuthIdentity(document.getElementById('auth-form'));
    if (action === 'auth-mode') { state.authMode = node.dataset.mode === 'device' ? 'device' : 'admin'; state.signup = false; state.authResend = false; }
    else if (action === 'resend-confirmation') { state.authMode = 'admin'; state.signup = false; state.authResend = true; }
    else { state.authMode = 'admin'; state.signup = state.authResend ? false : !state.signup; state.authResend = false; }
    state.authMessage = ''; state.authError = false; state.authRetryRestore = false; renderLogin(); return;
  }
  if (action === 'retry-restore') { state.authMessage = 'Επανασύνδεση…'; state.authError = false; renderLogin(); await initialize(); return; }
  if (action === 'browser-check') { await checkBrowserApproval(); return; }
  if (action === 'browser-owner-login') { if (!pageMode.admin) { window.location.assign(pageMode.adminUrl); return; } await logout(); state.authMode = 'admin'; renderLogin(); return; }
  if (action === 'logout') { await logout(); return; }
  if (action === 'close-modal') { closeModal(); return; }
  if (action === 'toggle-menu') { const side = document.getElementById('sidebar'); side?.classList.toggle('open'); node.setAttribute('aria-expanded', String(side?.classList.contains('open'))); return; }
  if (!state.context) return;
  if (action === 'stats-select-employee') {
    if (!['admin', 'reviewer'].includes(state.context.role)) return;
    const id = String(node.dataset.id || '');
    const person = (state.context.employees || []).find(function(e) { return String(e.id) === id; });
    if (!person || person.deleted_at || (person.archived && !state.statsShowArchived) || String(state.statsId) === id) return;
    state.statsId = person.id; state.statsSelectedDay = ''; state.statsSelectionScope = '';
    await loadView('stats'); return;
  }
  if (action === 'stats-select-day' || action === 'stats-close-day' || action === 'stats-filter-days' || action === 'stats-shift-month') {
    if (!['admin', 'reviewer'].includes(state.context.role) || state.view !== 'stats') return;
    if (action === 'stats-shift-month') {
      const offset = Number(node.dataset.offset); if (![-1, 1].includes(offset)) return;
      const [year, month] = state.month.split('-').map(Number);
      const next = new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7);
      if (next < '2000-01' || next > '9999-12') return;
      state.month = next; state.statsSelectedDay = ''; state.statsSelectionScope = ''; await loadView('stats'); return;
    }
    if (action === 'stats-filter-days') {
      if (!['all', 'present', 'attention'].includes(node.dataset.filter)) return;
      state.statsFilter = node.dataset.filter;
    } else if (action === 'stats-close-day') state.statsSelectedDay = '';
    else {
      if (!state.stats?.days.some(function(day) { return day.date === node.dataset.date; })) return;
      state.statsSelectedDay = node.dataset.date;
    }
    renderCurrentView();
    if (action === 'stats-select-day') {
      const panel = document.getElementById('attendance-day-detail'); panel?.focus?.({preventScroll:true});
      if (window.matchMedia?.('(max-width:1100px)').matches) panel?.scrollIntoView?.({behavior:'smooth',block:'start'});
    }
    return;
  }
  if (action === 'kiosk-home') { closeModal(); await refreshApp(); return; }
  if (action === 'browser-list-refresh') { await refreshBrowserList(); return; }
  if (action === 'browser-review-link') { await reviewBrowserLink(true); return; }
  if (action === 'browser-approve') { openBrowserDecision('approve', node.dataset.request); return; }
  if (action === 'browser-revoke') { openBrowserDecision('revoke', node.dataset.id); return; }
  if (action === 'navigate') { await navigate(node.dataset.view); return; }
  if (action === 'refresh') { await refreshApp(); return; }
  if (action === 'select-employee') { await selectEmployee(node.dataset.id); return; }
  if (action === 'select-person-from-overview') { await selectEmployee(node.dataset.id, true); return; }
  if (action === 'record-action') { await recordAction(node.dataset.type); return; }
  if (action === 'person-history') { state.historyId = node.dataset.id; state.historyDataset = 'current'; state.historyStatus = ''; await navigate('history'); return; }
  if (action === 'related-history') {
    state.historyId = node.dataset.employee || state.modalEvent?.employee_id || state.historyId; state.historyDataset = 'current'; state.historyFrom = ''; state.historyTo = ''; state.historyStatus = ''; state.historyType = '';
    closeModal(); await navigate('history'); return;
  }
  if (action === 'admin-day') {
    await openAdminDay(node.dataset.employee || state.statsId, node.dataset.date, { event_id: node.dataset.id, type: node.dataset.type, shift_ref: node.dataset.shift, break_ref: node.dataset.break, time: node.dataset.time, add: node.dataset.add }); return;
  }
  if (action === 'admin-day-reload') { const model = state.adminDay; if (model) await openAdminDay(model.employeeId, model.date); return; }
  if (action === 'admin-add-shift' || action === 'admin-add-break' || action === 'admin-remove-slot') {
    if (!isAdmin() || isArchiveView() || !state.adminDay) return;
    captureAdminDayFields();
    if (action === 'admin-remove-slot') { if (!isOwner()) return; const slot = adminSlots().find(function(s) { return s.key === node.dataset.key; }); if (slot && slot.original && !slot.readonly) slot.remove = !slot.remove; }
    else {
      if (adminSlots().length >= 80) { toast('Αποθήκευσε πρώτα τις υπάρχουσες ώρες πριν προσθέσεις περισσότερες.'); return; }
      if (action === 'admin-add-shift') { const group = newAdminShift(state.adminDay.date); group.breaks.push(newAdminBreak(group)); state.adminDay.groups.push(group); }
      else { const group = state.adminDay.groups.find(function(g) { return String(g.id) === node.dataset.group; }); if (group) group.breaks.push(newAdminBreak(group)); }
    }
    renderAdminDayEditor(); return;
  }
  if (action === 'open-correction') {
    const id = node.dataset.id;
    let current = id === state.selectedId ? stateOf(state.employeeData) : (id === state.historyId ? stateOf(state.historyData) : null);
    const suggestion = current?.issues?.length ? correctionSuggestionForState(current) : null;
    openCorrection(id, suggestion); return;
  }
  if (action === 'correction-from-warning') { const suggestion = state.correctionSuggestion; openCorrection(suggestion.employeeId, suggestion); return; }
  if (action === 'add-correction-entry') {
    const container = document.getElementById('correction-entries'); if (!container) return;
    if (container.children.length >= 20) { toast('Μπορείς να υποβάλεις έως 20 κινήσεις μαζί.', 'error'); return; }
    const i = state.correctionEntryCount++; container.insertAdjacentHTML('beforeend', correctionEntryHtml(i, 'clock_in', null, state.correctionGuidance?.date || today())); updateDstChoices(modal); return;
  }
  if (action === 'remove-correction-entry') {
    const container = document.getElementById('correction-entries');
    if (container?.children.length <= 1) { toast('Χρειάζεται τουλάχιστον μία κίνηση.'); return; }
    node.closest('.correction-entry')?.remove(); return;
  }
  if (action === 'edit-event') { await openEventEdit(node.dataset.id, node.dataset.employee); return; }
  if (action === 'review-event') { openReview(node.dataset.id); return; }
  if (action === 'edit-employee') { openEmployee(node.dataset.id); return; }
  if (action === 'delete-employee') {
    const person = employee(node.dataset.id);
    if (!isAdmin() || !person?.archived) return;
    state.modalEmployeeId = person.id;
    openModal('Διαγραφή αρχειοθετημένου εργαζομένου',person.name,
      '<p>Ο εργαζόμενος θα αφαιρεθεί από τις λίστες της εφαρμογής. Το αποθηκευμένο ιστορικό του θα διατηρηθεί.</p><p class="strong">Θέλεις να συνεχίσεις;</p>',
      submitButton('Διαγραφή από την εφαρμογή').replace('button primary','button danger'),'employee-delete');
    return;
  }
  if (action === 'archive-employee') {
    const id = node.dataset.id; const archived = node.dataset.archived === 'true';
    openModal(archived ? 'Αρχειοθέτηση εργαζομένου' : 'Επαναφορά εργαζομένου', personName(id),
      '<p>' + (archived ? 'Ο εργαζόμενος θα αφαιρεθεί από την ενεργή λίστα. Οι καταγραφές και οι αναφορές του θα διατηρηθούν.' : 'Ο εργαζόμενος θα εμφανιστεί ξανά στην ενεργή λίστα.') + '</p>',
      submitButton(archived ? 'Αρχειοθέτηση' : 'Επαναφορά'), 'archive');
    state.modalEmployeeId = id; state.modalArchived = archived; return;
  }
  if (action === 'delete-history-event') { openVoid([node.dataset.id]); return; }
  if (action === 'void-selected') { openVoid(Array.from(document.querySelectorAll('.event-check:checked')).map(function(el) { return el.value; })); return; }
  if (action === 'edit-note') { openNote(node.dataset.date); return; }
  if (action === 'edit-member') { openMember(node.dataset.email); return; }
  if (action === 'edit-device') { openDevice(node.dataset.id); return; }
  if (action === 'export-stats') { exportStats(); return; }
  if (action === 'retry-command') {
    if (!state.pendingCommand || state.busy) return;
    try {
      const pending = state.pendingCommand, guidance = state.correctionGuidance;
      const token = state.correctionToken, session = state.sessionLoadToken;
      const response = await command(null, null, true);
      if (pending.action === 'correction' && modal.open && String(state.modalEmployeeId) === String(pending.payload.employee_id) && token === state.correctionToken && session === state.sessionLoadToken) {
        await completeCorrection(pending.payload.employee_id, response, guidance, token, session); return;
      }
      const result = response?.result || response || {};
      closeModal(); toast(result.already_recorded ? ((pending.completionMessage ? 'Οι διορθώσεις καταχωρήθηκαν. ' : '') + (result.message || 'Η ενέργεια είχε ήδη καταγραφεί.')) : (pending.completionMessage || 'Η αποθήκευση επιβεβαιώθηκε.'), 'success'); await refreshApp();
    } catch (error) { if (await recoverDatasetChanged(error)) return; if (error.uncertain) toast('Δεν έχει επιβεβαιωθεί ακόμη. Δοκίμασε όταν επανέλθει η σύνδεση.', 'error'); else { toast(issueMessages(error), 'error'); await refreshApp(); } }
    return;
  }
  if (action === 'more-audit' && state.auditCursor) {
    const data = await api.read('audit', { cursor: state.auditCursor, limit: 100 }); state.audit.push(...(data.rows || [])); state.auditCursor = data.next_cursor; renderCurrentView();
  }
}
function rememberAuthIdentity(form) {
  if (form?.elements?.email) state.authEmail = form.elements.email.value.trim();
  if (form?.elements?.username) state.authUsername = form.elements.username.value.trim().toLowerCase();
}
async function handleAuth(form) {
  if (state.authBusy) return;
  const submit = form.querySelector('[type=submit]'); const progress = document.getElementById('auth-progress');
  state.authBusy = true; submit.disabled = true;
  const device = !pageMode.admin; const resend = !device && state.authResend;
  progress.textContent = resend ? 'Αποστολή email…' : (state.signup ? 'Δημιουργία λογαριασμού…' : 'Σύνδεση…');
  rememberAuthIdentity(form);
  try {
    if (resend) {
      await api.resendConfirmation(state.authEmail);
      state.authResend = false; state.signup = false; state.authError = false; state.authRetryRestore = false;
      state.authMessage = 'Αν το email περιμένει επιβεβαίωση, θα λάβεις νέο σύνδεσμο. Έλεγξε και την ανεπιθύμητη αλληλογραφία. Άνοιξε τον πιο πρόσφατο σύνδεσμο.';
      renderLogin(); return;
    }
    if (device && (form.elements.password.value.length < 5 || form.elements.password.value.length > 128)) throw new Error('Ο κωδικός πρέπει να έχει από 5 έως 128 χαρακτήρες.');
    const payload = device ? { username: state.authUsername, password: form.elements.password.value } : { email: state.authEmail, password: form.elements.password.value };
    if (!device && state.signup) {
      const result = await api.signUp(payload);
      if (result.needs_confirmation) {
        state.signup = false; state.authMessage = 'Έλεγξε το email σου και επιβεβαίωσε τη διεύθυνσή σου. Έπειτα επέστρεψε εδώ για σύνδεση.'; state.authError = false; renderLogin(); return;
      }
    } else await api.signIn(payload);
    state.authMessage = ''; state.authError = false; state.authRetryRestore = false;
    await enterApp({freshAdmin: pageMode.admin});
  } catch (error) {
    if (handleBrowserGate(error)) return;
    state.authMessage = error.message || 'Η σύνδεση δεν ολοκληρώθηκε.'; state.authError = true; renderLogin();
  } finally { if (form.elements.password) form.elements.password.value = ''; state.authBusy = false; if (submit.isConnected) submit.disabled = false; }
}
async function saveDeviceAccount(form) {
  if (!isAdmin()) throw new Error('Απαιτείται διαχειριστής.');
  if (state.busy) return;
  const f = form.elements; const member = state.modalDevice;
  const username = member?.username || f.username.value.trim().toLowerCase();
  try {
    if (!/^[a-z0-9][a-z0-9._-]{2,47}$/.test(username)) throw new Error('Το όνομα χρήστη πρέπει να έχει 3–48 λατινικούς χαρακτήρες, αριθμούς, τελεία, παύλα ή κάτω παύλα.');
    if ((!member || f.password.value) && (f.password.value.length < 5 || f.password.value.length > 128)) throw new Error('Ο κωδικός πρέπει να έχει από 5 έως 128 χαρακτήρες.');
    if (!f.display_name.value.trim()) throw new Error('Συμπλήρωσε όνομα υπολογιστή.');
    const payload = { action: member ? 'update_device' : 'create_device', username, display_name: f.display_name.value.trim() };
    if (member) { payload.id = member.id; payload.disabled = Boolean(f.disabled?.checked); }
    if (f.password.value) payload.password = f.password.value;
    setBusy(true);
    try { await api.manageAccount(payload); }
    finally { delete payload.password; }
    setBusy(false); closeModal(); toast(member ? 'Ο υπολογιστής ενημερώθηκε.' : 'Ο λογαριασμός υπολογιστή δημιουργήθηκε.', 'success');
    await refreshApp();
  } catch (error) {
    setBusy(false);
    if (!error.uncertain) throw error;
    closeModal();
    try { state.adminData = await api.read('admin', {}); setServerTime(state.adminData.server_now); if (state.view === 'settings') renderCurrentView(); } catch { setConnection(false); }
    toast('Δεν επιβεβαιώθηκε η αλλαγή. Ανανέωσε τους λογαριασμούς πριν προσπαθήσεις ξανά.', 'error');
  } finally { f.password.value = ''; setBusy(false); }
}
async function handleModalForm(form, decision) {
  if (state.sessionReloadPending || expireAdminIdle()) return;
  const kind = form.dataset.kind;
  const f = form.elements;
  try {
    if (isArchiveView() && ['admin-day', 'correction', 'event-edit', 'review', 'void', 'note'].includes(kind)) throw new Error('Το παλιό ιστορικό είναι διαθέσιμο μόνο για προβολή.');
    if (kind === 'browser-decision') { await saveBrowserDecision(); return; }
    if (kind === 'departments') {
      if (!isAdmin()) throw new Error('Απαιτείται διαχειριστής.');
      const name = String(f.department_name?.value || '').trim();
      if (!name) throw new Error('Συμπλήρωσε το όνομα του τμήματος.');
      await command('department_add',{name});
      await refreshApp(); if (isAdmin()) openDepartments(); toast('Το τμήμα προστέθηκε.','success'); return;
    }
    if (kind === 'admin-day') {
      if (!isAdmin() || !state.adminDay) throw new Error('Απαιτείται διαχειριστής.');
      const entries = adminDayEntriesFromForm(form);
      if (!entries.length) { closeModal(); toast('Δεν υπάρχουν νέες αλλαγές.'); return; }
      const reason = String(f.admin_reason?.value || '').trim();
      const model = state.adminDay, removals = entries.filter(function(entry) { return entry.remove; }).length;
      if (removals && !isOwner()) throw new Error('Μόνο ο κύριος διαχειριστής μπορεί να διαγράφει καταγραφές.');
      const password = removals > 1 ? String(f.deletion_password?.value || '') : null;
      if (removals > 1 && !password) throw new Error('Συμπλήρωσε τον κωδικό του κύριου διαχειριστή για τη μαζική διαγραφή.');
      let response;
      try { response = await command('admin_day_save', { employee_id: model.employeeId, date: model.date, expected_revision: model.revision, entries, reason },false,null,password); }
      finally { if (f.deletion_password) f.deletion_password.value = ''; }
      const result = response?.result || response || {};
      closeModal();
      toast(result.drafts?.length ? 'Οι ώρες αποθηκεύτηκαν. Οι πρόχειρες κινήσεις περιμένουν να συμπληρωθούν οι προϋποθέσεις τους.' : 'Οι ώρες ημέρας αποθηκεύτηκαν.', 'success');
      await refreshApp(); return;
    }
    if (kind === 'correction') {
      const id = state.modalEmployeeId; const guidance = state.correctionGuidance;
      const token = state.correctionToken; const session = state.sessionLoadToken;
      const dateChoice = updateGuidedCorrectionDate(form); if (dateChoice.error) throw new Error(dateChoice.error);
      let sections = Array.from(form.querySelectorAll('.correction-entry'));
      if (isOperator()) sections = sections.slice(0, 1);
      const entries = sections.map(function(section) {
        const prefix = 'entry_' + section.dataset.entry;
        const type = guidance?.guided ? guidance.actions[0] : f[prefix + '_type'].value;
        if (!ACTIONS[type]) throw new Error('Επίλεξε την ενέργεια που θέλεις να διορθώσεις.');
        return { type, event_at: isoFromForm(form, prefix) };
      });
      try {
        const payload = { employee_id: id, entries, reason: String(f.reason?.value || '').trim() };
        if (guidance?.issue?.event_id && guidance.guided) payload.guidance = {event_id: guidance.issue.event_id, state_before: guidance.issue.state_before, expected_actions: guidance.issue.expected_actions};
        const response = await command('correction', payload);
        await completeCorrection(id, response, guidance, token, session);
      } catch (error) {
        const code = error.details?.code || error.code;
        if (!error.uncertain && ['DUPLICATE_EVENT', 'CORRECTION_CONTEXT_CHANGED'].includes(code)) {
          await refreshDuplicateCorrection(id, guidance, token, session, code); return;
        }
        const savedState = code === 'CORRECTION_SEQUENCE' ? error.details?.before_state : error.details?.state;
        if (!error.uncertain && ['CORRECTION_NOT_PROGRESSING', 'CORRECTION_SEQUENCE'].includes(code) && savedState) {
          const current = stateOf(savedState);
          cacheCorrectionState(id, current);
          const fresh = correctionSuggestionForState(current, guidance?.requestedAction || null);
          state.correctionGuidance = {...fresh, guided: guidance?.guided === true};
          error.message = 'Η διόρθωση δεν αποθηκεύτηκε, γιατί η ώρα δεν ταιριάζει με τη σειρά των υπαρχουσών εγγραφών. Έλεγξε την ώρα ή ζήτησε έλεγχο του ιστορικού.';
        }
        describeFlowFailure(error, entries);
        throw error;
      }
      return;
    }
    if (kind === 'event-edit') {
      await command('event_edit', { event_id: state.modalEvent.id, event_at: isoFromForm(form, 'edit'), reason: f.reason.value.trim() });
      closeModal(); toast('Η αλλαγή ώρας αποθηκεύτηκε.', 'success'); await refreshApp(); return;
    }
    if (kind === 'review') {
      const payload = { event_id: state.modalEvent.id, decision: decision === 'reject' ? 'reject' : 'approve' };
      if (payload.decision === 'approve') {
        const final = isoFromForm(form, 'review');
        if (Date.parse(final) !== Date.parse(state.modalEvent.event_at)) payload.event_at = final;
      }
      await command('review', payload);
      closeModal(); toast(payload.decision === 'approve' ? 'Η διόρθωση εγκρίθηκε.' : 'Η διόρθωση απορρίφθηκε.', 'success'); await refreshApp(); return;
    }
    if (kind === 'employee') {
      const payload = {
        name: f.name.value.trim(), department: f.department.value.trim(), color: f.color.value,
        sort_order: Number(f.sort_order.value),
        shift1_start: f.shift1_start.value ? normalizeTime(f.shift1_start.value) : null, shift2_start: f.shift2_start.value ? normalizeTime(f.shift2_start.value) : null,
        shift_end: f.shift_end?.value ? normalizeTime(f.shift_end.value) : null,
        lateness_tolerance_minutes: Number(f.lateness_tolerance_minutes.value)
      };
      if (state.modalEmployeeId) payload.id = state.modalEmployeeId;
      await command('employee_save', payload); closeModal(); toast('Ο εργαζόμενος αποθηκεύτηκε.', 'success'); await refreshApp(); return;
    }
    if (kind === 'employee-delete') {
      const person = employee(state.modalEmployeeId);
      if (!isAdmin() || !person?.archived) throw new Error('Διαγραφή επιτρέπεται μόνο για αρχειοθετημένο εργαζόμενο.');
      await command('employee_delete',{id:person.id});
      closeModal(); toast('Ο εργαζόμενος αφαιρέθηκε από την εφαρμογή. Το ιστορικό του διατηρήθηκε.','success'); await refreshApp(); return;
    }
    if (kind === 'archive') {
      await command('employee_archive', { id: state.modalEmployeeId, archived: state.modalArchived });
      if (state.modalArchived && state.selectedId === state.modalEmployeeId) { state.selectedId = ''; state.employeeData = null; }
      closeModal(); toast(state.modalArchived ? 'Ο εργαζόμενος αρχειοθετήθηκε.' : 'Ο εργαζόμενος επανήλθε.', 'success'); await refreshApp(); return;
    }
    if (kind === 'void') {
      if (!isOwner()) throw new Error('Μόνο ο κύριος διαχειριστής μπορεί να διαγράφει καταγραφές.');
      const password = state.modalVoidIds.length > 1 ? String(f.deletion_password?.value || '') : null;
      if (state.modalVoidIds.length > 1 && !password) throw new Error('Συμπλήρωσε τον κωδικό του κύριου διαχειριστή για τη μαζική διαγραφή.');
      try { await command('event_void', { ids: state.modalVoidIds, reason: f.reason.value.trim() },false,null,password); }
      finally { if (f.deletion_password) f.deletion_password.value = ''; }
      closeModal(); toast('Οι κινήσεις ακυρώθηκαν. Τις βλέπεις στις «Καταγραφές», με κατάσταση «Ακυρωμένη».', 'success'); await refreshApp(); return;
    }
    if (kind === 'note') {
      if (decision === 'delete') await command('note_delete', { employee_id: state.statsId, date: state.modalNoteDate });
      else await command('note_save', { employee_id: state.statsId, date: state.modalNoteDate, kind: f.kind.value, text: f.text.value.trim() });
      closeModal(); toast(decision === 'delete' ? 'Η σημείωση αφαιρέθηκε.' : 'Η σημείωση αποθηκεύτηκε.', 'success'); await refreshApp(); return;
    }
    if (kind === 'member') {
      if (!isAdmin()) throw new Error('Απαιτείται διαχειριστής.');
      const email = state.modalMember?.email || f.email.value.trim();
      const member = state.adminData?.members?.find(function(m) { return String(m.email || '').toLowerCase() === email.toLowerCase(); });
      if (member?.is_owner && !state.context.is_owner) throw new Error('Ο λογαριασμός ιδιοκτήτη δεν αλλάζει από άλλον διαχειριστή.');
      if (member?.login_kind === 'device') throw new Error('Άλλαξε αυτόν τον λογαριασμό στην ενότητα υπολογιστών καταγραφής.');
      await command('member_save', { email, display_name: f.display_name.value.trim(), role: member?.is_owner ? 'admin' : f.role.value, disabled: member?.is_owner ? false : f.disabled.checked });
      closeModal(); toast('Η πρόσβαση ενημερώθηκε.', 'success'); await refreshApp();
    }
    if (kind === 'device-account') { await saveDeviceAccount(form); return; }
  } catch (error) { if (await recoverDatasetChanged(error)) return; if (!state.browserGate && !handleBrowserGate(error)) modalError(error, kind); }
}
async function handleSettings(form) {
  if (state.sessionReloadPending || expireAdminIdle()) return;
  const f = form.elements;
  try {
    await command('settings_save', {
      break_limit_minutes: Number(f.break_limit_minutes.value), shift_target_minutes: Math.round(Number(f.shift_target_hours.value) * 60),
      idle_timeout_minutes: Number(f.idle_timeout_minutes.value)
    });
    toast('Οι ρυθμίσεις αποθηκεύτηκαν.', 'success'); await refreshApp();
  } catch (error) { toast(issueMessages(error), 'error'); }
}
async function handleChange(target) {
  if (!state.context || state.requestBulkRunning) return;
  if (target.id === 'select-all-requests' || target.classList?.contains('request-checkbox')) {
    if (!isAdmin() || state.view !== 'requests' || state.busy || state.pendingCommand) return;
    const visible = reconcileRequestSelection(); state.requestBulkResult = null;
    if (target.id === 'select-all-requests') state.requestSelection = target.checked ? new Set(visible) : new Set();
    else if (visible.has(String(target.dataset.requestId))) {
      if (target.checked) state.requestSelection.add(String(target.dataset.requestId)); else state.requestSelection.delete(String(target.dataset.requestId));
    }
    renderCurrentView(); return;
  }
  if (target.dataset && Object.hasOwn(target.dataset, 'timeInput')) updateTimeInput(target, {complete: true});
  if (target.dataset.dst) { updateDstChoices(modal); return; }
  if (target.id === 'employee-department') {
    state.department = target.value; const grid = document.getElementById('employee-grid'); if (grid) grid.innerHTML = employeeGrid(); colorAvatars(); return;
  }
  if (target.id === 'show-archived') { state.showArchived = target.checked; renderCurrentView(); return; }
  if (target.id === 'select-all-events') { if (isArchiveView()) return; document.querySelectorAll('.event-check').forEach(function(el) { el.checked = target.checked; }); updateBulkSelection(); return; }
  if (target.classList.contains('event-check')) { updateBulkSelection(); return; }
  if (target.name === 'history_dataset' || target.name === 'stats_dataset') {
    if (!archiveAvailable() || !['current', 'archive'].includes(target.value)) return;
    const view = target.name === 'history_dataset' ? 'history' : 'stats';
    if (state.view !== view) return;
    closeModal(); state.adminDay = null; state.adminDayLoadToken++;
    if (view === 'history') {
      state.historyDataset = target.value; state.historyData = null;
      state.historyFrom = target.value === 'archive' && state.context.history_archive.from ? dateKey(state.context.history_archive.from) : today().slice(0, 7) + '-01';
      state.historyTo = target.value === 'archive' && state.context.history_archive.to ? dateKey(state.context.history_archive.to) : today();
    } else {
      state.statsDataset = target.value; state.monthData = null; state.stats = null; state.statsSelectedDay = ''; state.statsSelectionScope = ''; state.nextScheduledRefresh = 0;
      const range = state.context.history_archive;
      if (target.value === 'archive' && range.to && (!state.month || state.month > dateKey(range.to).slice(0, 7) || (range.from && state.month < dateKey(range.from).slice(0, 7)))) state.month = dateKey(range.to).slice(0, 7);
    }
    await loadView(view); return;
  }
  if (target.name === 'history_employee') { state.historyId = target.value; await loadView('history'); return; }
  if (target.name === 'history_from') { state.historyFrom = target.value; renderCurrentView(); return; }
  if (target.name === 'history_to') { state.historyTo = target.value; renderCurrentView(); return; }
  if (target.name === 'history_status') { state.historyStatus = target.value; renderCurrentView(); return; }
  if (target.name === 'history_type') { state.historyType = target.value; renderCurrentView(); return; }
  if (target.name === 'request_status') { state.requestSelection.clear(); state.requestBulkResult = null; state.requestStatus = target.value; await loadView('requests'); return; }
  if (target.name === 'request_employee') { state.requestSelection.clear(); state.requestBulkResult = null; state.requestEmployee = target.value; await loadView('requests'); return; }
  if (target.name === 'stats_department') { state.statsDepartment = target.value; renderCurrentView(); return; }
  if (target.name === 'stats_show_archived') { state.statsShowArchived = Boolean(target.checked); if (!state.statsShowArchived && employee(state.statsId)?.archived) { state.statsId = activeEmployees()[0]?.id || ''; state.monthData = null; state.stats = null; state.statsSelectedDay = ''; state.statsSelectionScope = ''; await loadView('stats'); } else renderCurrentView(); return; }
  if (target.name === 'stats_month_number' || target.name === 'stats_year') {
    const current = /^\d{4}-(0[1-9]|1[0-2])$/.test(state.month) ? state.month : today().slice(0, 7);
    const year = target.name === 'stats_year' ? String(target.value) : current.slice(0, 4);
    const month = target.name === 'stats_month_number' ? String(target.value) : current.slice(5);
    if (!/^(?:[2-9]\d{3})$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) return;
    const next = year + '-' + month;
    if (next === state.month) return;
    state.month = next; state.statsSelectedDay = ''; state.statsSelectionScope = ''; await loadView('stats'); return;
  }
  if (target.name === 'stats_employee') { state.statsId = target.value; state.statsSelectedDay = ''; state.statsSelectionScope = ''; await loadView('stats'); return; }
  if (target.name === 'stats_month' && /^\d{4}-\d{2}$/.test(target.value)) { state.month = target.value; state.statsSelectedDay = ''; state.statsSelectionScope = ''; await loadView('stats'); return; }
  if (target.name === 'stats_mode') { state.statsMode = target.value; renderCurrentView(); }
}
function tick() {
  if (state.sessionReloadPending) return;
  expireAdminIdle(); updateAdminIdleBadge();
  if (state.browserGate?.status === 'pending' && state.browserPollAt && Date.now() >= state.browserPollAt && !state.busy && !state.authBusy && !state.browserCheckBusy && !document.hidden) {
    state.browserPollAt = Date.now() + 15000; checkBrowserApproval();
  }
  const clock = document.querySelector('.live-clock');
  if (clock) clock.textContent = displayTime(now());
  document.querySelectorAll('[data-elapsed]').forEach(function(el) {
    const seconds = Math.max(0, Math.floor((now().getTime() - Date.parse(el.dataset.elapsed)) / 1000));
    el.textContent = formatMinutes(Math.floor(seconds / 60));
  });
  document.querySelectorAll('[data-live-break]').forEach(updateLiveBreakExcess);
  const ctx = state.context;
  if (ctx && state.view === 'stats' && state.nextScheduledRefresh && now().getTime() >= state.nextScheduledRefresh && !state.busy && !modal.open && !document.hidden) {
    state.nextScheduledRefresh = 0;
    loadView('stats', true).catch(function(error) { setConnection(false); toast(error.message, 'error'); });
  }
}

['click', 'pointerdown', 'keydown', 'touchstart', 'input', 'change'].forEach(function(type) {
  document.addEventListener(type, recordAppActivity, {capture: true});
});
document.addEventListener('click', function(event) {
  if (event.target.closest?.('a.kiosk-admin-link') && state.busy) { event.preventDefault(); return; }
  const node = event.target.closest?.('button[data-action]');
  if (!node) {
    const row = event.target.closest?.('[data-stats-day]');
    if (row) Promise.resolve(handleAction('stats-select-day', {dataset:{date:row.dataset.statsDay}})).catch(function(error) { toast(error.message, 'error'); });
    return;
  }
  if (node.disabled) return;
  event.preventDefault();
  Promise.resolve(handleAction(node.dataset.action, node)).catch(function(error) { toast(error.message || 'Η ενέργεια δεν ολοκληρώθηκε.', 'error'); });
});
document.addEventListener('submit', function(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.id === 'auth-form') handleAuth(form);
  else if (form.id === 'settings-form') handleSettings(form);
  else if (form.id === 'modal-form') handleModalForm(form, event.submitter?.value);
});
document.addEventListener('change', function(event) {
  Promise.resolve(handleChange(event.target)).catch(function(error) { toast(error.message, 'error'); });
});
document.addEventListener('input', function(event) {
  if (event.target.dataset && Object.hasOwn(event.target.dataset, 'timeInput')) updateTimeInput(event.target, {deleting: Boolean(event.inputType?.startsWith('delete'))});
  if (event.target.id === 'employee-search') {
    state.search = event.target.value;
    const grid = document.getElementById('employee-grid'); if (grid) { grid.innerHTML = employeeGrid(); colorAvatars(); }
  }
  if (event.target.id === 'attendance-search') {
    state.statsSearch = event.target.value;
    const list = document.getElementById('attendance-employee-list'); if (list) { list.innerHTML = statsEmployeeList(); colorAvatars(); }
  }
  if (event.target.dataset.dst) updateDstChoices(modal);
});
document.addEventListener('focusin', function(event) {
  if (event.target.dataset && Object.hasOwn(event.target.dataset, 'timeInput')) event.target.select?.();
});
document.addEventListener('paste', function(event) {
  const input = event.target;
  if (!input.dataset || !Object.hasOwn(input.dataset, 'timeInput') || !event.clipboardData) return;
  const value = event.clipboardData.getData('text').trim();
  event.preventDefault();
  try {
    input.value = normalizeTime(value).replace(':', '.');
    updateTimeInput(input, {complete: true});
    if (input.dataset.dst) updateDstChoices(modal);
  } catch (error) { input.setCustomValidity?.(error.message); input.reportValidity?.(); }
});
modal.addEventListener('keydown', protectDeletionEnter);
modal.addEventListener('cancel', function(event) {
  if (state.busy) event.preventDefault();
  else { state.correctionToken++; state.correctionGuidance = null; clearPasswords(modal); state.modalDevice = null; state.modalMember = null; state.modalBrowser = null; clearKioskSelection(); }
});
window.addEventListener('offline', function() { setConnection(false); });
window.addEventListener('online', function() { if (state.browserGate) checkBrowserApproval(); else if (state.context && !state.busy) refreshApp(); });
document.addEventListener('visibilitychange', function() { if (!document.hidden && !expireAdminIdle() && !state.busy && !modal.open) { if (state.browserGate) checkBrowserApproval(); else if (state.context) refreshApp(); } });
window.addEventListener('focus', function() { expireAdminIdle(); updateAdminIdleBadge(); });
window.addEventListener('pageshow', function(event) {
  // A BFCache document can retain an old in-memory admin token after the store
  // expired it. Rehydrate from storage instead of signing out a replacement.
  if (event.persisted) { requestSessionReload(); return; }
  expireAdminIdle(); updateAdminIdleBadge();
});
setInterval(tick, 1000);
setInterval(function() {
  if (state.sessionReloadPending || !state.context || state.busy || modal.open || document.hidden || !['record', 'overview'].includes(state.view)) return;
  loadView(state.view, true);
}, 30000);
if (typeof api.subscribe === 'function') api.subscribe(function(session) {
  if (!session && pageMode.admin) { clearAdminIdle(); state.adminIdleEstablished = false; }
  if (!session && (state.context || state.browserGate)) {
    const wasDevice = state.context?.login_kind === 'device' || Boolean(state.browserGate);
    state.context = null; state.sessionLoadToken++; state.loadToken++; state.adminDayLoadToken++; state.adminDay = null; state.nextScheduledRefresh = 0;
    state.browserCheckToken++; state.browserCheckBusy = false; state.browserGate = null; state.browserData = null; state.browserPollAt = 0;
    clearPasswords(modal); state.modalDevice = null; state.modalMember = null; state.modalBrowser = null; modal.close();
    state.authMode = wasDevice ? 'device' : 'admin'; state.signup = false; state.authResend = false; state.authRetryRestore = false;
    state.authMessage = 'Συνδέσου ξανά για να συνεχίσεις.'; state.authError = false; renderLogin();
  }
});
async function initialize() {
  if (state.authBusy) return;
  if (pageMode.admin && window.location?.href) {
    // Preserve callback credentials until the API verifies and removes them.
    // The remaining panel parameter keeps reloads in the isolated admin scope.
    const current = new URL(window.location.href);
    if (current.searchParams.get('panel') !== 'admin') {
      current.searchParams.set('panel', 'admin');
      window.history?.replaceState?.(null, '', current.pathname + current.search + current.hash);
    }
  }
  captureBrowserRequest();
  const callback = pageMode.admin && freshAdminCallback();
  const record = readAdminIdle();
  const savedAdmin = savedAdminSession();
  if (record && !savedAdmin) clearAdminIdle();
  const staleSavedAdmin = savedAdmin && (!record || idleRemaining(record) <= 0);
  if (staleSavedAdmin && !callback) {
    clearAdminIdle(); discardSavedAdminSession();
    if (pageMode.admin) { state.authMessage = ADMIN_IDLE_MESSAGE; renderLogin(); return; }
  }
  state.authBusy = true;
  try {
    if (await api.restore()) { state.authRetryRestore = false; await enterApp({freshAdmin: callback}); } else { if (pageMode.admin) { clearAdminIdle(); state.adminIdleEstablished = false; discardSavedAdminSession(); } state.authRetryRestore = false; renderLogin(); }
  } catch (error) {
    if (handleBrowserGate(error)) return;
    state.authMessage = error.message || 'Η εφαρμογή δεν μπόρεσε να συνδεθεί.'; state.authError = true;
    state.authRetryRestore = ['NETWORK', 'TIMEOUT', 'BAD_RESPONSE'].includes(error.code);
    if (error.code === 'otp_expired') { state.authMode = 'admin'; state.signup = false; state.authResend = true; }
    renderLogin();
  } finally { state.authBusy = false; }
}
initialize();
