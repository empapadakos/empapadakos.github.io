import { ACTION_LABELS, formatDate, formatTime } from './domain.js';

const label = type => Object.hasOwn(ACTION_LABELS, type) ? ACTION_LABELS[type] : 'Κίνηση';
const validInstant = value => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));

/** Display evidence with seconds so two entries inside the same minute stay distinct. */
export function diagnosticDateTime(value) {
  if (!validInstant(value)) return null;
  return `${formatDate(value)} ${formatTime(value, { seconds: true }).replaceAll(':', '.')}`;
}

function preciseInstant(value) {
  if (!validInstant(value)) return null;
  const fraction = value.match(/[Tt ]\d{2}:\d{2}:\d{2}\.(\d+)(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/)?.[1] || '';
  return BigInt(Date.parse(value)) * 1000000n + BigInt(fraction.slice(3, 9).padEnd(6, '0'));
}

function evidenceItem(labelText, at) {
  const text = diagnosticDateTime(at);
  return text ? { label: labelText, at, text } : null;
}

function sameInstant(left, right) {
  const a = preciseInstant(left), b = preciseInstant(right);
  return a !== null && b !== null && a === b;
}

function explainIssue(issue, attempts) {
  const state = issue.state_before;
  const type = issue.type;
  const isAttempt = attempts.some(event => event.type === type && sameInstant(event.event_at, issue.event_at));
  const proposedEntry = attempts.some(event => event.type === 'clock_in' && sameInstant(event.event_at, issue.open_shift_at));
  const proposedBreak = attempts.some(event => event.type === 'break_start' && sameInstant(event.event_at, issue.open_break_at));
  const required = (Array.isArray(issue.expected_actions) ? issue.expected_actions : []).filter(type => Object.hasOwn(ACTION_LABELS, type));
  // SQL replay predates structured codes for these failures. Recognize only
  // known categories; raw server messages are never copied into the view model.
  const message = typeof issue.message === 'string' ? issue.message.toLocaleLowerCase('el-GR') : '';
  const code = issue.code || (message.includes('στο μέλλον') || message.includes('μελλοντικ') ? 'future_event'
    : message.includes('διαφορετική βάρδια') ? 'wrong_shift_reference'
      : message.includes('διαφορετικό διάλειμμα') ? 'wrong_break_reference' : null);
  let explanation;
  let solution;
  let administratorRequired = required.length === 0;

  if (code === 'invalid_timestamp' || code === 'unknown_action') {
    explanation = code === 'invalid_timestamp'
      ? 'Η συγκεκριμένη καταγραφή δεν έχει έγκυρη ημερομηνία και ώρα.'
      : 'Η συγκεκριμένη καταγραφή έχει μη αναγνωρισμένο τύπο κίνησης.';
    solution = 'Πάτησε «Ακύρωση» και ζήτησε από τον διαχειριστή έλεγχο της συγκεκριμένης καταγραφής.';
    administratorRequired = true;
  } else if (code === 'future_event') {
    explanation = 'Η συγκεκριμένη κίνηση έχει μελλοντική ώρα και δεν μπορεί να καλύψει μια ενέργεια που γίνεται τώρα.';
    solution = 'Έλεγξε την ημερομηνία και την πραγματική ώρα της κίνησης. Αν η ήδη αποθηκευμένη ώρα είναι λανθασμένη, χρειάζεται διόρθωση από τον διαχειριστή.';
  } else if (code === 'wrong_shift_reference' || code === 'wrong_break_reference') {
    explanation = code === 'wrong_shift_reference'
      ? 'Η ήδη αποθηκευμένη κίνηση συνδέεται με διαφορετική βάρδια από εκείνη που είναι ανοιχτή σε αυτό το σημείο.'
      : 'Η ήδη αποθηκευμένη επιστροφή συνδέεται με διαφορετικό διάλειμμα από εκείνο που είναι ανοιχτό σε αυτό το σημείο.';
    solution = 'Πάτησε «Ακύρωση» και ζήτησε από τον διαχειριστή έλεγχο των σχετικών καταγραφών και της σύνδεσής τους. Η προσθήκη μιας αυθαίρετης ώρας δεν διορθώνει αυτή τη σύνδεση.';
    administratorRequired = true;
  } else if (!required.length) {
    explanation = 'Η συγκεκριμένη καταγραφή έχει ασυμφωνία που δεν διορθώνεται με την προσθήκη μιας ελλείπουσας κίνησης.';
    solution = 'Πάτησε «Ακύρωση» και ζήτησε από τον διαχειριστή έλεγχο της συγκεκριμένης καταγραφής.';
    administratorRequired = true;
  } else if (state === 'IN' && type === 'clock_in') {
    explanation = isAttempt
      ? 'Προσπάθησες να κάνεις δεύτερη είσοδο ενώ η προηγούμενη βάρδια είναι ακόμη ανοιχτή, χωρίς έξοδο ανάμεσά τους.'
      : proposedEntry
        ? 'Η είσοδος που προσπάθησες να προσθέσεις θα άνοιγε βάρδια πριν από μια ήδη καταχωρημένη είσοδο, χωρίς έξοδο ανάμεσά τους.'
        : 'Υπάρχει ήδη ανοιχτή είσοδος και ακολουθεί δεύτερη είσοδος, χωρίς έξοδο ανάμεσά τους.';
    solution = isAttempt
      ? 'Αν πράγματι έγινε έξοδος πριν από τη νέα είσοδο, συμπλήρωσε την πραγματική ώρα εκείνης της εξόδου. Αν πάτησες κατά λάθος δεύτερη «Είσοδος», πάτησε «Ακύρωση»· η προηγούμενη βάρδια παραμένει ανοιχτή.'
      : proposedEntry
        ? 'Αν ζητάς αλλαγή της ώρας μιας ήδη καταχωρημένης εισόδου, ο διαχειριστής χρειάζεται να χρησιμοποιήσει «Αλλαγή ώρας» στην υπάρχουσα καταγραφή. Αν πρόκειται για ξεχωριστή βάρδια, πρέπει να υπάρχει η πραγματική έξοδος που μεσολάβησε πριν από την επόμενη είσοδο.'
        : 'Αν πράγματι έγινε έξοδος πριν από τη δεύτερη είσοδο, συμπλήρωσε την πραγματική ώρα εκείνης της εξόδου. Αν η μία είσοδος είναι διπλή ή έχει λανθασμένη ώρα, πάτησε «Ακύρωση» και ζήτησε από τον διαχειριστή να διορθώσει τη λανθασμένη καταγραφή.';
  } else if (state === 'OUT') {
    explanation = `Στη ${label(type).toLocaleLowerCase('el-GR')} δεν υπάρχει προηγούμενη ανοιχτή βάρδια: λείπει η αντίστοιχη είσοδος πριν από αυτή την κίνηση.`;
    solution = `Συμπλήρωσε μόνο τις πραγματικές κινήσεις που λείπουν, με αυτή τη σειρά: ${required.map(label).join(' → ') || 'έλεγχος από τον διαχειριστή'}. Αν η ήδη καταχωρημένη κίνηση δεν έγινε ή έχει λανθασμένη ώρα, χρειάζεται διόρθωση από τον διαχειριστή.`;
  } else if (state === 'ON_BREAK' && type === 'clock_in') {
    explanation = 'Υπάρχει ανοιχτό διάλειμμα από την προηγούμενη βάρδια. Πριν από τη νέα είσοδο λείπουν η επιστροφή από το διάλειμμα και η έξοδος της προηγούμενης βάρδιας.';
    solution = 'Συμπλήρωσε πρώτα την πραγματική επιστροφή από το διάλειμμα και μετά την πραγματική έξοδο. Αν κάποια υπάρχουσα κίνηση είναι λανθασμένη, ζήτησε από τον διαχειριστή να τη διορθώσει.';
  } else if (state === 'ON_BREAK') {
    explanation = type === 'break_start'
      ? 'Έχει ήδη ξεκινήσει διάλειμμα και ακολουθεί δεύτερη έναρξη διαλείμματος χωρίς επιστροφή ανάμεσά τους.'
      : 'Η έξοδος εμφανίζεται ενώ το διάλειμμα παραμένει ανοιχτό: λείπει η προηγούμενη επιστροφή από το διάλειμμα.';
    solution = 'Αν έγινε επιστροφή από το διάλειμμα πριν από αυτή την κίνηση, συμπλήρωσε την πραγματική ώρα επιστροφής. Αν η υπάρχουσα κίνηση είναι λανθασμένη ή διπλή, χρειάζεται έλεγχος από τον διαχειριστή.';
  } else if (state === 'IN' && type === 'break_end') {
    explanation = 'Υπάρχει επιστροφή από διάλειμμα, χωρίς να έχει προηγηθεί η αντίστοιχη έναρξη διαλείμματος.';
    solution = 'Συμπλήρωσε την πραγματική ώρα έναρξης του συγκεκριμένου διαλείμματος. Αν αυτή η επιστροφή δεν έγινε ή έχει λανθασμένη ώρα, ζήτησε από τον διαχειριστή να τη διορθώσει.';
  } else {
    explanation = 'Η ήδη αποθηκευμένη κίνηση δεν μπορεί να ενταχθεί στη σειρά των υπαρχουσών καταγραφών.';
    solution = required.length
      ? `Χρειάζεται έλεγχος των πραγματικών ωρών. Οι κινήσεις που λείπουν είναι: ${required.map(label).join(' → ')}.`
      : 'Πάτησε «Ακύρωση» και ζήτησε από τον διαχειριστή έλεγχο της συγκεκριμένης καταγραφής.';
    administratorRequired = required.length === 0;
  }

  const after = validInstant(issue.repair_after_at) ? issue.repair_after_at : null;
  const before = validInstant(issue.repair_before_at) ? issue.repair_before_at : validInstant(issue.event_at) ? issue.event_at : null;
  const windowText = after && before
    ? `Η κίνηση που λείπει πρέπει να αντιστοιχεί σε πραγματικό γεγονός ανάμεσα στις ${diagnosticDateTime(after)} και ${diagnosticDateTime(before)}.`
    : before ? `Η κίνηση που λείπει πρέπει να έχει προηγηθεί της καταγραφής στις ${diagnosticDateTime(before)}.` : '';
  const evidence = [
    evidenceItem(proposedEntry ? 'Είσοδος που προσπάθησες να προσθέσεις' : 'Ανοιχτή είσοδος', issue.open_shift_at),
    evidenceItem(proposedBreak ? 'Έναρξη διαλείμματος που προσπάθησες να προσθέσεις' : 'Έναρξη ανοιχτού διαλείμματος', issue.open_break_at),
    evidenceItem('Τελευταία προηγούμενη έγκυρη κίνηση', after),
    evidenceItem(isAttempt ? 'Κίνηση που προσπάθησες να καταχωρήσεις' : 'Υπάρχουσα καταγραφή που δημιουργεί την ασυμφωνία', issue.event_at)
  ].filter(Boolean).filter((item, index, all) => !all.slice(0, index).some(previous => sameInstant(previous.at, item.at)));

  return {
    title: `${isAttempt ? 'Απόπειρα: ' : ''}${label(type)}${diagnosticDateTime(issue.event_at) ? ` · ${diagnosticDateTime(issue.event_at)}` : ''}`,
    explanation, evidence, requiredActions: required.map(label),
    timeWindow: required.length && windowText ? { after, before, text: windowText } : null,
    attemptExplanation: '', solution, administratorRequired
  };
}

/**
 * Plain-text view model for a REJECTED employee attempt. This helper performs no
 * validation, lookup, HTML rendering, or automatic display before submission.
 */
export function buildFlowDiagnostics(details, { attemptedEvent = null, attemptedEvents = [], limit = 6 } = {}) {
  if (typeof details === 'string') { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== 'object') return null;
  const issues = Array.isArray(details.state?.issues) ? details.state.issues : Array.isArray(details.issues) ? details.issues : [];
  const usable = issues.filter(issue => issue && typeof issue === 'object');
  if (!usable.length) return null;
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(20, Math.floor(Number(limit)))) : 6;
  const attempts = [attemptedEvent, ...(Array.isArray(attemptedEvents) ? attemptedEvents : [])].filter(event => event && typeof event === 'object');
  const items = usable.slice(0, max).map(issue => explainIssue(issue, attempts));
  const first = usable[0];
  const attempt = attempts.find(event => event.type === first.expected_actions?.[0]) || attempts[0];
  const at = preciseInstant(attempt?.event_at);
  const low = preciseInstant(first.repair_after_at);
  const high = preciseInstant(first.repair_before_at || first.event_at);
  if (at !== null && items[0].timeWindow) {
    const attempted = `${label(attempt.type)} στις ${diagnosticDateTime(attempt.event_at)}`;
    if (low !== null && at < low) items[0].attemptExplanation = `Έστειλες ${attempted}, πριν από την προηγούμενη έγκυρη κίνηση. Αυτή η ώρα δεν καλύπτει τη συγκεκριμένη έλλειψη.`;
    else if (high !== null && at > high) items[0].attemptExplanation = `Έστειλες ${attempted}, μετά από την καταγραφή που χρειάζεται διόρθωση. Αυτή η ώρα μπορεί να αφορά άλλη βάρδια ή κίνηση, αλλά δεν καλύπτει τη συγκεκριμένη έλλειψη.`;
    else if (attempt.type !== first.expected_actions?.[0]) items[0].attemptExplanation = `Έστειλες ${attempted}. Πρώτα λείπει η κίνηση «${label(first.expected_actions?.[0])}».`;
  }
  return {
    title: 'Γιατί δεν έγινε δεκτή η καταχώρηση',
    intro: 'Η καταχώρηση δεν αποθηκεύτηκε. Οι παρακάτω ασυμφωνίες χρειάζονται έλεγχο με τη σειρά που εμφανίζονται.',
    attemptSummary: attempt && diagnosticDateTime(attempt.event_at) ? `Η προσπάθειά σου: ${label(attempt.type)} στις ${diagnosticDateTime(attempt.event_at)}. Αυτή η κίνηση δεν αποθηκεύτηκε.` : '',
    issueCount: usable.length, remainingCount: usable.length - items.length, items,
    footer: 'Συμπλήρωσε μόνο πραγματικές ώρες. Επιτρέπονται περισσότερες από μία είσοδοι την ίδια ημέρα, εφόσον προηγείται έξοδος από την προηγούμενη βάρδια. Οι λανθασμένες υπάρχουσες καταγραφές διορθώνονται από τον διαχειριστή.'
  };
}
