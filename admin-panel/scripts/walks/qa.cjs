/* The QA programme screen, walked in a real browser: node scripts/capture-panel.cjs --walk scripts/walks/qa.cjs
 *
 * This is the workflow, not the render. It marks an account that already owns sixty-two ledger rows,
 * watches the money tab reclassify them, unmarks it and watches them come back, then puts a two-account
 * cohort through the paste box and undoes that too. Every capture is paired with an assertion, because
 * the brief is explicit that a screen opening is not evidence a feature works.
 *
 * The accounts are `e2e_alice_*` throwaways the backend suites created — real ledger history, no real
 * person behind them. Nothing is left marked when the walk finishes, and the last assertions say so.
 *
 * Waits are `waitFor`, not sleeps: the derivation runs over thirteen thousand financial rows, and a
 * fixed delay would either waste the run or assert against a half-loaded table.
 */
const SINGLE = { username: 'e2e_alice_7717' };
const COHORT = [
  { username: 'e2e_alice_4940', id: 'eab94d40-ea15-4852-b9b0-b25a8d7a834c', ref: 'PANEL-WALK-COHORT-A' },
  { username: 'e2e_alice_3290', id: 'e2881807-9285-4027-8db4-ed58e91362d9', ref: 'PANEL-WALK-COHORT-B' },
];
const REF = 'PANEL-WALK-01';

const SEARCH = 'input[placeholder="display name, reference or account id"]';
const REF_INPUT = '[role=dialog] input[placeholder="PK-HOST-01"]';
const DIALOG_FOOTER = '[role=dialog] footer';
const CONFIRM = '[role=dialog] footer button:last-child';
const SWITCH = 'button[role=switch]';
const TABS = 'div[role=tablist] button';
const MARKING = 'select[aria-label=Marking]';
const RECORD_TYPE = 'select[aria-label="Record type"]';
// The shell scrolls inside <main>, so a capture only shows what the container is scrolled to. These
// put the classification table and the record table inside the frame respectively.
const SUMMARY_CARD = 'main section.panel:nth-of-type(2)';
const RECORDS_CARD = 'main section.panel:last-of-type';

/**
 * The number under a stat card's label. Matched case-insensitively because the label is uppercased by
 * CSS, not in the DOM, and read from the card's own structure rather than by scraping prose.
 */
const stat = (label) => `(() => {
  const card = Array.from(document.querySelectorAll('main p.uppercase'))
    .find((p) => p.textContent.trim().toUpperCase() === ${JSON.stringify(label.toUpperCase())});
  return card ? card.nextElementSibling.textContent.trim() : null;
})()`;
const statNumber = (label) => `Number((${stat(label)} ?? '0').replace(/,/g, ''))`;

const mainText = `document.querySelector('main').innerText`;
// Parenthesised: `?? ''` binds looser than `.includes`, so without these the assertion would evaluate
// to the dialog's text instead of to a boolean.
const dialogText = `(document.querySelector('[role=dialog]')?.innerText ?? '')`;
const dialogOpen = `document.querySelector('[role=dialog]') !== null`;
const confirmDisabled = `document.querySelector('${CONFIRM}').disabled`;

/** The accounts tab has one table. */
const rowCount = `document.querySelectorAll('main tbody tr').length`;
const rowText = `Array.from(document.querySelectorAll('main tbody tr')).map((r) => r.innerText).join('\\n')`;
/** Badges are uppercased by CSS, so marking is compared on a normalised copy of the rendered text. */
const rowTextUpper = `(${rowText}).toUpperCase()`;

/**
 * The money tab has two tables: the eleven-row classification summary, then the records. Only the
 * second carries a "Whose test" column, which is how the walk tells them apart instead of counting
 * both. Compared upper-cased because the header cell is uppercased by CSS, not in the DOM.
 */
