/**
  The documented test cases, running in Apps Script.
 
  Apps Script has no test runner, so this is a small assertion harness. Run
  runTests() from the editor and read the execution log. Everything here is
  pure -- no network, no Airtable, no Canvas -- so it takes milliseconds and
  works with every credential wrong.
 
  Test data matches the mock Canvas fixture exactly, so a pass here and a pass
  against the live endpoints mean the same thing.
  It does mean that if for any reason the mock data for canvas changes, they 
  need to be changed here too. 
 */

// a snapshot of the mock Canvas fixture, with a few extra fields for testing
function fixtureSnapshot_() {
  return {
    context: { id: 'course-101', label: 'DEMO101', title: 'IT Support Cohort 24-A' },
    learners: [
      { userId: '42', name: 'Ada Lovelace', email: 'ada@example.com', sourcedId: 'PS-24A-0001' },
      { userId: '43', name: 'Grace Hopper', email: 'grace@example.com', sourcedId: 'PS-24A-0002' },
      { userId: '44', name: 'Katherine Johnson', email: 'k@example.com', sourcedId: 'PS-24A-0003' },
      { userId: '45', name: 'Mary Jackson', email: 'mary@example.com', sourcedId: null },
    ],
    lineItems: [
      { id: '1', label: 'Hardware Fundamentals Final', resourceId: 'HW-FINAL', scoreMaximum: 100 },
      { id: '2', label: 'Networking Lab Practical', resourceId: 'NET-LAB', scoreMaximum: 50 },
      { id: '3', label: 'Professional Skills Portfolio', resourceId: 'PRO-PORT', scoreMaximum: 20 },
      { id: '4', label: 'Mock Certification Exam', resourceId: 'MOCK-CERT', scoreMaximum: 100 },
    ],
    scores: {
      '1': {
        '42': { score: 94, maximum: 100, percent: 0.94, submitted: true },
        '43': { score: 88, maximum: 100, percent: 0.88, submitted: true },
        '44': { score: 71, maximum: 100, percent: 0.71, submitted: true },
        '45': { score: 90, maximum: 100, percent: 0.90, submitted: true },
      },
      '2': {
        '42': { score: 47, maximum: 50, percent: 0.94, submitted: true },
        '43': { score: 44, maximum: 50, percent: 0.88, submitted: true },
        '44': { score: 38, maximum: 50, percent: 0.76, submitted: true },
        '45': { score: 41, maximum: 50, percent: 0.82, submitted: true },
      },
      '3': {
        '42': { score: 20, maximum: 20, percent: 1.0, submitted: true },
        '43': { score: 18, maximum: 20, percent: 0.90, submitted: true },
        // Katherine: no portfolio submission
        '45': { score: 16, maximum: 20, percent: 0.80, submitted: true },
      },
      '4': {
        '42': { score: 91, maximum: 100, percent: 0.91, submitted: true },
        '43': { score: 79, maximum: 100, percent: 0.79, submitted: true },
        '44': { score: 82, maximum: 100, percent: 0.82, submitted: true },
        // Mary: has not sat the mock exam
      },
    },
    fetchedAt: '2026-08-15T00:00:00.000Z',
  };
}

function fixtureRequirements_() {
  return normalizeRequirements_([
    { name: 'Hardware Fundamentals Final', type: 'min_score', line_item_resource_id: 'HW-FINAL', threshold: 0.7, required: true, sort_order: 1 },
    { name: 'Networking Lab Practical', type: 'min_score', line_item_resource_id: 'NET-LAB', threshold: 0.7, required: true, sort_order: 2 },
    { name: 'Professional Skills Portfolio', type: 'submission_exists', line_item_resource_id: 'PRO-PORT', required: true, sort_order: 3 },
    { name: 'Mock Certification Exam', type: 'min_score', line_item_resource_id: 'MOCK-CERT', threshold: 0.8, required: true, sort_order: 4 },
  ]);
}

