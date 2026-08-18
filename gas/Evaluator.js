/**
  Certification readiness evaluator.
 
  Pure logic: no UrlFetchApp, no Airtable, no Canvas. Takes a snapshot and a
  rule set, returns readiness rows and issues. That makes it testable from the
  editor in milliseconds and identical to the Node implementation, so both can
  be verified against the same documented test cases.
 
  Three outcomes per requirement, not two:
    met           the learner satisfied it
    unmet         the learner did not satisfy it
    inconclusive  we could not tell -- a broken rule, or data we cannot reach
 
  The third is the whole point. "We don't know" is operationally different
  from "they failed": one means fix a configuration, the other means chase a
  learner. Collapsing them sends staff after the wrong people.
 */

const OUTCOME = { MET: 'met', UNMET: 'unmet', INCONCLUSIVE: 'inconclusive' };
const STATUS = { READY: 'ready', NOT_READY: 'not_ready', NEEDS_REVIEW: 'needs_review' };

function fingerprint_(parts) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    parts.join('|'),
    Utilities.Charset.UTF_8
  );
  return bytes
    .map((b) => ('0' + (b & 0xff).toString(16)).slice(-2))
    .join('')
    .slice(0, 16);
}

function normalizeRequirements_(records) {
  return records
    .map((r) => r.fields || r)
    .map((f) => ({
      name: f.name,
      type: f.type,
      resourceId: f.line_item_resource_id || null,
      threshold: f.threshold === undefined ? null : f.threshold,
      required: f.required !== false,
      sortOrder: f.sort_order || 0,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function evaluateOne_(requirement, lineItem, result) {
  // The rule points at coursework that does not exist in this course. Not the
  // learner's problem -- usually a course copy with new assignment ids, or a
  // typo in the integration id.
  if (!lineItem) {
    return {
      outcome: OUTCOME.INCONCLUSIVE,
      value: null,
      label: 'No matching coursework',
      reason: 'No assignment with integration_id "' + requirement.resourceId + '" in this course',
    };
  }

  if (requirement.type === 'min_score') {
    if (requirement.threshold === null || requirement.threshold === undefined) {
      return {
        outcome: OUTCOME.INCONCLUSIVE,
        value: null,
        label: 'Rule incomplete',
        reason: 'min_score requirement "' + requirement.name + '" has no threshold set',
      };
    }
    if (!result || result.score === null || result.score === undefined) {
      return { outcome: OUTCOME.UNMET, value: null, label: 'Not graded' };
    }
    const fraction = result.percent;
    return {
      outcome: fraction >= requirement.threshold ? OUTCOME.MET : OUTCOME.UNMET,
      value: Math.round(fraction * 10000) / 10000,
      label: result.score + '/' + result.maximum + ' (' + Math.round(fraction * 100) + '%)',
    };
  }

  if (requirement.type === 'submission_exists') {
    // A zero counts as submitted. "Submission exists" asks whether work was
    // handed in, not whether it was good -- quality is a min_score rule's job.
    //
    // Canvas REST reports `submitted` explicitly. AGS cannot, so there the
    // field is undefined and the presence of a result row stands in for it.
    const submitted = result
      ? (result.submitted === undefined ? true : result.submitted)
      : false;

    return {
      outcome: submitted ? OUTCOME.MET : OUTCOME.UNMET,
      value: submitted ? 1 : 0,
      label: submitted
        ? 'Submitted (' + (result.score === null ? 'ungraded' : result.score) + '/' + result.maximum + ')'
        : 'No submission',
    };
  }

  if (requirement.type === 'completion') {
    return {
      outcome: OUTCOME.INCONCLUSIVE,
      value: null,
      label: 'Module data not loaded',
      reason: '"' + requirement.name + '" is type completion, which needs the Canvas modules endpoint',
    };
  }

  return {
    outcome: OUTCOME.INCONCLUSIVE,
    value: null,
    label: 'Unknown rule type',
    reason: 'Requirement "' + requirement.name + '" has unrecognized type "' + requirement.type + '"',
  };
}

function evaluateReadiness_(snapshot, requirements, evaluatedAt) {
  const timestamp = evaluatedAt || new Date().toISOString();
  const contextId = (snapshot.context && snapshot.context.id) || 'unknown';

  const byResourceId = {};
  snapshot.lineItems.forEach((item) => {
    if (item.resourceId) byResourceId[item.resourceId] = item;
  });

  const issues = [];
  const seen = {};
  function raise(issue) {
    if (seen[issue.fingerprint]) {
      issues.forEach((i) => { if (i.fingerprint === issue.fingerprint) i.occurrences += 1; });
      return;
    }
    seen[issue.fingerprint] = true;
    issue.occurrences = 1;
    issues.push(issue);
  }

  // --- Rule-level problems, raised once each rather than once per learner ---
  requirements.forEach((requirement) => {
    if (requirement.resourceId && !byResourceId[requirement.resourceId]) {
      raise({
        fingerprint: fingerprint_(['missing_line_item', contextId, requirement.resourceId]),
        classification: 'data_quality',
        title: 'Requirement "' + requirement.name + '" points at missing coursework',
        detail: 'No assignment with integration_id "' + requirement.resourceId + '" exists in ' +
          contextId + '. Every learner is inconclusive for this requirement until the rule or the ' +
          'course is corrected.',
      });
    }
    if (requirement.type === 'min_score' &&
        (requirement.threshold === null || requirement.threshold === undefined)) {
      raise({
        fingerprint: fingerprint_(['missing_threshold', contextId, requirement.name]),
        classification: 'data_quality',
        title: 'Requirement "' + requirement.name + '" has no threshold',
        detail: 'A min_score requirement without a threshold cannot be evaluated. Set threshold ' +
          'as a fraction of the maximum score, e.g. 0.8 for 80%.',
      });
    }
  });

  // --- Per learner ---------------------------------------------------------
  const learners = [];
  const readiness = [];
  const unjoinable = [];

  snapshot.learners.forEach((learner) => {
    // No SIS id means we cannot reliably match this person to a program
    // record. Evaluate anyway so staff can see the situation, but flag it --
    // silently dropping someone is how a learner misses a voucher deadline.
    const joinable = Boolean(learner.sourcedId);
    if (!joinable) unjoinable.push(learner);

    const joinKey = joinable ? learner.sourcedId : 'canvas:' + learner.userId;

    let met = 0;
    let requiredTotal = 0;
    const blocking = [];
    let anyInconclusive = false;

    requirements.forEach((requirement) => {
      const lineItem = requirement.resourceId ? byResourceId[requirement.resourceId] : null;
      const cell = lineItem && snapshot.scores[lineItem.id]
        ? snapshot.scores[lineItem.id][learner.userId]
        : undefined;
      const evaluation = evaluateOne_(requirement, lineItem, cell);

      if (requirement.required) {
        requiredTotal += 1;
        if (evaluation.outcome === OUTCOME.MET) met += 1;
        else blocking.push(requirement.name);
        if (evaluation.outcome === OUTCOME.INCONCLUSIVE) anyInconclusive = true;
      }

      readiness.push({
        key: joinKey + '::' + requirement.name,
        sourcedId: joinKey,
        requirementName: requirement.name,
        met: evaluation.outcome === OUTCOME.MET,
        outcome: evaluation.outcome,
        observedValue: evaluation.value,
        observedLabel: evaluation.label,
        evaluatedAt: timestamp,
      });
    });

    let status;
    if (!joinable || anyInconclusive) status = STATUS.NEEDS_REVIEW;
    else if (met === requiredTotal) status = STATUS.READY;
    else status = STATUS.NOT_READY;

    learners.push({
      sourcedId: joinKey,
      joinable: joinable,
      canvasUserId: learner.userId,
      displayName: learner.name,
      email: learner.email,
      status: status,
      requirementsMet: met,
      requirementsTotal: requiredTotal,
      blockingSummary: !joinable
        ? 'No SIS ID from Canvas; cannot match to a program record.'
        : blocking.join('; '),
      evaluatedAt: timestamp,
    });
  });

  // One issue for all unjoinable learners, not one each. A cohort missing SIS
  // ids should produce a single ticket naming everyone, not thirty tickets.
  if (unjoinable.length) {
    raise({
      fingerprint: fingerprint_(['missing_sourced_id', contextId]),
      classification: 'data_quality',
      title: unjoinable.length + ' learner(s) have no SIS ID',
      detail: 'Cannot join to program records in ' + contextId + ': ' +
        unjoinable.map((l) => (l.name || l.userId) + ' (' + l.userId + ')').join(', ') +
        '. Set the SIS user id in Canvas, then re-run.',
    });
  }

  return {
    learners: learners,
    readiness: readiness,
    issues: issues,
    summary: {
      contextId: contextId,
      evaluatedAt: timestamp,
      learnersEvaluated: learners.length,
      ready: learners.filter((l) => l.status === STATUS.READY).length,
      notReady: learners.filter((l) => l.status === STATUS.NOT_READY).length,
      needsReview: learners.filter((l) => l.status === STATUS.NEEDS_REVIEW).length,
      readinessRows: readiness.length,
      issues: issues.length,
    },
  };
}