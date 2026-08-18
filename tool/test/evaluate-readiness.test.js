// Run with:  node --test
//
// No network, no Airtable, no running servers. The snapshot below is the same
// shape fetchCourseSnapshot returns, hand-built to match the mock platform's
// seed data so these tests and the live demo agree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReadiness, normalizeRequirements, STATUS, OUTCOME } from '../src/evaluate-readiness.js';

const LI = (id) => `http://localhost:4000/context/course-101/line_items/${id}`;

const snapshot = {
  context: { id: 'course-101', label: 'DEMO101', title: 'IT Support Cohort 24-A' },
  learners: [
    { userId: 'user-42', name: 'Ada Lovelace', email: 'ada@example.com', sourcedId: 'PS-24A-0001' },
    { userId: 'user-43', name: 'Grace Hopper', email: 'grace@example.com', sourcedId: 'PS-24A-0002' },
    { userId: 'user-44', name: 'Katherine Johnson', email: 'k@example.com', sourcedId: 'PS-24A-0003' },
    { userId: 'user-45', name: 'Mary Jackson', email: 'mary@example.com', sourcedId: null },
  ],
  lineItems: [
    { id: LI('li-1'), label: 'Hardware Fundamentals Final', resourceId: 'HW-FINAL', scoreMaximum: 100 },
    { id: LI('li-2'), label: 'Networking Lab Practical', resourceId: 'NET-LAB', scoreMaximum: 50 },
    { id: LI('li-3'), label: 'Professional Skills Portfolio', resourceId: 'PRO-PORT', scoreMaximum: 20 },
    { id: LI('li-4'), label: 'Mock Certification Exam', resourceId: 'MOCK-CERT', scoreMaximum: 100 },
  ],
  scores: {
    [LI('li-1')]: {
      'user-42': { score: 94, maximum: 100, percent: 0.94 },
      'user-43': { score: 88, maximum: 100, percent: 0.88 },
      'user-44': { score: 71, maximum: 100, percent: 0.71 },
      'user-45': { score: 90, maximum: 100, percent: 0.9 },
    },
    [LI('li-2')]: {
      'user-42': { score: 47, maximum: 50, percent: 0.94 },
      'user-43': { score: 44, maximum: 50, percent: 0.88 },
      'user-44': { score: 38, maximum: 50, percent: 0.76 },
      'user-45': { score: 41, maximum: 50, percent: 0.82 },
    },
    [LI('li-3')]: {
      'user-42': { score: 20, maximum: 20, percent: 1 },
      'user-43': { score: 18, maximum: 20, percent: 0.9 },
      // Katherine: no portfolio submission
      'user-45': { score: 16, maximum: 20, percent: 0.8 },
    },
    [LI('li-4')]: {
      'user-42': { score: 91, maximum: 100, percent: 0.91 },
      'user-43': { score: 79, maximum: 100, percent: 0.79 },
      'user-44': { score: 82, maximum: 100, percent: 0.82 },
      // Mary: has not sat the mock exam
    },
  },
  fetchedAt: '2026-08-15T00:00:00.000Z',
};

const requirements = normalizeRequirements([
  { name: 'Hardware Fundamentals Final', type: 'min_score', line_item_resource_id: 'HW-FINAL', threshold: 0.7, required: true, sort_order: 1 },
  { name: 'Networking Lab Practical', type: 'min_score', line_item_resource_id: 'NET-LAB', threshold: 0.7, required: true, sort_order: 2 },
  { name: 'Professional Skills Portfolio', type: 'submission_exists', line_item_resource_id: 'PRO-PORT', required: true, sort_order: 3 },
  { name: 'Mock Certification Exam', type: 'min_score', line_item_resource_id: 'MOCK-CERT', threshold: 0.8, required: true, sort_order: 4 },
]);

const run = (reqs = requirements, snap = snapshot) =>
  evaluateReadiness(snap, reqs, { evaluatedAt: '2026-08-15T12:00:00.000Z' });

const learner = (result, name) => result.learners.find((l) => l.displayName === name);
const row = (result, sourcedId, requirementName) =>
  result.readiness.find((r) => r.sourcedId === sourcedId && r.requirementName === requirementName);

test('Ada meets every requirement and is ready', () => {
  const ada = learner(run(), 'Ada Lovelace');
  assert.equal(ada.status, STATUS.READY);
  assert.equal(ada.requirementsMet, 4);
  assert.equal(ada.requirementsTotal, 4);
  assert.equal(ada.blockingSummary, '');
});

test('Grace misses the mock exam threshold by one point', () => {
  const result = run();
  const grace = learner(result, 'Grace Hopper');

  assert.equal(grace.status, STATUS.NOT_READY);
  assert.equal(grace.requirementsMet, 3);
  assert.equal(grace.blockingSummary, 'Mock Certification Exam');

  // 0.79 against a 0.80 threshold. If this ever passes, someone loosened the
  // comparison to <= or rounded the percentage before comparing.
  const mock = row(result, 'PS-24A-0002', 'Mock Certification Exam');
  assert.equal(mock.outcome, OUTCOME.UNMET);
  assert.equal(mock.observedValue, 0.79);
});