// --- Harness ---------------------------------------------------------------

let TEST_RESULTS_ = [];

function check_(name, fn) {
  try {
    fn();
    TEST_RESULTS_.push({ ok: true, name: name });
  } catch (err) {
    TEST_RESULTS_.push({ ok: false, name: name, message: err.message });
  }
}

function assertEqual_(actual, expected, what) {
  if (actual !== expected) {
    throw new Error((what || 'value') + ': expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual));
  }
}

function assertMatch_(actual, pattern, what) {
  if (!pattern.test(String(actual))) {
    throw new Error((what || 'value') + ': ' + JSON.stringify(actual) + ' does not match ' + pattern);
  }
}

function learner_(result, name) {
  return result.learners.filter((l) => l.displayName === name)[0];
}

function row_(result, sourcedId, requirementName) {
  return result.readiness.filter((r) =>
    r.sourcedId === sourcedId && r.requirementName === requirementName)[0];
}

function run_(requirements, snapshot) {
  return evaluateReadiness_(
    snapshot || fixtureSnapshot_(),
    requirements || fixtureRequirements_(),
    '2026-08-15T12:00:00.000Z'
  );
}

// --- The cases -------------------------------------------------------------

function runTests() {
  TEST_RESULTS_ = [];

  check_('TC-01 Ada meets every requirement and is ready', () => {
    const ada = learner_(run_(), 'Ada Lovelace');
    assertEqual_(ada.status, STATUS.READY, 'status');
    assertEqual_(ada.requirementsMet, 4, 'met');
    assertEqual_(ada.blockingSummary, '', 'blocking');
  });

  check_('TC-02 Grace misses the mock exam threshold by one point', () => {
    const result = run_();
    const grace = learner_(result, 'Grace Hopper');
    assertEqual_(grace.status, STATUS.NOT_READY, 'status');
    assertEqual_(grace.blockingSummary, 'Mock Certification Exam', 'blocking');

    // 0.79 against 0.80. If this passes, someone loosened the comparison or
    // rounded the percentage before comparing.
    const mock = row_(result, 'PS-24A-0002', 'Mock Certification Exam');
    assertEqual_(mock.outcome, OUTCOME.UNMET, 'outcome');
    assertEqual_(mock.observedValue, 0.79, 'observed');
  });

  check_('TC-03 Katherine fails only on the missing portfolio', () => {
    const result = run_();
    const katherine = learner_(result, 'Katherine Johnson');
    assertEqual_(katherine.status, STATUS.NOT_READY, 'status');
    assertEqual_(katherine.blockingSummary, 'Professional Skills Portfolio', 'blocking');
    assertEqual_(row_(result, 'PS-24A-0003', 'Professional Skills Portfolio').observedLabel,
      'No submission', 'label');
  });

  check_('TC-04 Mary is needs_review, not not_ready', () => {
    const mary = learner_(run_(), 'Mary Jackson');
    assertEqual_(mary.status, STATUS.NEEDS_REVIEW, 'status');
    assertEqual_(mary.joinable, false, 'joinable');
    assertEqual_(mary.sourcedId, 'canvas:45', 'fallback key');
    assertMatch_(mary.blockingSummary, /No SIS ID/, 'blocking');
  });

  check_('TC-05 unjoinable learners produce one aggregate issue', () => {
    const snapshot = fixtureSnapshot_();
    snapshot.learners.push({ userId: '46', name: 'Annie Easley', email: 'a@example.com', sourcedId: null });

    const issues = run_(null, snapshot).issues.filter((i) => i.title.indexOf('SIS ID') !== -1);
    assertEqual_(issues.length, 1, 'issue count');
    assertMatch_(issues[0].title, /^2 learner/, 'title');
    assertMatch_(issues[0].detail, /Annie Easley/, 'detail');
  });

  check_('TC-06 requirement pointing at missing coursework is inconclusive', () => {
    const broken = normalizeRequirements_([
      { name: 'Capstone Project', type: 'min_score', line_item_resource_id: 'TYPO-XYZ', threshold: 0.7, required: true, sort_order: 1 },
    ]);
    const result = run_(broken);

    // Ada did nothing wrong. The rule is broken, so nobody is "not ready" --
    // everybody is unreviewable until it is fixed.
    assertEqual_(learner_(result, 'Ada Lovelace').status, STATUS.NEEDS_REVIEW, 'status');
    assertEqual_(result.issues.filter((i) => i.title.indexOf('missing coursework') !== -1).length, 1, 'issue');
  });

  check_('TC-07 min_score with no threshold is inconclusive', () => {
    const noThreshold = normalizeRequirements_([
      { name: 'Final Exam', type: 'min_score', line_item_resource_id: 'HW-FINAL', required: true, sort_order: 1 },
    ]);
    const result = run_(noThreshold);
    assertEqual_(learner_(result, 'Ada Lovelace').status, STATUS.NEEDS_REVIEW, 'status');
    assertEqual_(result.issues.filter((i) => i.title.indexOf('no threshold') !== -1).length, 1, 'issue');
  });

  check_('TC-08 a zero score still counts as a submission', () => {
    const snapshot = fixtureSnapshot_();
    snapshot.scores['3'] = { '44': { score: 0, maximum: 20, percent: 0, submitted: true } };
    assertEqual_(row_(run_(null, snapshot), 'PS-24A-0003', 'Professional Skills Portfolio').outcome,
      OUTCOME.MET, 'outcome');
  });

  check_('TC-08b handed in but ungraded still counts as a submission', () => {
    // Canvas REST can express this; AGS cannot. A learner who submitted and is
    // waiting on an instructor has met a submission_exists requirement.
    const snapshot = fixtureSnapshot_();
    snapshot.scores['3'] = { '44': { score: null, maximum: 20, percent: null, submitted: true } };
    const cell = row_(run_(null, snapshot), 'PS-24A-0003', 'Professional Skills Portfolio');
    assertEqual_(cell.outcome, OUTCOME.MET, 'outcome');
    assertMatch_(cell.observedLabel, /ungraded/, 'label');
  });

  check_('TC-09 an ungraded min_score is unmet, not inconclusive', () => {
    const mock = row_(run_(), 'canvas:45', 'Mock Certification Exam');
    assertEqual_(mock.outcome, OUTCOME.UNMET, 'outcome');
    assertEqual_(mock.observedLabel, 'Not graded', 'label');
  });

  check_('TC-10 summary counts reconcile', () => {
    const summary = run_().summary;
    assertEqual_(summary.learnersEvaluated, 4, 'evaluated');
    assertEqual_(summary.ready, 1, 'ready');
    assertEqual_(summary.notReady, 2, 'not ready');
    assertEqual_(summary.needsReview, 1, 'needs review');
    assertEqual_(summary.readinessRows, 16, 'rows');
  });

  check_('TC-11 readiness keys are stable across runs', () => {
    const a = run_().readiness.map((r) => r.key).join('|');
    const b = run_().readiness.map((r) => r.key).join('|');
    assertEqual_(a, b, 'keys');
    if (a.indexOf('PS-24A-0001::Mock Certification Exam') === -1) {
      throw new Error('expected key format not found');
    }
  });

  // --- Report -------------------------------------------------------------
  const passed = TEST_RESULTS_.filter((r) => r.ok).length;
  const lines = TEST_RESULTS_.map((r) =>
    (r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '\n        ' + r.message));

  lines.push('', passed + '/' + TEST_RESULTS_.length + ' passed');
  Logger.log(lines.join('\n'));

  if (passed < TEST_RESULTS_.length) {
    throw new Error((TEST_RESULTS_.length - passed) + ' test(s) failed. See the log.');
  }
  return TEST_RESULTS_;
}