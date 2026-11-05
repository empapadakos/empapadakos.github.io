import { api } from './api.a87b139839baa4fc.js';
import { pageMode } from './page-mode.ad935b8b334d2a75.js';
import { replay, effectiveEvents, planNext, monthlyStats, dateKey, formatTime, formatDate, formatMinutes, localToIso, possibleInstants } from './domain.190ee091016065de.js';

const APP_NAME = 'Time Tracker v2';
document.title = APP_NAME + (pageMode.admin ? ' · Διαχείριση' : '');
const ACTIONS = { clock_in: 'Είσοδος', break_start: 'Έναρξη διαλείμματος', break_end: 'Επιστροφή', clock_out: 'Έξοδος' };
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
  historyId: '', historyData: null, historyFrom: '', historyTo: '', historyStatus: '', historyType: '',
  requests: null, requestStatus: 'pending', requestEmployee: '',
  statsId: '', month: '', statsMode: 'effective', monthData: null, stats: null,
  adminData: null, audit: [], auditCursor: null, showArchived: false,
  search: '', department: '', busy: false, loadToken: 0, personToken: 0, connected: true,
  serverOffset: 0, lastActivity: Date.now(), pendingCommand: null, signup: false, authMessage: '', authError: false,
  authMode: pageMode.admin ? 'admin' : 'device', authResend: false, authEmail: '', authUsername: '', authRetryRestore: false, authBusy: false,
  modalMember: null, modalDevice: null, modalBrowser: null,
  browserGate: null, browserData: null, browserCheckBusy: false, browserCheckToken: 0, browserPollAt: 0, sessionLoadToken: 0,
  pendingBrowserRequest: '', openedBrowserRequest: '',
  adminDay: null, adminDayLoadToken: 0, nextScheduledRefresh: 0
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
function isAdmin() { return state.context?.role === 'admin'; }
function isOperator() { return state.context?.role === 'operator'; }
function isOwner() { return isAdmin() && state.context?.is_owner === true; }
function canRecord() { return ['admin', 'operator'].includes(state.context?.role); }
function now() { return new Date(Date.now() + state.serverOffset); }
function today() { return dateKey(now()); }
function employee(id) { return state.context?.employees?.find(function(e) { return String(e.id) === String(id); }); }
function activeEmployees() { return (state.context?.employees || []).filter(function(e) { return !e.archived; }); }
function reconcileSelections() {
  const rows = state.context?.employees || [];
  const first = rows.find(function(e) { return !e.archived; }) || rows[0];
  if (!rows.some(function(e) { return String(e.id) === String(state.historyId); })) { state.historyId = first?.id || ''; state.historyData = null; }
  if (!rows.some(function(e) { return String(e.id) === String(state.statsId); })) { state.statsId = first?.id || ''; state.monthData = null; state.stats = null; }
  if (!rows.some(function(e) { return !e.archived && String(e.id) === String(state.selectedId); })) { state.selectedId = ''; state.employeeData = null; }
}
function personName(id) { return employee(id)?.name || 'Εργαζόμενος'; }
function initials(name) { return String(name || '').trim().split(/\s+/).slice(0, 2).map(function(p) { return p[0] || ''; }).join('').toLocaleUpperCase('el-GR'); }
function displayDate(value) { try { return formatDate(value); } catch { return '—'; } }
function displayTime(value, seconds = false) { try { return formatTime(value, { seconds }); } catch { return '—'; } }
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
function pendingBadge(count) { return count ? '<span class="badge amber">' + esc(count) + ' σε αναμονή</span>' : ''; }
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
function employeeOptions(selected, includeAll = false) {
  return (includeAll ? option('', 'Όλοι οι εργαζόμενοι', selected) : '') +
    (state.context?.employees || []).map(function(e) { return option(e.id, e.name + (e.archived ? ' · Αρχείο' : ''), selected); }).join('');
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
  document.querySelectorAll('[data-mutate], [data-submit], .employee-card').forEach(function(el) { el.disabled = value; });
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
async function command(action, payload, retry = false) {
  if (state.busy) throw new Error('Περίμενε να ολοκληρωθεί η προηγούμενη ενέργεια.');
  if (state.pendingCommand && !retry) throw new Error('Έλεγξε πρώτα την τελευταία αποθήκευση από το μήνυμα στην κορυφή.');
  const pending = retry ? state.pendingCommand : { action, payload, id: crypto.randomUUID(), email: state.context?.email };
  if (!pending) return null;
  savePending(pending); setBusy(true);
  try {
    const result = await api.command(pending.action, pending.payload, pending.id);
    savePending(null); setConnection(true); setServerTime(result?.server_now); return result;
  } catch (error) {
    if (!error.uncertain && ((error.status && error.status < 500) || error.details || error.code === 'P0001')) savePending(null);
    if (error.uncertain) setConnection(false);
    handleBrowserGate(error);
    throw error;
  } finally { setBusy(false); renderUncertain(); }
}
function issueMessages(error) {
  const details = error?.details || {};
  const issues = details.issues || details.state?.issues || [];
  return [error?.message || 'Η ενέργεια δεν ολοκληρώθηκε.'].concat(issues.slice(0, 5).map(function(i) {
    return i.message || (i.expected_actions?.length ? 'Χρειάζεται πρώτα: ' + i.expected_actions.map(function(a) { return ACTIONS[a] || a; }).join(' → ') : '');
  })).filter(Boolean).filter(function(v, i, all) { return all.indexOf(v) === i; }).join('\n');
}
function modalError(error) {
  const node = document.getElementById('modal-error');
  if (!node) { toast(issueMessages(error), 'error'); return; }
  node.textContent = issueMessages(error);
  if (isAdmin() && error.details?.code === 'STALE_REVISION' && state.adminDay) {
    const p = document.createElement('p'); p.textContent = 'Οι ώρες άλλαξαν σε άλλη συσκευή. Φόρτωσε τη νεότερη εικόνα πριν αποθηκεύσεις ξανά. Οι μη αποθηκευμένες αλλαγές αυτής της φόρμας θα χαθούν.';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'button small'; b.dataset.action = 'admin-day-reload'; b.textContent = 'Φόρτωση νεότερων ωρών'; node.append(p, b);
  }
  if (isAdmin() && error.details?.code === 'DEPENDENT_EVENTS') {
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
  clearPasswords(modal); modal.close(); state.modalDevice = null; state.modalMember = null; state.modalBrowser = null;
  clearKioskSelection();
}
function openModal(title, subtitle, body, footer, kind = '') {
  if (modal.open) { clearPasswords(modal); modal.close(); }
  modal.classList.toggle('kiosk-dialog', isOperator());
  modal.classList.toggle('kiosk-actions-dialog', isOperator() && kind === 'kiosk-actions');
  modal.innerHTML = '<form id="modal-form" data-kind="' + esc(kind) + '"><header class="modal-header"><div><h2 id="modal-title">' + esc(title) + '</h2>' +
    (subtitle ? '<p>' + esc(subtitle) + '</p>' : '') + '</div>' + (isOperator() ? '' : '<button type="button" class="icon-button" data-action="close-modal" aria-label="Κλείσιμο">×</button>') + '</header>' +
    '<div class="modal-body"><div id="modal-error" class="modal-error" role="alert"></div>' + body + '</div>' +
    '<footer class="modal-footer">' + button(isOperator() ? 'Ακύρωση' : 'Άκυρο', 'close-modal') + footer + '</footer></form>';
  modal.showModal(); updateDstChoices(modal); colorAvatars();
  setTimeout(function() { modal.querySelector('input:not([type=hidden]),select,textarea,button')?.focus(); }, 30);
}
function submitButton(label, value = '') { return '<button class="button primary" type="submit" data-submit value="' + esc(value) + '">' + esc(label) + '</button>'; }
function dateTimeValues(iso = now()) {
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Athens', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);
  return { date: dateKey(d), time };
}
function dateTimeFields(iso, prefix) {
  const v = dateTimeValues(iso);
  return field('Ημερομηνία', prefix + '_date', v.date, 'date', 'required data-dst="' + esc(prefix) + '"') +
    field('Ώρα Αθήνας', prefix + '_time', v.time, 'time', 'required step="1" data-dst="' + esc(prefix) + '"') +
    '<div class="field full dst-choice hidden" data-dst-choice="' + esc(prefix) + '"><label for="f-' + esc(prefix) + '_occurrence">Αυτή η ώρα εμφανίζεται δύο φορές</label><select name="' + esc(prefix) + '_occurrence" id="f-' + esc(prefix) + '_occurrence"><option value="">Επίλεξε εμφάνιση ώρας</option><option value="earlier">Πρώτη εμφάνιση · πριν την αλλαγή ώρας</option><option value="later">Δεύτερη εμφάνιση · μετά την αλλαγή ώρας</option></select></div>';
}
function updateDstChoices(root) {
  root.querySelectorAll('[data-dst-choice]').forEach(function(box) {
    const prefix = box.dataset.dstChoice;
    const d = root.querySelector('[name="' + prefix + '_date"]')?.value;
    const t = root.querySelector('[name="' + prefix + '_time"]')?.value;
    let ambiguous = false; try { ambiguous = d && t && possibleInstants(d, t).length > 1; } catch {}
    box.classList.toggle('hidden', !ambiguous);
    const sel = box.querySelector('select'); if (sel) sel.required = Boolean(ambiguous);
  });
}
function isoFromForm(form, prefix) {
  const d = form.elements[prefix + '_date']?.value; const t = form.elements[prefix + '_time']?.value;
  const choice = form.elements[prefix + '_occurrence']?.value || 'reject';
  if (!d || !t) throw new Error('Συμπλήρωσε ημερομηνία και ώρα.');
  return localToIso(d, t, { disambiguation: choice });
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
  document.body.classList.remove('employee-kiosk');
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
  document.body.classList.remove('employee-kiosk');
  clearPasswords(app);
  state.authMode = pageMode.admin ? 'admin' : 'device';
  const device = !pageMode.admin;
  const resend = !device && state.authResend;
  const signup = !device && !resend && state.signup;
  const title = resend ? 'Επιβεβαίωση email' : (signup ? 'Δημιουργία λογαριασμού' : (pageMode.admin ? 'Σύνδεση διαχείρισης' : 'Σύνδεση στην εφαρμογή'));
  app.innerHTML = '<div class="login-page"><section class="login-story"><div class="brand"><span class="brand-mark">⏱</span><span>' + esc(APP_NAME) + '</span></div>' +
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
async function enterApp() {
  const token = ++state.sessionLoadToken;
  const context = await api.context(); if (token !== state.sessionLoadToken) return;
  if (pageMode.admin && !['admin', 'reviewer'].includes(context.role)) {
    await api.signOut();
    throw new Error('Αυτός ο λογαριασμός δεν έχει πρόσβαση στη διαχείριση. Συνδέσου με το προσωπικό email διαχειριστή.');
  }
  state.browserGate = null; state.browserPollAt = 0;
  state.context = context; setServerTime(context.server_now); state.lastActivity = Date.now();
  restorePending(); state.view = pageMode.admin ? 'overview' : (VIEWS.find(function(v) { return v[3].includes(context.role); })?.[0] || 'overview');
  if (state.pendingBrowserRequest && isOwner()) state.view = 'settings';
  state.month ||= today().slice(0, 7); state.historyFrom ||= today().slice(0, 7) + '-01'; state.historyTo ||= today();
  reconcileSelections();
  renderShell(); await loadView(state.view);
  if (token === state.sessionLoadToken && state.pendingBrowserRequest && isOwner()) await reviewBrowserLink();
}
function renderShell() {
  const ctx = state.context;
  document.body.classList.toggle('employee-kiosk', isOperator());
  if (isOperator()) {
    app.innerHTML = '<div class="kiosk-shell"><header class="kiosk-header"><h1>⏱ ' + esc(APP_NAME) + '</h1><nav class="kiosk-nav" aria-label="Κύρια πλοήγηση">' +
      '<button class="kiosk-nav-button active" type="button" data-action="kiosk-home" aria-current="page">🏠 Κατάστημα</button><a class="kiosk-nav-button kiosk-admin-link" href="' + esc(pageMode.adminUrl) + '">🔒 Διαχείριση</a></nav></header>' +
      '<div id="uncertain" class="uncertain-banner hidden" role="alert"></div><main id="main" class="kiosk-main" tabindex="-1"></main></div>';
    renderUncertain(); return;
  }
  const navigation = VIEWS.filter(function(v) { return v[3].includes(ctx.role); }).map(function(v) {
    return '<button type="button" class="nav-button ' + (v[0] === state.view ? 'active' : '') + '" data-action="navigate" data-view="' + v[0] + '" title="' + esc(v[1]) + '"><span class="nav-icon" aria-hidden="true">' + v[2] + '</span><span class="nav-label">' + v[1] + '</span>' +
      (v[0] === 'requests' ? '<span class="nav-counter" id="request-counter">—</span>' : '') + '</button>';
  }).join('');
  app.innerHTML = '<div class="shell"><aside class="sidebar" id="sidebar"><div class="brand"><span class="brand-mark">⏱</span><span class="brand-text">' + esc(APP_NAME) + '</span></div><nav aria-label="Κύρια πλοήγηση">' + navigation + '</nav>' +
    '<div class="sidebar-footer"><div class="account-name">' + esc(ctx.display_name || ctx.username || ctx.email) + '</div><div class="account-role">' + esc(ROLES[ctx.role] || ctx.role) + (ctx.is_owner ? ' · Ιδιοκτήτης' : '') + '</div><button type="button" data-action="logout">Αποσύνδεση ↗</button></div></aside>' +
    '<div class="main-wrap"><header class="topbar"><button class="icon-button mobile-menu-toggle" type="button" data-action="toggle-menu" aria-label="Μενού" aria-expanded="false">☰</button><span class="header-title-mobile">' + esc(APP_NAME) + '</span><div class="breadcrumb">Χώρος εργασίας <span aria-hidden="true">/</span> <strong id="current-view-name">' + esc(VIEWS.find(function(v) { return v[0] === state.view; })?.[1] || '') + '</strong></div>' +
    '<div class="header-actions">' + (pageMode.admin ? button('🏠 Κατάστημα', 'return-shop', '', 'small return-shop-button') : '') + '<span id="connection" class="connection">Συνδεδεμένο</span><time class="live-clock mono"></time><button class="icon-button" type="button" data-action="refresh" aria-label="Ανανέωση" title="Ανανέωση">↻</button></div></header><div id="browser-link-notice" class="browser-link-notice">' + browserLinkNotice() + '</div><div id="uncertain" class="uncertain-banner hidden" role="alert"></div><main id="main" tabindex="-1"></main></div></div>';
  renderUncertain(); tick();
}
async function loadOverview() {
  return api.read('overview', {});
}
async function loadView(view, silent = false) {
  if (!state.context) return;
  const token = ++state.loadToken; const main = document.getElementById('main');
  const selection = { selectedId: state.selectedId, personToken: state.personToken, historyId: state.historyId, statsId: state.statsId, month: state.month, requestStatus: state.requestStatus, requestEmployee: state.requestEmployee };
  function isCurrent() {
    if (!state.context || token !== state.loadToken || state.view !== view) return false;
    if (view === 'record') return selection.selectedId === state.selectedId && selection.personToken === state.personToken;
    if (view === 'history') return selection.historyId === state.historyId;
    if (view === 'stats') return selection.statsId === state.statsId && selection.month === state.month;
    if (view === 'requests') return selection.requestStatus === state.requestStatus && selection.requestEmployee === state.requestEmployee;
    return true;
  }
  if (!silent) main.innerHTML = loading();
  if (view === 'history' && String(state.historyData?.employee?.id || '') !== String(selection.historyId)) state.historyData = null;
  if (view === 'stats' && (String(state.monthData?.employee?.id || '') !== String(selection.statsId) || state.monthData?.month !== selection.month)) state.monthData = null;
  try {
    const updates = {}; let serverTime = null;
    if (view === 'record' || view === 'overview') {
      const results = await Promise.all([loadOverview(), view === 'record' && selection.selectedId ? api.read('employee', { employee_id: selection.selectedId }) : Promise.resolve(null)]);
      updates.overview = results[0]; serverTime = results[0].server_now;
      if (results[1]) { updates.employeeData = results[1]; serverTime = results[1].server_now || serverTime; }
    } else if (view === 'history' && selection.historyId) {
      updates.historyData = await api.read('employee', { employee_id: selection.historyId }); serverTime = updates.historyData.server_now;
    } else if (view === 'requests') {
      updates.requests = await api.read('requests', { status: selection.requestStatus || undefined, employee_id: selection.requestEmployee || undefined }); serverTime = updates.requests.server_now;
    } else if (view === 'stats' && selection.statsId) {
      updates.monthData = await api.read('month', { employee_id: selection.statsId, month: selection.month }); serverTime = updates.monthData.server_now;
    } else if (view === 'settings') {
      const results = await Promise.all([api.read('admin', {}), isOwner() ? api.listBrowsers().catch(function(error) { return { devices: [], error: error.message || 'Δεν φορτώθηκαν οι εγκρίσεις browser.' }; }) : Promise.resolve(null)]);
      updates.adminData = results[0]; updates.browserData = results[1]; serverTime = updates.adminData.server_now || updates.browserData?.server_now;
    } else if (view === 'audit') {
      const data = await api.read('audit', { limit: 100 }); updates.audit = data.rows || []; updates.auditCursor = data.next_cursor; serverTime = data.server_now;
    }
    if (!isCurrent()) return;
    Object.assign(state, updates); setServerTime(serverTime);
    if (updates.overview) { const count = document.getElementById('request-counter'); if (count) count.textContent = String(updates.overview.pending_count || 0); }
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
    state.context = context; setServerTime(context.server_now);
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
    ['break_start', '☕ Διάλειμμα Έναρξη'], ['break_end', '🔙 Διάλειμμα Επιστροφή']
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
    '<div class="state-panel">' + badgeForState(s) + ' ' + pendingBadge(s.pending_count) + '<p>' + esc(stateDescription) + '</p>' +
    (s.open_break_at ? '<p class="strong mono" data-elapsed="' + esc(s.open_break_at) + '"></p>' : '') + '</div>' +
    (issues.length ? banner('Χρειάζονται διορθώσεις για να συνεχίσεις.' + '<ul class="issue-list">' + issues.slice(0, 3).map(function(i) { return '<li>' + esc(i.message || 'Έλεγξε την ακολουθία ενεργειών.') + '</li>'; }).join('') + '</ul>', 'warning') : '') +
    '<div class="action-grid">' +
    '<button class="attendance-button clock-in" type="button" data-action="record-action" data-type="clock_in" data-mutate><span>↗</span>Είσοδος</button>' +
    '<button class="attendance-button break-start" type="button" data-action="record-action" data-type="break_start" data-mutate><span>☕</span>Έναρξη διαλείμματος</button>' +
    '<button class="attendance-button break-end" type="button" data-action="record-action" data-type="break_end" data-mutate><span>↶</span>Επιστροφή</button>' +
    '<button class="attendance-button clock-out" type="button" data-action="record-action" data-type="clock_out" data-mutate><span>↗</span>Έξοδος</button></div>' +
    '<div class="actions">' + button('Αίτημα διόρθωσης', 'open-correction', 'data-id="' + esc(e.id) + '"', 'text') + (state.context.role === 'operator' ? '' : button('Ιστορικό', 'person-history', 'data-id="' + esc(e.id) + '"', 'text')) + '</div>' +
    '<h3 class="muted">Τελευταίες κινήσεις</h3><ul class="recent-list">' + recent.map(function(ev) { return '<li><span>' + esc(ACTIONS[ev.type]) + (ev.status === 'pending' ? ' <small>· σε αναμονή</small>' : '') + '</span><span class="mono">' + esc(displayTime(ev.event_at)) + '<small> · ' + esc(displayDate(ev.event_at)) + '</small></span></li>'; }).join('') + '</ul>' +
    '<p class="field-help">Οι διορθώσεις προσμετρώνται προσωρινά. Μπορείς να συνεχίσεις όταν έχουν καλυφθεί όλες οι ελλείψεις.</p>';
}
function renderOverview() {
  const rows = state.overview?.employees || [];
  const groups = [['IN', 'Μέσα', 'green'], ['ON_BREAK', 'Σε διάλειμμα', 'amber'], ['OUT', 'Εκτός', '']];
  const counts = groups.map(function(g) { return rows.filter(function(e) { return stateOf(e).state === g[0]; }).length; });
  return heading('Ζωντανή εικόνα', 'Η κατάσταση της ομάδας με εγκεκριμένες και εκκρεμείς διορθώσεις.') +
    '<div class="metric-grid">' + metric('Μέσα στην εργασία', counts[0], 'Ενεργές βάρδιες') + metric('Σε διάλειμμα', counts[1], 'Ανοιχτά διαλείμματα') + metric('Εκτός', counts[2], 'Χωρίς ανοιχτή βάρδια') + metric('Εκκρεμείς διορθώσεις', state.overview?.pending_count || 0, 'Προς έλεγχο') + '</div>' +
    (rows.some(function(e) { return stateOf(e).valid === false; }) ? banner('Υπάρχουν ακολουθίες που χρειάζονται έλεγχο. Άνοιξε τον εργαζόμενο για τις ελλείψεις.', 'warning') : '') +
    '<div class="overview-columns">' + groups.map(function(g) {
      const list = rows.filter(function(e) { return stateOf(e).state === g[0]; });
      return '<section class="overview-group"><h3>' + esc(g[1]) + '<span class="badge ' + g[2] + '">' + list.length + '</span></h3>' + (list.length ? list.map(function(e) {
        const s = stateOf(e);
        return '<button type="button" class="person-row" data-action="' + (canRecord() ? 'select-person-from-overview' : 'person-history') + '" data-id="' + esc(e.id) + '">' + avatar(e) +
          '<div><span class="strong">' + esc(e.name) + '</span><small>' + esc(e.department || 'Ομάδα') + (s.open_break_at ? ' · <span data-elapsed="' + esc(s.open_break_at) + '"></span>' : '') + '</small></div>' +
          (s.valid === false ? '<span class="badge red">Έλεγχος</span>' : pendingBadge(s.pending_count)) + '</button>';
      }).join('') : '<p class="muted">Κανένας εργαζόμενος.</p>') + '</section>';
    }).join('') + '</div><p class="footer-note">Ανανέωση ανά 30 δευτερόλεπτα · Ώρα Ελλάδας</p>';
}
function metric(label, value, foot) { return '<div class="metric"><div class="metric-label">' + esc(label) + '</div><div class="metric-value mono">' + esc(value) + '</div><div class="metric-foot">' + esc(foot) + '</div></div>'; }
function filteredHistory() {
  return (state.historyData?.events || []).filter(function(ev) {
    const day = dateKey(ev.event_at);
    return (!state.historyFrom || day >= state.historyFrom) && (!state.historyTo || day <= state.historyTo) && (!state.historyStatus || ev.status === state.historyStatus) && (!state.historyType || ev.type === state.historyType);
  }).slice().reverse();
}
function renderHistory() {
  if (!state.historyId) return heading('Καταγραφές', 'Το ιστορικό κινήσεων κάθε εργαζομένου.') + '<div class="card">' + empty('Δεν υπάρχουν εργαζόμενοι', 'Πρόσθεσε πρώτα το προσωπικό.') + '</div>';
  const rows = filteredHistory();
  const filters = '<div class="filter-row">' + selectField('Εργαζόμενος', 'history_employee', employeeOptions(state.historyId)) +
    field('Από', 'history_from', state.historyFrom, 'date') + field('Έως', 'history_to', state.historyTo, 'date') +
    selectField('Κατάσταση', 'history_status', option('', 'Όλες', state.historyStatus) + Object.entries(STATUS).map(function(p) { return option(p[0], p[1], state.historyStatus); }).join('')) +
    selectField('Ενέργεια', 'history_type', option('', 'Όλες', state.historyType) + Object.entries(ACTIONS).map(function(p) { return option(p[0], p[1], state.historyType); }).join('')) + '</div>';
  return heading('Καταγραφές', 'Πλήρες ιστορικό, με διακριτές τις εκκρεμείς και τις ακυρωμένες κινήσεις.', canRecord() ? button('Νέα διόρθωση', 'open-correction', 'data-id="' + esc(state.historyId) + '"', 'primary') : '') +
    '<section class="card">' + filters + '<div id="bulk-bar" class="bulk-bar hidden"><span id="bulk-label"></span>' + button('Ακύρωση επιλεγμένων', 'void-selected', 'data-mutate', 'danger small') + '</div>' +
    (state.historyData?.history_limited ? '<p class="field-help">Στο τερματικό εμφανίζονται έως 200 πρόσφατες κινήσεις. Το πλήρες ιστορικό είναι διαθέσιμο στη διαχείριση.</p>' : '') +
    (rows.length ? '<div class="table-wrap"><table><thead><tr>' + (isAdmin() ? '<th><input type="checkbox" id="select-all-events" aria-label="Επιλογή όλων"></th>' : '') + '<th>Ημερομηνία & ώρα</th><th>Ενέργεια</th><th>Κατάσταση</th><th>Σημείωση</th>' + (isAdmin() ? '<th></th>' : '') + '</tr></thead><tbody>' + rows.map(function(ev) {
      const editable = ['approved', 'pending'].includes(ev.status);
      return '<tr>' + (isAdmin() ? '<td>' + (editable ? '<input type="checkbox" class="event-check" value="' + esc(ev.id) + '" aria-label="Επιλογή κίνησης">' : '') + '</td>' : '') +
        '<td class="mono">' + esc(displayDate(ev.event_at)) + '<br><strong>' + esc(displayTime(ev.event_at, true)) + '</strong></td><td>' + esc(ACTIONS[ev.type] || ev.type) + '</td><td>' + eventStatusBadge(ev) + '</td><td class="wrap">' + esc(ev.reason || '—') + (ev.source === 'admin' || ev.source === 'admin_edit' ? '<small class="shift-line">Ώρα διαχειριστή</small>' : '') + '</td>' +
        (isAdmin() ? '<td>' + (editable ? button('Αλλαγή ώρας', 'edit-event', 'data-id="' + esc(ev.id) + '"', 'small') : '') + '</td>' : '') + '</tr>';
    }).join('') + '</tbody></table></div><div class="table-footer"><span>' + rows.length + ' καταγραφές</span><span>Οι ακυρώσεις διατηρούνται στο ιστορικό.</span></div>' : empty('Δεν υπάρχουν κινήσεις', 'Άλλαξε τα φίλτρα ή επίλεξε διαφορετικό εργαζόμενο.')) + '</section>';
}
function renderRequests() {
  const rows = state.requests?.events || [];
  return heading('Διορθώσεις', 'Έλεγξε τις προτεινόμενες κινήσεις και την ακολουθία στην οποία ανήκουν.') +
    '<section class="card"><div class="filter-row">' + selectField('Κατάσταση', 'request_status', option('', 'Όλες', state.requestStatus) + Object.entries(STATUS).filter(function(p) { return p[0] !== 'void'; }).map(function(p) { return option(p[0], p[1], state.requestStatus); }).join('')) +
    selectField('Εργαζόμενος', 'request_employee', employeeOptions(state.requestEmployee, true)) + '</div>' +
    (rows.length ? '<div class="table-wrap"><table><thead><tr><th>Εργαζόμενος</th><th>Ενέργεια</th><th>Προτεινόμενη ώρα</th><th>Αίτημα</th><th>Κατάσταση</th><th></th></tr></thead><tbody>' + rows.map(function(ev) {
      return '<tr><td><strong>' + esc(ev.employee_name || personName(ev.employee_id)) + '</strong></td><td>' + esc(ACTIONS[ev.type] || ev.type) + '</td><td class="mono">' + esc(displayDate(ev.event_at)) + '<br>' + esc(displayTime(ev.event_at, true)) + '</td><td class="wrap">' + esc(ev.reason || '—') + '<small class="shift-line">' + esc(displayDate(ev.created_at)) + ' ' + esc(displayTime(ev.created_at)) + '</small></td><td>' + statusBadge(ev.status) + '</td><td>' +
        (ev.status === 'pending' && isAdmin() ? button('Έλεγχος', 'review-event', 'data-id="' + esc(ev.id) + '"', 'small primary') : button('Ιστορικό', 'person-history', 'data-id="' + esc(ev.employee_id) + '"', 'small')) + '</td></tr>';
    }).join('') + '</tbody></table></div>' : empty('Η λίστα είναι καθαρή', 'Δεν υπάρχουν αιτήματα με τα επιλεγμένα φίλτρα.')) + '</section>';
}
function timeCell(iso, id, employeeId, context = {}) {
  const text = esc(displayTime(iso));
  if (!isAdmin()) return '<span class="mono">' + text + '</span>';
  const day = iso ? dateKey(iso) : context.date;
  return '<button type="button" class="time-button mono' + (!iso ? ' empty-time' : '') + '" data-action="admin-day" data-id="' + esc(id || '') + '" data-employee="' + esc(employeeId) + '" data-date="' + esc(day || today()) + '" data-type="' + esc(context.type || '') + '" data-shift="' + esc(context.shift_ref || '') + '" data-break="' + esc(context.break_ref || '') + '"' + (iso ? ' data-time="' + esc(iso) + '"' : '') + '>' + (iso ? text : '+ ' + esc(ACTIONS[context.type] || 'Ώρα')) + '</button>';
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
  const marker = saved?.status === 'draft' ? '<span class="badge">Πρόχειρη · αναμονή προϋποθέσεων</span>' : (saved && isScheduledEvent(saved) ? '<span class="badge planned">Ορισμένη ώρα</span>' : (saved?.source === 'admin' ? '<span class="badge">Από διαχειριστή</span>' : ''));
  if (slot.readonly) return '<section class="admin-slot anchor"><div class="admin-slot-title"><strong>' + esc(label) + '</strong><span class="badge">Άλλη ημέρα</span></div><p class="mono">' + esc(displayDate(saved.event_at)) + ' · ' + esc(displayTime(saved.event_at, true)) + '</p><small>Η αρχική κίνηση διατηρείται. Άλλαξέ την από την αντίστοιχη ημέρα.</small></section>';
  return '<section class="admin-slot' + (slot.remove ? ' removed' : '') + '" data-admin-slot="' + esc(slot.key) + '"><div class="admin-slot-title"><strong>' + esc(label) + '</strong>' + marker +
    (saved ? button(slot.remove ? 'Επαναφορά' : 'Ακύρωση', 'admin-remove-slot', 'data-key="' + esc(slot.key) + '"', 'text small') : '') + '</div>' +
    (slot.remove ? '<p class="muted">Θα ακυρωθεί με την αποθήκευση. Το ιστορικό διατηρείται.</p>' : '<div class="admin-time-fields">' +
      field('Ημερομηνία', prefix + '_date', slot.date, 'date', 'data-dst="' + esc(prefix) + '"') +
      field('Ώρα Αθήνας', prefix + '_time', slot.time, 'time', 'step="1" data-dst="' + esc(prefix) + '"') +
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
  const body = banner('Μπορείς να ορίσεις ώρες χωρίς προηγούμενα χτυπήματα. Οι μελλοντικές ώρες ισχύουν όταν φτάσει η ώρα τους. Ελλιπείς νέες κινήσεις μένουν πρόχειρες μέχρι να συμπληρωθούν οι προϋποθέσεις.', '') +
    '<div class="admin-day-groups">' + model.groups.map(function(group, index) {
      return '<section class="admin-shift"><div class="admin-shift-title"><h3>' + (index + 1) + 'η βάρδια</h3></div><div class="admin-shift-ends">' + adminSlotHtml(group.entry, group) + adminSlotHtml(group.exit, group) + '</div>' +
        '<div class="admin-breaks">' + group.breaks.map(function(br, i) { return '<div class="admin-break"><h4>' + (i + 1) + 'ο διάλειμμα</h4><div class="admin-shift-ends">' + adminSlotHtml(br.start, group, br) + adminSlotHtml(br.end, group, br) + '</div></div>'; }).join('') + '</div>' +
        button('+ Νέο διάλειμμα', 'admin-add-break', 'data-group="' + esc(group.id) + '"', 'text small') + '</section>';
    }).join('') + '</div>' + button('+ Νέα βάρδια', 'admin-add-shift', '', 'text') +
    '<div class="field"><label for="f-admin_reason">Αιτιολογία καταχώρησης</label><textarea name="admin_reason" id="f-admin_reason" required minlength="3" maxlength="1000" placeholder="Π.χ. ορισμός ωρών από τον διαχειριστή">' + esc(model.reason || '') + '</textarea></div>' +
    '<p class="field-help">Συμπλήρωσε μόνο όσα θέλεις να ορίσεις. Τα κενά πεδία παραμένουν διαθέσιμα και δεν δημιουργούν χτυπήματα. Οι αλλαγές αποθηκεύονται όλες μαζί.</p>';
  openModal('Ώρες ημέρας', personName(model.employeeId) + ' · ' + dateDisplay(model.date), body, submitButton('Αποθήκευση ωρών'), 'admin-day');
}
async function openAdminDay(employeeId, date, preferred = {}) {
  if (!isAdmin() || !employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return;
  const token = ++state.adminDayLoadToken;
  const view = state.view, selected = view === 'stats' ? state.statsId : (view === 'history' ? state.historyId : null);
  try {
    const data = await api.read('admin_day', { employee_id: employeeId, date });
    if (token !== state.adminDayLoadToken || !isAdmin() || state.view !== view || (view === 'stats' && state.statsId !== selected) || (view === 'history' && state.historyId !== selected)) return;
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
      if (!slot.time) { if (slot.original?.event_at) throw new Error('Για να αφαιρέσεις υπάρχουσα ώρα, επίλεξε Ακύρωση στην αντίστοιχη κίνηση.'); continue; }
      const originalValues = slot.original?.event_at ? dateTimeValues(slot.original.event_at) : null;
      const normalizedTime = /^\d{2}:\d{2}$/.test(slot.time) ? slot.time + ':00' : slot.time;
      const unchangedClock = originalValues && originalValues.date === slot.date && originalValues.time === normalizedTime && slot.occurrence === slot.initial_occurrence;
      const at = unchangedClock ? slot.original.event_at : localToIso(slot.date, slot.time, { disambiguation: slot.occurrence || 'reject' });
      const br = group.breaks.find(function(b) { return b.start === slot || b.end === slot; });
      if (slot.original && at === slot.original.event_at && slot.closes_open_break === Boolean(slot.original.closes_open_break)) continue;
      entries.push({ id: slot.id, type: slot.type, event_at: at, shift_ref: group.id,
        ...(br ? { break_ref: br.id } : {}), ...(slot.type === 'clock_out' ? { closes_open_break: slot.closes_open_break } : {}) });
    }
  }
  return entries;
}
function renderStats() {
  const data = state.monthData;
  if (!state.statsId) return heading('Παρουσιολόγιο', 'Ώρες παρουσίας, διαλείμματα και ημερήσιες σημειώσεις.') + '<section class="card">' + empty('Δεν υπάρχουν εργαζόμενοι', 'Πρόσθεσε πρώτα το προσωπικό.') + '</section>';
  state.stats = data ? monthlyStats(data.events || [], {
    month: state.month, employee: data.employee, notes: data.notes || [], settings: data.settings || state.context.settings,
    now: now(), includePending: state.statsMode === 'effective'
  }) : null;
  const stats = state.stats;
  const projected = data ? monthlyStats(data.events || [], { month: state.month, employee: data.employee, notes: data.notes || [], settings: data.settings || state.context.settings,
    now: now(), includePending: state.statsMode === 'effective', includeScheduled: true }) : null;
  const previewDays = new Map((projected?.days || []).map(function(day) { return [day.date, day]; }));
  const rawEvents = data?.events || [];
  const rawById = new Map(rawEvents.map(function(e) { return [String(e.id), e]; }));
  const due = rawEvents.filter(isScheduledEvent).map(function(e) { return Date.parse(e.event_at); });
  state.nextScheduledRefresh = due.length ? Math.min(...due) : 0;
  const totals = stats?.totals || {};
  return heading('Παρουσιολόγιο', 'Οι ώρες περιλαμβάνουν τα διαλείμματα. Οι ανοιχτές βάρδιες εμφανίζονται χωριστά.', button('Εξαγωγή CSV', 'export-stats', stats ? '' : 'disabled')) +
    '<section class="card"><div class="filter-row">' + selectField('Εργαζόμενος', 'stats_employee', employeeOptions(state.statsId)) +
    field('Μήνας', 'stats_month', state.month, 'month', 'required') + selectField('Υπολογισμός', 'stats_mode', option('effective', 'Μαζί με τις εκκρεμείς διορθώσεις', state.statsMode) + option('approved', 'Μόνο εγκεκριμένες καταγραφές', state.statsMode)) + '</div>' +
    (stats?.has_pending && state.statsMode === 'effective' ? banner('Τα σύνολα περιλαμβάνουν εκκρεμείς διορθώσεις και παραμένουν προσωρινά μέχρι να ελεγχθούν.', 'warning') : '') +
    (projected?.has_scheduled ? banner('Οι ορισμένες μελλοντικές ώρες εμφανίζονται με μπλε ένδειξη. Θα ισχύσουν όταν φτάσει η ώρα τους και δεν προστίθενται πρόωρα στα σημερινά σύνολα.') : '') +
    (stats?.issues?.length ? banner('Υπάρχουν κινήσεις που χρειάζονται έλεγχο. Οι ακολουθίες που δεν ολοκληρώνονται σωστά δεν υπολογίζονται ως πλήρης παρουσία.', 'warning') : '') +
    '<div class="metric-grid">' + metric('Ώρες παρουσίας', formatMinutes(totals.gross_minutes || 0), (totals.worked_days || 0) + ' ημέρες με ολοκληρωμένη παρουσία') +
    metric('Διαλείμματα', formatMinutes(totals.break_minutes || 0), (totals.break_count || 0) + ' διαλείμματα · δεν αφαιρούνται') +
    metric('Καθυστέρηση', formatMinutes(totals.late_minutes || 0), 'Βάσει ωραρίου και ανοχής') +
    metric('Διαφορά από στόχο', formatMinutes(totals.variance_minutes || 0), 'Δεν αποτελεί υπολογισμό νόμιμης υπερωρίας') + '</div>' +
    (stats ? '<div class="table-wrap"><table><thead><tr><th>Ημέρα</th><th>Βάρδιες</th><th>Διαλείμματα</th><th>Παρουσία</th><th>Καθυστέρηση</th><th>Σημειώσεις</th></tr></thead><tbody>' +
    stats.days.map(function(day) {
      const preview = previewDays.get(day.date) || day;
      const drafts = rawEvents.filter(function(e) { return e.status === 'draft' && (e.admin_day || dateKey(e.event_at)) === day.date; });
      const planned = rawEvents.some(function(e) { return isScheduledEvent(e) && dateKey(e.event_at) === day.date; });
      const dayAttrs = 'data-employee="' + esc(state.statsId) + '" data-date="' + esc(day.date) + '"';
      return '<tr class="' + (day.pending_count ? 'subtle-row' : '') + '"><td class="' + ([0, 6].includes(day.weekday) ? 'day-weekend' : '') + '"><strong class="mono">' + esc(dateDisplay(day.date)) + '</strong><span class="day-name">' + esc(shortDay(day.date)) + '</span>' + (isAdmin() ? button('Ώρες ημέρας', 'admin-day', dayAttrs, 'text small') : '') + '</td>' +
      '<td>' + (preview.shifts.length ? preview.shifts.map(function(shift, index) {
        return '<span class="shift-line">' + (index ? '<small>' + (index + 1) + 'η · </small>' : '') + timeCell(shift.start_at, shift.start_id, state.statsId, { date: day.date, type: 'clock_in', shift_ref: shift.start_id }) + ' → ' + timeCell(shift.end_at, shift.end_id, state.statsId, { date: day.date, type: 'clock_out', shift_ref: shift.start_id }) +
          (shift.pending ? ' <span class="badge amber">Προσωρινή</span>' : '') +
          ([shift.start_id, shift.end_id].some(function(id) { return isScheduledEvent(rawById.get(String(id))); }) ? ' <span class="badge planned">Ορισμένη ώρα</span>' : '') +
          (shift.carried_in ? '<small class="break-line">Από ' + esc(displayDate(shift.start_at)) + '</small>' : '') +
          (!shift.closed ? '<small class="break-line">Χωρίς έξοδο · ανοιχτή βάρδια</small>' : (shift.carried_out ? '<small class="break-line">Έως ' + esc(displayDate(shift.end_at)) + '</small>' : '')) +
          (isAdmin() ? button('+ Διάλειμμα', 'admin-day', dayAttrs + ' data-add="break" data-shift="' + esc(shift.start_id || '') + '"', 'text small') : '') + '</span>';
      }).join('') : timeCell(null, null, state.statsId, { date: day.date, type: 'clock_in' }) + ' → ' + timeCell(null, null, state.statsId, { date: day.date, type: 'clock_out' })) +
      (isAdmin() && preview.shifts.length ? button('+ Βάρδια', 'admin-day', dayAttrs + ' data-add="shift"', 'text small') : '') +
      drafts.map(function(e) { return '<small class="draft-line">Πρόχειρη: ' + esc(ACTIONS[e.type]) + ' ' + esc(displayTime(e.event_at)) + (isAdmin() ? ' ' + button('Συμπλήρωση', 'admin-day', dayAttrs + ' data-id="' + esc(e.id) + '"', 'text small') : '') + '</small>'; }).join('') + '</td>' +
      '<td>' + (preview.shifts.flatMap(function(shift) { return (shift.breaks || []).map(function(br) { return { ...br, shift_ref: shift.start_id }; }); }).map(function(br) {
        return '<span class="break-line">' + timeCell(br.start_at, br.start_id, state.statsId, { date: day.date, type: 'break_start', shift_ref: br.shift_ref, break_ref: br.start_id }) + ' → ' + timeCell(br.end_at, br.generated_end ? null : br.end_id, state.statsId, { date: day.date, type: 'break_end', shift_ref: br.shift_ref, break_ref: br.start_id }) +
          (br.generated_end ? ' <small>Κλείσιμο με την έξοδο</small>' : '') + (!br.closed ? ' · ανοιχτό' : ' · ' + esc(formatMinutes(br.minutes))) + '</span>';
      }).join('') || timeCell(null, null, state.statsId, { date: day.date, type: 'break_start', shift_ref: preview.shifts[0]?.start_id }) + ' → ' + timeCell(null, null, state.statsId, { date: day.date, type: 'break_end', shift_ref: preview.shifts[0]?.start_id })) +
      (day.break_count ? '<small class="break-line">Σύνολο: ' + esc(formatMinutes(day.break_minutes)) + (day.break_excess_minutes ? ' · υπέρβαση ' + esc(formatMinutes(day.break_excess_minutes)) : '') + '</small>' : '') + '</td>' +
      '<td><strong class="mono">' + (day.gross_minutes ? esc(formatMinutes(day.gross_minutes)) : '—') + '</strong>' +
        (planned && preview.gross_minutes ? '<small class="planned-line">Ορισμένη παρουσία: ' + esc(formatMinutes(preview.gross_minutes)) + '</small>' : '') +
        (day.has_open_shift ? '<small class="break-line">Ανοιχτή: ' + esc(formatMinutes(day.estimated_open_minutes)) + '</small>' : '') +
        (day.pending_count ? '<small class="break-line">' + day.pending_count + ' εκκρεμείς κινήσεις</small>' : '') + '</td>' +
      '<td class="mono">' + (day.late_minutes ? esc(formatMinutes(day.late_minutes)) : '—') + '</td><td>' +
        (isAdmin() ? '<button type="button" class="note-chip" data-action="edit-note" data-date="' + esc(day.date) + '">' : '<span class="note-chip">') +
        (day.note ? '<strong>' + esc(NOTES[day.note.kind] || 'Σημείωση') + '</strong>' + (day.note.text ? '<br>' + esc(day.note.text) : '') : (isAdmin() ? '+ Σημείωση' : '—')) +
        (isAdmin() ? '</button>' : '</span>') + '</td></tr>';
    }).join('') + '</tbody></table></div>' : empty('Επίλεξε μήνα και εργαζόμενο', 'Τα σύνολα θα εμφανιστούν εδώ.')) +
    '</section><p class="footer-note">Ημερολογιακή κατανομή σε ώρα Ελλάδας · Οι νυχτερινές βάρδιες συνδέονται κανονικά μεταξύ ημερών.</p>';
}
function renderEmployees() {
  const rows = (state.context?.employees || []).filter(function(e) { return state.showArchived || !e.archived; });
  return heading('Προσωπικό', 'Η ομάδα, τα τμήματα και οι ατομικές ρυθμίσεις ωραρίου.', isAdmin() ? button('Προσθήκη εργαζομένου', 'edit-employee', '', 'primary') : '') +
    '<section class="card"><div class="card-heading"><h2>' + rows.length + ' εργαζόμενοι</h2><label class="check-label"><input id="show-archived" type="checkbox"' + (state.showArchived ? ' checked' : '') + '>Εμφάνιση αρχείου</label></div>' +
    (rows.length ? '<div class="table-wrap"><table><thead><tr><th>Εργαζόμενος</th><th>Τμήμα</th><th>Ωράρια</th><th>Βάρδιες / ημέρα</th><th>Κατάσταση</th><th></th></tr></thead><tbody>' +
      rows.map(function(e) {
        return '<tr><td><div class="employee-table-name">' + avatar(e) + '<strong>' + esc(e.name) + '</strong></div></td><td>' + esc(e.department || '—') + '</td><td class="mono">' + esc(e.shift1_start?.slice(0, 5) || '—') + (e.shift2_start ? ' / ' + esc(e.shift2_start.slice(0, 5)) : '') + '<small class="break-line">Ανοχή ' + esc(e.lateness_tolerance_minutes || 0) + ' λεπτά</small></td><td>' + esc(e.max_daily_shifts) + '</td><td>' + (e.archived ? '<span class="badge">Αρχείο</span>' : '<span class="badge green">Ενεργός</span>') + '</td><td><div class="actions">' +
          (isAdmin() ? button('Επεξεργασία', 'edit-employee', 'data-id="' + esc(e.id) + '"', 'small') + button(e.archived ? 'Επαναφορά' : 'Αρχειοθέτηση', 'archive-employee', 'data-id="' + esc(e.id) + '" data-archived="' + !e.archived + '" data-mutate', 'small') : button('Ιστορικό', 'person-history', 'data-id="' + esc(e.id) + '"', 'small')) + '</div></td></tr>';
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
    selectField('Προεπιλογή βαρδιών ανά ημέρα', 'default_max_daily_shifts', option('1', '1 βάρδια', settings.default_max_daily_shifts) + option('2', '2 βάρδιες', settings.default_max_daily_shifts)) +
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
  const labels = { record: 'Καταγραφή', correction: 'Αίτημα διόρθωσης', review: 'Έλεγχος διόρθωσης', event_edit: 'Αλλαγή ώρας', event_void: 'Ακύρωση κινήσεων', employee_save: 'Αλλαγή προσωπικού', employee_archive: 'Αρχειοθέτηση / επαναφορά', settings_save: 'Αλλαγή ρυθμίσεων', note_save: 'Σημείωση ημέρας', note_delete: 'Αφαίρεση σημείωσης', member_save: 'Αλλαγή πρόσβασης' };
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
function suggestionFrom(error, fallbackState, type) {
  const details = error?.details || {};
  const current = details.state && typeof details.state === 'object' ? details.state : fallbackState;
  let plan;
  try { plan = planNext(current || { state: 'OUT' }, type, { now: now(), maxDailyShifts: employee(state.selectedId)?.max_daily_shifts }); } catch {}
  let actions = details.expected_actions || details.issues?.[0]?.expected_actions || current?.issues?.[0]?.expected_actions || plan?.expected_actions || [];
  if (!Array.isArray(actions)) actions = [];
  const at = current?.open_break_at || current?.open_shift_at || details.issues?.[0]?.event_at;
  const suggestedDate = details.issues?.[0]?.suggested_date || plan?.suggested_date || (at ? dateKey(at) : today());
  return { actions: actions.filter(function(a) { return ACTIONS[a]; }), date: suggestedDate, current };
}
async function recordAction(type) {
  if (!canRecord() || !state.selectedId) return;
  const id = state.selectedId;
  try {
    const response = await command('record', { employee_id: id, type });
    const result = response?.result || response || {};
    if (isOperator()) closeModal();
    if (result.already_recorded) toast(result.message || (ACTIONS[type] + ' έχει ήδη οριστεί' + (result.event?.event_at ? ' στις ' + displayTime(result.event.event_at) : '') + '.'), 'success');
    else toast(result.message || (ACTIONS[type] + ' καταγράφηκε.'), 'success');
    await loadView('record', true);
  } catch (error) {
    if (state.browserGate || handleBrowserGate(error)) return;
    if (error.uncertain) { if (isOperator()) closeModal(); toast('Η αποθήκευση δεν έχει επιβεβαιωθεί. Χρησιμοποίησε τον έλεγχο στην κορυφή.', 'error'); return; }
    const suggestion = suggestionFrom(error, stateOf(state.employeeData), type);
    const detail = '<p>' + esc(error.message || 'Η ενέργεια χρειάζεται προηγούμενες κινήσεις.') + '</p>' +
      (suggestion.actions.length ? '<p class="muted">Χρειάζονται με τη σειρά:</p><ol class="issue-list">' + suggestion.actions.map(function(a) { return '<li>' + esc(ACTIONS[a]) + '</li>'; }).join('') + '</ol>' : '') +
      (error.details?.issues?.length ? '<ul class="issue-list">' + error.details.issues.slice(0, 5).map(function(i) { return '<li>' + esc(i.message) + '</li>'; }).join('') + '</ul>' : '');
    state.correctionSuggestion = { employeeId: id, ...suggestion };
    const repairable = suggestion.actions.length || error.details?.issues?.length;
    openModal(isOperator() ? '⚠ Προσοχή' : 'Έλεγχος ακολουθίας', personName(id), detail, repairable ? button('Υποβολή διορθώσεων', 'correction-from-warning', '', 'primary') : '');
  }
}
function correctionEntryHtml(index, action = 'clock_in', iso = now()) {
  return '<section class="correction-entry" data-entry="' + index + '"><div class="correction-entry-title"><span>Κίνηση ' + (index + 1) + '</span><button type="button" class="button text small" data-action="remove-correction-entry" data-entry="' + index + '">Αφαίρεση</button></div><div class="correction-grid">' +
    selectField('Ενέργεια', 'entry_' + index + '_type', actionOptions(action)) + dateTimeFields(iso, 'entry_' + index) + '</div></section>';
}
function openCorrection(id, suggestion = null) {
  if (!canRecord() || !id) return;
  const actions = suggestion?.actions?.length ? suggestion.actions : ['clock_in'];
  const defaultDate = suggestion?.date || today();
  let base = now();
  try {
    const open = suggestion?.current?.open_break_at || suggestion?.current?.open_shift_at;
    const hour = open ? displayTime(open) : '12:00';
    base = localToIso(defaultDate, hour, { disambiguation: 'earlier' });
  } catch {}
  state.modalEmployeeId = id; state.correctionEntryCount = actions.length;
  const body = (isOperator() ? '' : banner('Καταχώρησε την πραγματική ώρα κάθε ελλείπουσας κίνησης. Η συνέχεια επιτρέπεται μόλις καλυφθούν όλες οι ελλείψεις.', '')) +
    '<div id="correction-entries">' + actions.map(function(action, index) { return correctionEntryHtml(index, action, base); }).join('') + '</div>' +
    button('+ Προσθήκη κίνησης', 'add-correction-entry', '', 'text') +
    '<div class="field"><label for="f-reason">Σύντομη αιτιολογία</label><textarea id="f-reason" name="reason" maxlength="1000" required placeholder="Π.χ. ξέχασα να καταγράψω την επιστροφή και την έξοδο."></textarea></div>';
  openModal(isOperator() ? '📝 Νέο Αίτημα Διόρθωσης' : 'Αίτημα διόρθωσης', personName(id), body, submitButton(isOperator() ? 'ΑΠΟΣΤΟΛΗ ΠΡΟΣ ADMIN' : 'Υποβολή διορθώσεων'), 'correction');
}
function allKnownEvents() {
  return [state.historyData?.events, state.employeeData?.events, state.monthData?.events, state.requests?.events].flatMap(function(v) { return v || []; });
}
async function openEventEdit(id, employeeId) {
  if (!isAdmin()) return;
  let ev = allKnownEvents().find(function(e) { return String(e.id) === String(id); });
  if (!ev && employeeId) {
    const data = await api.read('employee', { employee_id: employeeId }); state.historyData = data;
    ev = data.events.find(function(e) { return String(e.id) === String(id); });
  }
  if (!ev) { toast('Η κίνηση δεν βρέθηκε. Ανανέωσε την οθόνη.', 'error'); return; }
  if (ev.source === 'admin' || ev.status === 'draft') { await openAdminDay(ev.employee_id, ev.admin_day || dateKey(ev.event_at), { event_id: ev.id, type: ev.type, shift_ref: ev.shift_ref, break_ref: ev.break_ref }); return; }
  state.modalEvent = ev;
  openModal('Αλλαγή ώρας καταγραφής', personName(ev.employee_id) + ' · ' + ACTIONS[ev.type],
    '<div class="form-grid">' + dateTimeFields(ev.event_at, 'edit') + '<div class="field full"><label for="f-reason">Αιτιολογία αλλαγής</label><textarea name="reason" id="f-reason" required maxlength="1000"></textarea></div></div>' +
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
function openEmployee(id) {
  if (!isAdmin()) return;
  const e = employee(id) || {};
  state.modalEmployeeId = e.id || null;
  const departments = [...new Set((state.context.employees || []).map(function(p) { return p.department; }).filter(Boolean))];
  const body = '<div class="form-grid">' + field('Ονοματεπώνυμο', 'name', e.name || '', 'text', 'required maxlength="120" autocomplete="off"') +
    field('Τμήμα', 'department', e.department || '', 'text', 'maxlength="100" list="departments"') +
    '<datalist id="departments">' + departments.map(function(d) { return '<option value="' + esc(d) + '"></option>'; }).join('') + '</datalist>' +
    field('Χρώμα', 'color', /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#2d8d7a', 'color') +
    field('Σειρά εμφάνισης', 'sort_order', e.sort_order ?? 0, 'number', 'min="0" max="100000" required') +
    field('Έναρξη πρώτου ωραρίου', 'shift1_start', e.shift1_start?.slice(0, 5) || '', 'time') +
    field('Έναρξη δεύτερου ωραρίου', 'shift2_start', e.shift2_start?.slice(0, 5) || '', 'time') +
    field('Ανοχή καθυστέρησης · λεπτά', 'lateness_tolerance_minutes', e.lateness_tolerance_minutes || 0, 'number', 'min="0" max="240" required') +
    selectField('Μέγιστες βάρδιες ανά ημέρα', 'max_daily_shifts', option('1', '1 βάρδια', e.max_daily_shifts ?? state.context.settings.default_max_daily_shifts) + option('2', '2 βάρδιες', e.max_daily_shifts ?? state.context.settings.default_max_daily_shifts)) + '</div>';
  openModal(e.id ? 'Επεξεργασία εργαζομένου' : 'Νέος εργαζόμενος', 'Τα ωράρια χρησιμοποιούνται για τον υπολογισμό καθυστέρησης.', body, submitButton('Αποθήκευση'), 'employee');
}
function openVoid(ids) {
  if (!isAdmin() || !ids.length) return;
  if (ids.length > 100) { toast('Επίλεξε έως 100 κινήσεις για μία ακύρωση.', 'error'); return; }
  state.modalVoidIds = ids;
  openModal('Ακύρωση καταγραφών', ids.length + ' επιλεγμένες κινήσεις',
    banner('Οι κινήσεις θα ακυρωθούν και θα παραμείνουν ορατές στο ιστορικό. Η ακύρωση δεν μπορεί να αφήσει άλλες κινήσεις χωρίς τις προϋποθέσεις τους.', 'warning') +
    '<div class="field"><label for="f-reason">Αιτιολογία ακύρωσης</label><textarea id="f-reason" name="reason" maxlength="1000" required></textarea></div>', '<button class="button danger" type="submit" data-submit>Ακύρωση κινήσεων</button>', 'void');
}
function openNote(day) {
  if (!isAdmin() || !state.statsId) return;
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
  const checked = document.querySelectorAll('.event-check:checked').length;
  const box = document.getElementById('bulk-bar'); if (!box) return;
  box.classList.toggle('hidden', checked === 0);
  document.getElementById('bulk-label').textContent = checked + ' επιλεγμένες κινήσεις';
  const all = document.getElementById('select-all-events');
  if (all) { const total = document.querySelectorAll('.event-check').length; all.checked = total > 0 && checked === total; all.indeterminate = checked > 0 && checked < total; }
}
function exportStats() {
  if (!state.stats || !state.monthData) return;
  const rows = [['Εργαζόμενος', 'Ημερομηνία', 'Βάρδιες', 'Παρουσία λεπτά', 'Διαλείμματα λεπτά', 'Καθυστέρηση λεπτά', 'Εκκρεμείς κινήσεις', 'Ανοιχτή βάρδια', 'Κατηγορία σημείωσης', 'Σημείωση']];
  for (const day of state.stats.days) {
    rows.push([state.monthData.employee.name, dateDisplay(day.date), day.shifts.map(function(s) { return displayTime(s.start_at) + '–' + displayTime(s.end_at); }).join(' / '),
      Math.round(day.gross_minutes), Math.round(day.break_minutes), Math.round(day.late_minutes), day.pending_count, day.has_open_shift ? 'Ναι' : 'Όχι', day.note ? NOTES[day.note.kind] : '', day.note?.text || '']);
  }
  const csv = '\ufeff' + rows.map(function(row) {
    return row.map(function(value) { let s = String(value ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }).join(';');
  }).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a'); link.href = url; link.download = 'parousies-' + state.month + '.csv'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}
async function logout(message = '') {
  if (state.busy) return;
  state.authMode = pageMode.admin ? 'admin' : 'device'; state.signup = false; state.authResend = false; state.authRetryRestore = false;
  state.sessionLoadToken++; state.browserCheckToken++; state.browserCheckBusy = false; state.browserGate = null; state.browserData = null; state.browserPollAt = 0;
  closeModal(); state.loadToken++; state.context = null; state.employeeData = null; state.historyData = null; state.monthData = null;
  state.selectedId = ''; state.historyId = ''; state.statsId = ''; state.overview = null; state.requests = null; state.adminData = null; state.adminDay = null; state.adminDayLoadToken++; state.nextScheduledRefresh = 0;
  try { await api.signOut(); } catch {}
  state.authMessage = message; state.authError = false; renderLogin();
}
async function returnToShop() {
  if (!pageMode.admin || state.busy || state.authBusy) return;
  if (state.pendingCommand) { toast('Έλεγξε πρώτα την τελευταία αποθήκευση πριν επιστρέψεις στο κατάστημα.', 'error'); return; }
  state.authBusy = true;
  try {
    await logout();
    window.location.assign(pageMode.shopUrl);
  } finally { state.authBusy = false; }
}
async function handleAction(action, node) {
  if (state.busy || state.authBusy) return;
  if (action === 'return-shop') { await returnToShop(); return; }
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
  if (action === 'person-history') { state.historyId = node.dataset.id; state.historyStatus = ''; await navigate('history'); return; }
  if (action === 'related-history') {
    state.historyId = state.modalEvent?.employee_id || state.historyId; state.historyFrom = ''; state.historyTo = ''; state.historyStatus = ''; state.historyType = '';
    closeModal(); await navigate('history'); return;
  }
  if (action === 'admin-day') {
    await openAdminDay(node.dataset.employee || state.statsId, node.dataset.date, { event_id: node.dataset.id, type: node.dataset.type, shift_ref: node.dataset.shift, break_ref: node.dataset.break, time: node.dataset.time, add: node.dataset.add }); return;
  }
  if (action === 'admin-day-reload') { const model = state.adminDay; if (model) await openAdminDay(model.employeeId, model.date); return; }
  if (action === 'admin-add-shift' || action === 'admin-add-break' || action === 'admin-remove-slot') {
    if (!isAdmin() || !state.adminDay) return;
    captureAdminDayFields();
    if (action === 'admin-remove-slot') { const slot = adminSlots().find(function(s) { return s.key === node.dataset.key; }); if (slot && slot.original && !slot.readonly) slot.remove = !slot.remove; }
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
    let suggestion = null;
    if (current?.issues?.length) {
      const issue = current.issues[0];
      const at = current.open_break_at || current.open_shift_at || issue.event_at;
      suggestion = { actions: issue.expected_actions || [], date: issue.suggested_date || (at ? dateKey(at) : today()), current };
    }
    openCorrection(id, suggestion); return;
  }
  if (action === 'correction-from-warning') { const suggestion = state.correctionSuggestion; openCorrection(suggestion.employeeId, suggestion); return; }
  if (action === 'add-correction-entry') {
    const container = document.getElementById('correction-entries'); if (!container) return;
    if (container.children.length >= 20) { toast('Μπορείς να υποβάλεις έως 20 κινήσεις μαζί.', 'error'); return; }
    const i = state.correctionEntryCount++; container.insertAdjacentHTML('beforeend', correctionEntryHtml(i)); updateDstChoices(modal); return;
  }
  if (action === 'remove-correction-entry') {
    const container = document.getElementById('correction-entries');
    if (container?.children.length <= 1) { toast('Χρειάζεται τουλάχιστον μία κίνηση.'); return; }
    node.closest('.correction-entry')?.remove(); return;
  }
  if (action === 'edit-event') { await openEventEdit(node.dataset.id, node.dataset.employee); return; }
  if (action === 'review-event') { openReview(node.dataset.id); return; }
  if (action === 'edit-employee') { openEmployee(node.dataset.id); return; }
  if (action === 'archive-employee') {
    const id = node.dataset.id; const archived = node.dataset.archived === 'true';
    openModal(archived ? 'Αρχειοθέτηση εργαζομένου' : 'Επαναφορά εργαζομένου', personName(id),
      '<p>' + (archived ? 'Ο εργαζόμενος θα αφαιρεθεί από την ενεργή λίστα. Οι καταγραφές και οι αναφορές του θα διατηρηθούν.' : 'Ο εργαζόμενος θα εμφανιστεί ξανά στην ενεργή λίστα.') + '</p>',
      submitButton(archived ? 'Αρχειοθέτηση' : 'Επαναφορά'), 'archive');
    state.modalEmployeeId = id; state.modalArchived = archived; return;
  }
  if (action === 'void-selected') { openVoid(Array.from(document.querySelectorAll('.event-check:checked')).map(function(el) { return el.value; })); return; }
  if (action === 'edit-note') { openNote(node.dataset.date); return; }
  if (action === 'edit-member') { openMember(node.dataset.email); return; }
  if (action === 'edit-device') { openDevice(node.dataset.id); return; }
  if (action === 'export-stats') { exportStats(); return; }
  if (action === 'retry-command') {
    if (!state.pendingCommand || state.busy) return;
    try {
      await command(null, null, true); closeModal(); toast('Η αποθήκευση επιβεβαιώθηκε.', 'success'); await refreshApp();
    } catch (error) { if (error.uncertain) toast('Δεν έχει επιβεβαιωθεί ακόμη. Δοκίμασε όταν επανέλθει η σύνδεση.', 'error'); else { toast(issueMessages(error), 'error'); await refreshApp(); } }
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
    await enterApp();
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
  const kind = form.dataset.kind;
  const f = form.elements;
  try {
    if (kind === 'browser-decision') { await saveBrowserDecision(); return; }
    if (kind === 'admin-day') {
      if (!isAdmin() || !state.adminDay) throw new Error('Απαιτείται διαχειριστής.');
      const entries = adminDayEntriesFromForm(form);
      if (!entries.length) { closeModal(); toast('Δεν υπάρχουν νέες αλλαγές.'); return; }
      const reason = String(f.admin_reason?.value || '').trim();
      if (reason.length < 3) throw new Error('Συμπλήρωσε σύντομη αιτιολογία για τις ώρες που ορίζεις.');
      const model = state.adminDay;
      const response = await command('admin_day_save', { employee_id: model.employeeId, date: model.date, expected_revision: model.revision, entries, reason });
      const result = response?.result || response || {};
      closeModal();
      toast(result.drafts?.length ? 'Οι ώρες αποθηκεύτηκαν. Οι πρόχειρες κινήσεις περιμένουν να συμπληρωθούν οι προϋποθέσεις τους.' : 'Οι ώρες ημέρας αποθηκεύτηκαν.', 'success');
      await refreshApp(); return;
    }
    if (kind === 'correction') {
      const entries = Array.from(form.querySelectorAll('.correction-entry')).map(function(section) {
        const prefix = 'entry_' + section.dataset.entry;
        return { type: f[prefix + '_type'].value, event_at: isoFromForm(form, prefix) };
      });
      await command('correction', { employee_id: state.modalEmployeeId, entries, reason: f.reason.value.trim() });
      closeModal(); toast('Οι διορθώσεις υποβλήθηκαν. Έλεγξε την ενημερωμένη κατάσταση πριν συνεχίσεις.', 'success'); await refreshApp(); return;
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
        sort_order: Number(f.sort_order.value), max_daily_shifts: Number(f.max_daily_shifts.value),
        shift1_start: f.shift1_start.value || null, shift2_start: f.shift2_start.value || null,
        lateness_tolerance_minutes: Number(f.lateness_tolerance_minutes.value)
      };
      if (state.modalEmployeeId) payload.id = state.modalEmployeeId;
      await command('employee_save', payload); closeModal(); toast('Ο εργαζόμενος αποθηκεύτηκε.', 'success'); await refreshApp(); return;
    }
    if (kind === 'archive') {
      await command('employee_archive', { id: state.modalEmployeeId, archived: state.modalArchived });
      if (state.modalArchived && state.selectedId === state.modalEmployeeId) { state.selectedId = ''; state.employeeData = null; }
      closeModal(); toast(state.modalArchived ? 'Ο εργαζόμενος αρχειοθετήθηκε.' : 'Ο εργαζόμενος επανήλθε.', 'success'); await refreshApp(); return;
    }
    if (kind === 'void') {
      await command('event_void', { ids: state.modalVoidIds, reason: f.reason.value.trim() }); closeModal(); toast('Οι κινήσεις ακυρώθηκαν και διατηρούνται στο ιστορικό.', 'success'); await refreshApp(); return;
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
  } catch (error) { if (!state.browserGate && !handleBrowserGate(error)) modalError(error); }
}
async function handleSettings(form) {
  const f = form.elements;
  try {
    await command('settings_save', {
      break_limit_minutes: Number(f.break_limit_minutes.value), shift_target_minutes: Math.round(Number(f.shift_target_hours.value) * 60),
      default_max_daily_shifts: Number(f.default_max_daily_shifts.value), idle_timeout_minutes: Number(f.idle_timeout_minutes.value)
    });
    toast('Οι ρυθμίσεις αποθηκεύτηκαν.', 'success'); await refreshApp();
  } catch (error) { toast(issueMessages(error), 'error'); }
}
async function handleChange(target) {
  if (!state.context) return;
  if (target.dataset.dst) { updateDstChoices(modal); return; }
  if (target.id === 'employee-department') {
    state.department = target.value; const grid = document.getElementById('employee-grid'); if (grid) grid.innerHTML = employeeGrid(); colorAvatars(); return;
  }
  if (target.id === 'show-archived') { state.showArchived = target.checked; renderCurrentView(); return; }
  if (target.id === 'select-all-events') { document.querySelectorAll('.event-check').forEach(function(el) { el.checked = target.checked; }); updateBulkSelection(); return; }
  if (target.classList.contains('event-check')) { updateBulkSelection(); return; }
  if (target.name === 'history_employee') { state.historyId = target.value; await loadView('history'); return; }
  if (target.name === 'history_from') { state.historyFrom = target.value; renderCurrentView(); return; }
  if (target.name === 'history_to') { state.historyTo = target.value; renderCurrentView(); return; }
  if (target.name === 'history_status') { state.historyStatus = target.value; renderCurrentView(); return; }
  if (target.name === 'history_type') { state.historyType = target.value; renderCurrentView(); return; }
  if (target.name === 'request_status') { state.requestStatus = target.value; await loadView('requests'); return; }
  if (target.name === 'request_employee') { state.requestEmployee = target.value; await loadView('requests'); return; }
  if (target.name === 'stats_employee') { state.statsId = target.value; await loadView('stats'); return; }
  if (target.name === 'stats_month' && /^\d{4}-\d{2}$/.test(target.value)) { state.month = target.value; await loadView('stats'); return; }
  if (target.name === 'stats_mode') { state.statsMode = target.value; renderCurrentView(); }
}
function tick() {
  if (state.browserGate?.status === 'pending' && state.browserPollAt && Date.now() >= state.browserPollAt && !state.busy && !state.authBusy && !state.browserCheckBusy && !document.hidden) {
    state.browserPollAt = Date.now() + 15000; checkBrowserApproval();
  }
  const clock = document.querySelector('.live-clock');
  if (clock) clock.textContent = new Intl.DateTimeFormat('el-GR', { timeZone: 'Europe/Athens', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now());
  document.querySelectorAll('[data-elapsed]').forEach(function(el) {
    const seconds = Math.max(0, Math.floor((now().getTime() - Date.parse(el.dataset.elapsed)) / 1000));
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
    el.textContent = (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  });
  const ctx = state.context;
  if (ctx && state.view === 'stats' && state.nextScheduledRefresh && now().getTime() >= state.nextScheduledRefresh && !state.busy && !modal.open && !document.hidden) {
    state.nextScheduledRefresh = 0;
    loadView('stats', true).catch(function(error) { setConnection(false); toast(error.message, 'error'); });
  }
  if (ctx && ['admin', 'reviewer'].includes(ctx.role) && !state.busy && !state.idleLogout && Date.now() - state.lastActivity > Number(ctx.settings?.idle_timeout_minutes || 10) * 60000) {
    state.idleLogout = true;
    logout('Η συνεδρία έληξε λόγω αδράνειας. Συνδέσου ξανά για να συνεχίσεις.').finally(function() { state.idleLogout = false; });
  }
}

document.addEventListener('click', function(event) {
  if (event.target.closest?.('a.kiosk-admin-link') && state.busy) { event.preventDefault(); return; }
  const node = event.target.closest?.('button[data-action]');
  if (!node || node.disabled) return;
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
  if (event.target.id === 'employee-search') {
    state.search = event.target.value;
    const grid = document.getElementById('employee-grid'); if (grid) { grid.innerHTML = employeeGrid(); colorAvatars(); }
  }
  if (event.target.dataset.dst) updateDstChoices(modal);
});
['pointerdown', 'keydown', 'touchstart'].forEach(function(type) {
  document.addEventListener(type, function() { state.lastActivity = Date.now(); }, { passive: true });
});
modal.addEventListener('cancel', function(event) {
  if (state.busy) event.preventDefault();
  else { clearPasswords(modal); state.modalDevice = null; state.modalMember = null; state.modalBrowser = null; clearKioskSelection(); }
});
window.addEventListener('offline', function() { setConnection(false); });
window.addEventListener('online', function() { if (state.browserGate) checkBrowserApproval(); else if (state.context && !state.busy) refreshApp(); });
document.addEventListener('visibilitychange', function() { if (!document.hidden && !state.busy && !modal.open) { if (state.browserGate) checkBrowserApproval(); else if (state.context) refreshApp(); } });
setInterval(tick, 1000);
setInterval(function() {
  if (!state.context || state.busy || modal.open || document.hidden || !['record', 'overview'].includes(state.view)) return;
  loadView(state.view, true);
}, 30000);
if (typeof api.subscribe === 'function') api.subscribe(function(session) {
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
  state.authBusy = true;
  try {
    if (await api.restore()) { state.authRetryRestore = false; await enterApp(); } else { state.authRetryRestore = false; renderLogin(); }
  } catch (error) {
    if (handleBrowserGate(error)) return;
    state.authMessage = error.message || 'Η εφαρμογή δεν μπόρεσε να συνδεθεί.'; state.authError = true;
    state.authRetryRestore = ['NETWORK', 'TIMEOUT', 'BAD_RESPONSE'].includes(error.code);
    if (error.code === 'otp_expired') { state.authMode = 'admin'; state.signup = false; state.authResend = true; }
    renderLogin();
  } finally { state.authBusy = false; }
}
initialize();