test('Katherine fails only on the missing portfolio submission', () => {
  const result = run();
  const katherine = learner(result, 'Katherine Johnson');

  assert.equal(katherine.status, STATUS.NOT_READY);
  assert.equal(katherine.blockingSummary, 'Professional Skills Portfolio');

  const portfolio = row(result, 'PS-24A-0003', 'Professional Skills Portfolio');
  assert.equal(portfolio.outcome, OUTCOME.UNMET);
  assert.equal(portfolio.observedLabel, 'No submission');
});

test('Mary is needs_review rather than not_ready, despite failing a requirement', () => {
  const result = run();
  const mary = learner(result, 'Mary Jackson');

  // She has no mock exam score, so she genuinely fails a requirement. But the
  // missing sourced_id dominates: we cannot trust the match, so the answer is
  // "look at this", not "she isn't ready".
  assert.equal(mary.status, STATUS.NEEDS_REVIEW);
  assert.equal(mary.joinable, false);
  assert.match(mary.blockingSummary, /No sourced_id/);
  assert.equal(mary.sourcedId, 'canvas:user-45');
});

test('unjoinable learners produce one aggregate issue, not one each', () => {
  const twoUnjoinable = {
    ...snapshot,
    learners: [
      ...snapshot.learners,
      { userId: 'user-46', name: 'Annie Easley', email: 'a@example.com', sourcedId: null },
    ],
  };

  const result = run(requirements, twoUnjoinable);
  const sourcedIdIssues = result.issues.filter((i) => i.title.includes('sourced_id'));

  assert.equal(sourcedIdIssues.length, 1);
  assert.match(sourcedIdIssues[0].title, /^2 learner/);
  assert.match(sourcedIdIssues[0].detail, /Mary Jackson/);
  assert.match(sourcedIdIssues[0].detail, /Annie Easley/);
});

test('a requirement pointing at missing coursework is inconclusive, not failed', () => {
  const withTypo = normalizeRequirements([
    { name: 'Capstone Project', type: 'min_score', line_item_resource_id: 'TYPO-XYZ', threshold: 0.7, required: true, sort_order: 1 },
  ]);

  const result = run(withTypo);
  const ada = learner(result, 'Ada Lovelace');

  // Ada did nothing wrong. The rule is broken, so nobody is "not ready" --
  // everybody is unreviewable until it's fixed.
  assert.equal(ada.status, STATUS.NEEDS_REVIEW);

  const issue = result.issues.find((i) => i.title.includes('missing coursework'));
  assert.ok(issue);
  assert.equal(issue.classification, 'data_quality');
});

test('a min_score rule with no threshold is inconclusive', () => {
  const noThreshold = normalizeRequirements([
    { name: 'Final Exam', type: 'min_score', line_item_resource_id: 'HW-FINAL', required: true, sort_order: 1 },
  ]);

  const result = run(noThreshold);
  assert.equal(learner(result, 'Ada Lovelace').status, STATUS.NEEDS_REVIEW);
  assert.ok(result.issues.some((i) => i.title.includes('no threshold')));
});

test('a zero score still counts as a submission', () => {
  const zeroed = {
    ...snapshot,
    scores: {
      ...snapshot.scores,
      [LI('li-3')]: { 'user-44': { score: 0, maximum: 20, percent: 0 } },
    },
  };

  const portfolio = row(run(requirements, zeroed), 'PS-24A-0003', 'Professional Skills Portfolio');
  assert.equal(portfolio.outcome, OUTCOME.MET);
});

test('an ungraded min_score is unmet, not inconclusive', () => {
  // Mary has no mock exam result. "Not graded yet" is a real blocker for a
  // voucher deadline, so it counts against her rather than being unknowable.
  const mock = row(run(), 'canvas:user-45', 'Mock Certification Exam');
  assert.equal(mock.outcome, OUTCOME.UNMET);
  assert.equal(mock.observedLabel, 'Not graded');
});

test('summary counts match the documented demo outcome', () => {
  const { summary } = run();
  assert.equal(summary.learnersEvaluated, 4);
  assert.equal(summary.ready, 1);
  assert.equal(summary.notReady, 2);
  assert.equal(summary.needsReview, 1);
  assert.equal(summary.readinessRows, 16);
});

test('readiness keys are stable across runs', () => {
  const a = run().readiness.map((r) => r.key);
  const b = run().readiness.map((r) => r.key);
  assert.deepEqual(a, b);
  assert.ok(a.includes('PS-24A-0001::Mock Certification Exam'));
});