const moneyRowList = `(() => {
  const tables = document.querySelectorAll('main table');
  const last = tables[tables.length - 1];
  return last && last.innerText.toUpperCase().includes('WHOSE TEST') ? Array.from(last.querySelectorAll('tbody tr')) : [];
})()`;
const moneyRowCount = `${moneyRowList}.length`;
const moneyRowText = `${moneyRowList}.map((r) => r.innerText).join('\\n')`;
const summaryRowCount = `document.querySelectorAll('main table')[0]?.querySelectorAll('tbody tr').length ?? 0`;

const unmarkOne = (username) => [
  { action: 'fill', selector: SEARCH, value: username },
  { action: 'waitFor', name: `the list narrows to ${username}`, expression: rowCount, equals: 1 },
  { action: 'clickText', text: 'Unmark' },
  { action: 'waitFor', name: 'the unmark dialog opens', expression: dialogOpen, equals: true },
  { action: 'clickText', within: DIALOG_FOOTER, text: 'Unmark' },
  { action: 'waitFor', name: 'the unmark dialog closes', expression: dialogOpen, equals: false },
];

module.exports = [
  // --- The screen as an operator first meets it --------------------------------
  { action: 'navigate', path: '/qa', name: '01-qa-landing', capture: true },
  { action: 'assert', name: 'the QA screen is the one that loaded', expression: `document.querySelector('main h1')?.textContent?.trim()`, equals: 'QA programme' },
  { action: 'waitFor', name: 'nothing is marked before the walk starts', expression: stat('Test accounts'), equals: '0' },
  { action: 'assert', name: 'every financial table is classified', expression: stat('Tables covered'), equals: '11' },
  { action: 'assert', name: 'the production total is the whole book', expression: `${statNumber('Production rows')} > 0`, equals: true },

  // --- Finding an account that was never marked --------------------------------
  { action: 'click', selector: SWITCH },
  { action: 'waitFor', name: 'include-unmarked lists production accounts', expression: `${rowCount} > 0`, equals: true },
  { action: 'fill', selector: SEARCH, value: SINGLE.username },
  { action: 'waitFor', name: 'the search narrows to the one account', expression: rowCount, equals: 1 },
  { action: 'assert', name: 'it is found under its real display name', expression: `${rowText}.includes(${JSON.stringify(SINGLE.username)})`, equals: true },
  { action: 'assert', name: 'and it is production before the walk marks it', expression: `${rowTextUpper}.includes('PRODUCTION')`, equals: true },
  { action: 'capture', name: '02-qa-account-found' },

  // --- Marking: the reference is required, and the consequences are stated ------
  { action: 'clickText', text: 'Mark as test' },
  { action: 'waitFor', name: 'the marking dialog opens', expression: dialogOpen, equals: true },
  { action: 'assert', name: 'it names the account being marked', expression: `document.querySelector('[role=dialog] h3')?.textContent?.includes(${JSON.stringify(SINGLE.username)})`, equals: true },
  { action: 'assert', name: 'the dialog says it reclassifies the whole history', expression: `${dialogText}.includes('whole financial history')`, equals: true },
  { action: 'assert', name: 'and the screen says history already written is included', expression: `${mainText}.includes('already existed')`, equals: true },
  { action: 'fill', selector: REF_INPUT, value: '' },
  { action: 'assert', name: 'an empty reference cannot be submitted', expression: confirmDisabled, equals: true },
  { action: 'capture', name: '03-qa-mark-ref-required', fullPage: false },
  { action: 'fill', selector: REF_INPUT, value: 'not a ref!' },
  { action: 'assert', name: 'a malformed reference is refused in the form', expression: confirmDisabled, equals: true },
  { action: 'assert', name: 'and the form says why', expression: `${dialogText}.includes('Letters, digits, dash and underscore')`, equals: true },
  { action: 'capture', name: '04-qa-mark-ref-invalid', fullPage: false },
  { action: 'fill', selector: REF_INPUT, value: REF.toLowerCase() },
  { action: 'assert', name: 'a valid reference enables the write', expression: confirmDisabled, equals: false },
  { action: 'capture', name: '05-qa-mark-ready', fullPage: false },
  { action: 'clickText', within: DIALOG_FOOTER, text: 'Mark as test' },
  { action: 'waitFor', name: 'the dialog closed on success', expression: dialogOpen, equals: false },

  // --- What marking actually did ----------------------------------------------
  { action: 'waitFor', name: 'the account is now marked with its reference', expression: `${rowTextUpper}.includes('TEST') && ${rowText}.includes(${JSON.stringify(REF)})`, equals: true },
  { action: 'assert', name: 'the reference is upper case in the record', expression: `${rowText}.includes(${JSON.stringify(REF)}) && !${rowText}.includes(${JSON.stringify(REF.toLowerCase())})`, equals: true },
  { action: 'waitFor', name: 'the test-account count went up', expression: stat('Test accounts'), equals: '1' },
  { action: 'waitFor', name: 'money that already existed is now test activity', expression: `${statNumber('Test money rows')} > 0`, equals: true },
  { action: 'capture', name: '06-qa-marked' },

  // --- The money tab: the derivation, seen ------------------------------------
  { action: 'click', selector: `${TABS}:nth-child(2)` },
  { action: 'waitFor', name: 'the money tab lists all eleven record types', expression: summaryRowCount, equals: 11 },
  { action: 'assert', name: 'the ledger is named in product terms, not schema terms', expression: `${mainText}.includes('Ledger transactions')`, equals: true },
  { action: 'scroll', intoView: SUMMARY_CARD },
  { action: 'capture', name: '07-qa-money-summary' },
  { action: 'waitFor', name: 'test activity is listed with the cohort that caused it', expression: `${moneyRowText}.includes(${JSON.stringify(REF)})`, equals: true },
  { action: 'assert', name: 'the default filter is test activity only', expression: `document.querySelector('${MARKING}').value`, equals: 'TEST' },
  { action: 'scroll', intoView: RECORDS_CARD },
  { action: 'capture', name: '08-qa-money-test-rows' },
  { action: 'select', selector: MARKING, value: 'PRODUCTION' },
  { action: 'waitFor', name: 'the production filter excludes the marked cohort', expression: `${moneyRowCount} > 0 && !${moneyRowText}.includes(${JSON.stringify(REF)})`, equals: true },
  { action: 'scroll', intoView: RECORDS_CARD },
  { action: 'capture', name: '09-qa-money-production-filter' },
  { action: 'select', selector: RECORD_TYPE, value: 'transactions' },
  { action: 'waitFor', name: 'the record filter narrows to one table', expression: `${moneyRowCount} > 0 && ${moneyRowList}.every((r) => r.innerText.includes('Ledger transactions'))`, equals: true },
  { action: 'scroll', intoView: RECORDS_CARD },
  { action: 'capture', name: '10-qa-money-record-filter' },

  // --- Unmarking puts it back --------------------------------------------------
  { action: 'click', selector: `${TABS}:nth-child(1)` },
  { action: 'scroll', top: 0 },
  { action: 'waitFor', name: 'the accounts tab is back with the search intact', expression: rowCount, equals: 1 },
  { action: 'clickText', text: 'Unmark' },
  { action: 'waitFor', name: 'the unmark dialog opens', expression: dialogOpen, equals: true },
  { action: 'assert', name: 'it says the reference stays on the audit trail', expression: `${dialogText}.includes('stays on the row')`, equals: true },
  { action: 'capture', name: '11-qa-unmark-dialog', fullPage: false },
  { action: 'clickText', within: DIALOG_FOOTER, text: 'Unmark' },
  { action: 'waitFor', name: 'the unmark dialog closes', expression: dialogOpen, equals: false },
  { action: 'waitFor', name: 'the account is production again', expression: `${rowTextUpper}.includes('PRODUCTION')`, equals: true },
  { action: 'assert', name: 'the reference survived the unmark', expression: `${rowText}.includes(${JSON.stringify(REF)})`, equals: true },
  { action: 'waitFor', name: 'no test money is left from the single mark', expression: stat('Test money rows'), equals: '0' },
  { action: 'waitFor', name: 'and no test account either', expression: stat('Test accounts'), equals: '0' },
  { action: 'scroll', top: 0 },
  { action: 'capture', name: '12-qa-unmarked' },

  // --- The cohort paste box ----------------------------------------------------
  { action: 'fill', selector: SEARCH, value: '' },
  { action: 'waitFor', name: 'clearing the search lists the roster again', expression: `${rowCount} > 1`, equals: true },
  { action: 'clickText', text: 'Mark a cohort' },
  { action: 'waitFor', name: 'the cohort dialog opens', expression: dialogOpen, equals: true },
  { action: 'fill', selector: '[role=dialog] textarea', value: 'USER not-a-uuid BAD REF\nWIZARD 00000000-0000-0000-0000-000000000000 PK-X-01' },
  { action: 'assert', name: 'bad lines are named before anything is sent', expression: `${dialogText}.includes('would be refused')`, equals: true },
  { action: 'assert', name: 'and the write is disabled while any line is bad', expression: confirmDisabled, equals: true },
  { action: 'capture', name: '13-qa-cohort-refused', fullPage: false },
  { action: 'fill', selector: '[role=dialog] textarea', value: `# the walk's two-account cohort\nUSER ${COHORT[0].id} ${COHORT[0].ref}\nUSER,${COHORT[1].id},${COHORT[1].ref}` },
  { action: 'assert', name: 'a clean cohort is counted before it is written', expression: `${dialogText}.includes('2 accounts ready')`, equals: true },
  { action: 'assert', name: 'comments and comma separators both parse', expression: confirmDisabled, equals: false },
  { action: 'capture', name: '14-qa-cohort-ready', fullPage: false },
  { action: 'clickText', within: DIALOG_FOOTER, text: 'Mark 2 accounts' },
  { action: 'waitFor', name: 'the cohort dialog closes', expression: dialogOpen, equals: false },
  { action: 'waitFor', name: 'the cohort wrote as one transaction', expression: stat('Test accounts'), equals: '2' },
  { action: 'waitFor', name: 'both accounts are listed with their own reference', expression: `${rowText}.includes(${JSON.stringify(COHORT[0].ref)}) && ${rowText}.includes(${JSON.stringify(COHORT[1].ref)})`, equals: true },
  { action: 'waitFor', name: 'their history is test activity too', expression: `${statNumber('Test money rows')} > 0`, equals: true },
  { action: 'scroll', top: 0 },
  { action: 'capture', name: '15-qa-cohort-marked' },

  // --- Undo the cohort, one account at a time ----------------------------------
  ...unmarkOne(COHORT[0].username),
  { action: 'waitFor', name: 'the first cohort account is unmarked', expression: stat('Test accounts'), equals: '1' },
  ...unmarkOne(COHORT[1].username),
  { action: 'waitFor', name: 'the cohort is fully unmarked', expression: stat('Test accounts'), equals: '0' },
  { action: 'waitFor', name: 'and the book is production again', expression: stat('Test money rows'), equals: '0' },

  // --- Leave the screen as it was found ---------------------------------------
  { action: 'fill', selector: SEARCH, value: '' },
  { action: 'click', selector: SWITCH },
  { action: 'waitFor', name: 'the empty state is the one an operator should see', expression: `${mainText}.includes('No account is marked yet')`, equals: true },
  { action: 'assert', name: 'the walk left nothing marked', expression: stat('Test accounts'), equals: '0' },
  { action: 'assert', name: 'and no test money behind it', expression: stat('Test money rows'), equals: '0' },
  { action: 'scroll', top: 0 },
  { action: 'capture', name: '16-qa-clean' },
];