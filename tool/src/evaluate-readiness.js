// Certification readiness evaluator.
//
// Pure function: no network, no Airtable, no LTI. Takes a course snapshot and
// a rule set, returns readiness rows and issues. That makes every interesting
// case unit-testable without standing anything up.
//
// Three outcomes per requirement, not two:
//   met           the learner satisfied it
//   unmet         the learner did not satisfy it
//   inconclusive  we could not tell -- a broken rule, or data we cannot reach
//
// The third one is the whole point. "We don't know" is operationally different
// from "they failed": one means chase the learner, the other means fix the
// configuration. Collapsing them sends staff after the wrong people.

import { createHash } from 'node:crypto';

export const OUTCOME = { MET: 'met', UNMET: 'unmet', INCONCLUSIVE: 'inconclusive' };
export const STATUS = { READY: 'ready', NOT_READY: 'not_ready', NEEDS_REVIEW: 'needs_review' };

function fingerprint(...parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function pct(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

/** Airtable records -> plain requirement objects. */
export function normalizeRequirements(records) {
  return records
    .map((r) => r.fields ?? r)
    .map((f) => ({
      name: f.name,
      type: f.type,
      resourceId: f.line_item_resource_id ?? null,
      threshold: f.threshold ?? null,
      required: f.required !== false,
      sortOrder: f.sort_order ?? 0,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Evaluate one requirement for one learner.
 * @returns {{outcome: string, value: number|null, label: string, reason?: string}}
 */
function evaluateOne(requirement, lineItem, result) {
  // The rule points at coursework that does not exist in this course. Not the
  // learner's problem -- almost always a copied course with new line items, or
  // a typo in the resource id.
  if (!lineItem) {
    return {
      outcome: OUTCOME.INCONCLUSIVE,
      value: null,
      label: 'No matching coursework',
      reason: `No line item with resourceId "${requirement.resourceId}" in this course`,
    };
  }

  switch (requirement.type) {
    case 'min_score': {
      if (requirement.threshold == null) {
        return {
          outcome: OUTCOME.INCONCLUSIVE,
          value: null,
          label: 'Rule incomplete',
          reason: `min_score requirement "${requirement.name}" has no threshold set`,
        };
      }
      if (!result || result.score == null) {
        return {
          outcome: OUTCOME.UNMET,
          value: null,
          label: 'Not graded',
        };
      }
      const fraction = result.percent;
      return {
        outcome: fraction >= requirement.threshold ? OUTCOME.MET : OUTCOME.UNMET,
        value: Number(fraction.toFixed(4)),
        label: `${result.score}/${result.maximum} (${pct(fraction)})`,
      };
    }

    case 'submission_exists': {
      // A result row is proof of submission regardless of score. A zero counts
      // as submitted; quality is a separate min_score requirement's job.
      const submitted = Boolean(result);
      return {
        outcome: submitted ? OUTCOME.MET : OUTCOME.UNMET,
        value: submitted ? 1 : 0,
        label: submitted
          ? `Submitted (${result.score ?? 'ungraded'}/${result.maximum})`
          : 'No submission',
      };
    }

    case 'completion': {
      // Module completion is not exposed over AGS. It needs the Canvas REST
      // provider. Rather than guessing, say so.
      return {
        outcome: OUTCOME.INCONCLUSIVE,
        value: null,
        label: 'Not available over AGS',
        reason: `"${requirement.name}" is type completion, which requires the Canvas REST provider`,
      };
    }

    default:
      return {
        outcome: OUTCOME.INCONCLUSIVE,
        value: null,
        label: 'Unknown rule type',
        reason: `Requirement "${requirement.name}" has unrecognized type "${requirement.type}"`,
      };
  }
}

/**
 * @param {object} snapshot    from fetchCourseSnapshot
 * @param {Array}  requirements from normalizeRequirements
 * @returns {{learners: Array, readiness: Array, issues: Array, summary: object}}
 */
export function evaluateReadiness(snapshot, requirements, { evaluatedAt } = {}) {
  const timestamp = evaluatedAt ?? new Date().toISOString();
  const contextId = snapshot.context?.id ?? 'unknown';

  const byResourceId = new Map(
    snapshot.lineItems.filter((i) => i.resourceId).map((i) => [i.resourceId, i])
  );

  const issues = [];
  const seenFingerprints = new Set();
  function raise(issue) {
    if (seenFingerprints.has(issue.fingerprint)) {
      const existing = issues.find((i) => i.fingerprint === issue.fingerprint);
      existing.occurrences += 1;
      return;
    }
    seenFingerprints.add(issue.fingerprint);
    issues.push({ ...issue, occurrences: 1 });
  }

  // --- Rule-level problems, raised once each rather than once per learner ---
  for (const requirement of requirements) {
    if (requirement.resourceId && !byResourceId.has(requirement.resourceId)) {
      raise({
        fingerprint: fingerprint('missing_line_item', contextId, requirement.resourceId),
        classification: 'data_quality',
        title: `Requirement "${requirement.name}" points at missing coursework`,
        detail: `No line item with resourceId "${requirement.resourceId}" exists in ${contextId}. Every learner will be inconclusive for this requirement until the rule or the course is corrected.`,
      });
    }
    if (requirement.type === 'min_score' && requirement.threshold == null) {
      raise({
        fingerprint: fingerprint('missing_threshold', contextId, requirement.name),
        classification: 'data_quality',
        title: `Requirement "${requirement.name}" has no threshold`,
        detail: 'A min_score requirement without a threshold cannot be evaluated. Set threshold as a fraction of the maximum score, e.g. 0.8 for 80%.',
      });
    }
  }

  // --- Per learner ---------------------------------------------------------
  const learners = [];
  const readiness = [];
  const unjoinable = [];

  for (const learner of snapshot.learners) {
    // No sourced id means we cannot reliably match this person to a program
    // record. Evaluate anyway so staff can see the situation, but flag it --
    // silently dropping someone is how a learner misses a voucher deadline.
    const joinable = Boolean(learner.sourcedId);
    if (!joinable) unjoinable.push(learner);

    const joinKey = joinable ? learner.sourcedId : `canvas:${learner.userId}`;

    let met = 0;
    let requiredTotal = 0;
    const blocking = [];
    let anyInconclusive = false;

    for (const requirement of requirements) {
      const lineItem = requirement.resourceId ? byResourceId.get(requirement.resourceId) : null;
      const result = lineItem ? snapshot.scores[lineItem.id]?.[learner.userId] : undefined;
      const evaluation = evaluateOne(requirement, lineItem, result);

      if (requirement.required) {
        requiredTotal += 1;
        if (evaluation.outcome === OUTCOME.MET) met += 1;
        else blocking.push(requirement.name);
        if (evaluation.outcome === OUTCOME.INCONCLUSIVE) anyInconclusive = true;
      }

      readiness.push({
        key: `${joinKey}::${requirement.name}`,
        sourcedId: joinKey,
        requirementName: requirement.name,
        met: evaluation.outcome === OUTCOME.MET,
        outcome: evaluation.outcome,
        observedValue: evaluation.value,
        observedLabel: evaluation.label,
        evaluatedAt: timestamp,
      });
    }

    let status;
    if (!joinable || anyInconclusive) status = STATUS.NEEDS_REVIEW;
    else if (met === requiredTotal) status = STATUS.READY;
    else status = STATUS.NOT_READY;

    const blockingSummary = !joinable
      ? 'No sourced_id from Canvas; cannot match to a program record.'
      : blocking.length
        ? blocking.join('; ')
        : '';

    learners.push({
      sourcedId: joinKey,
      joinable,
      canvasUserId: learner.userId,
      displayName: learner.name,
      email: learner.email,
      status,
      requirementsMet: met,
      requirementsTotal: requiredTotal,
      blockingSummary,
      evaluatedAt: timestamp,
    });
  }

  // One issue for all unjoinable learners, not one each. A cohort missing SIS
  // ids should produce a single task naming everyone, not thirty tasks.
  if (unjoinable.length) {
    raise({
      fingerprint: fingerprint('missing_sourced_id', contextId),
      classification: 'data_quality',
      title: `${unjoinable.length} learner(s) have no sourced_id`,
      detail:
        `Cannot join to program records in ${contextId}: ` +
        unjoinable.map((l) => `${l.name ?? l.userId} (${l.userId})`).join(', ') +
        '. Set lis_person_sourcedid in the SIS integration, then re-run.',
    });
  }

  const summary = {
    contextId,
    evaluatedAt: timestamp,
    learnersEvaluated: learners.length,
    ready: learners.filter((l) => l.status === STATUS.READY).length,
    notReady: learners.filter((l) => l.status === STATUS.NOT_READY).length,
    needsReview: learners.filter((l) => l.status === STATUS.NEEDS_REVIEW).length,
    readinessRows: readiness.length,
    issues: issues.length,
  };

  return { learners, readiness, issues, summary };
}
