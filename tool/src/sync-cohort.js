// Sync orchestrator.
//
// Everything else in this project is a pure piece: the provider fetches, the
// evaluator decides, the client writes. This is where they meet, and where
// failure gets recorded rather than thrown away.
//
// Ordering matters and is not arbitrary:
//   1. open the Sync Run ledger row FIRST, so a crash still leaves evidence
//   2. load config from Airtable (cheap, fails fast on misconfiguration)
//   3. fetch from Canvas (slow, most likely to fail)
//   4. evaluate (pure, cannot fail on data)
//   5. write learners, then readiness (readiness links to learner ids)
//   6. reconcile issues
//   7. close the ledger row
//
// A run that dies at step 3 leaves a row with status "running" and no
// finished_at. That is how you tell an abandoned run from one that never
// started -- the difference between "the job crashed" and "the job never ran",
// which look identical without a ledger.

import { randomUUID } from 'node:crypto';
import { evaluateReadiness, normalizeRequirements, STATUS } from './evaluate-readiness.js';

export class SyncError extends Error {
  constructor(message, { classification = 'unclassified', cause } = {}) {
    super(message);
    this.name = 'SyncError';
    this.classification = classification;
    this.cause = cause;
  }
}

/**
 * Where the roster and gradebook live for this cohort.
 *
 * A launch is how the tool LEARNS these URLs -- they arrive as claims in the
 * id_token. Persisting them per (issuer, deployment, context) is the
 * production path, and the two optional Cohort fields below are the hook for
 * it. Until those exist we derive them, which works because the mock platform
 * uses predictable paths. Real Canvas does not.
 */
function resolveEndpoints(cohort) {
  const f = cohort.fields;

  if (f.memberships_url && f.line_items_url) {
    return { membershipsUrl: f.memberships_url, lineItemsUrl: f.line_items_url };
  }

  const issuer = f.platform_issuer;
  const contextId = f.canvas_context_id;
  if (!issuer || !contextId) {
    throw new SyncError(
      `Cohort "${f.name}" is missing platform_issuer or canvas_context_id`,
      { classification: 'config' }
    );
  }

  return {
    membershipsUrl: `${issuer}/context/${contextId}/memberships`,
    lineItemsUrl: `${issuer}/context/${contextId}/line_items`,
    derived: true,
  };
}

async function loadCohort(airtable, contextId) {
  const rows = await airtable.list('Cohorts', {
    filterByFormula: `{canvas_context_id} = '${contextId}'`,
  });

  if (rows.length === 0) {
    throw new SyncError(`No cohort in Airtable with canvas_context_id "${contextId}"`, {
      classification: 'config',
    });
  }
  if (rows.length > 1) {
    throw new SyncError(
      `${rows.length} cohorts share canvas_context_id "${contextId}". Context ids must be unique.`,
      { classification: 'config' }
    );
  }
  return rows[0];
}

async function loadRequirements(airtable, cohort) {
  const trackIds = cohort.fields.track ?? [];
  if (trackIds.length === 0) {
    throw new SyncError(`Cohort "${cohort.fields.name}" is not linked to a track`, {
      classification: 'config',
    });
  }

  const all = await airtable.list('Requirements');
  const forTrack = all.filter((r) => (r.fields.track ?? []).some((id) => trackIds.includes(id)));

  if (forTrack.length === 0) {
    throw new SyncError(
      `No requirements linked to the track for cohort "${cohort.fields.name}"`,
      { classification: 'config' }
    );
  }

  return forTrack;
}

/**
 * Issues are deduplicated by fingerprint across runs, not within one.
 *
 * A recurring problem increments a counter and refreshes last_seen; it does
 * not create a second row, and it will not create a second Asana task. An
 * issue that stops occurring is marked resolved, which closes the loop
 * automatically instead of leaving stale tasks for staff to garbage-collect.
 */
async function reconcileIssues(airtable, issues, { cohortId, syncRunId, timestamp }) {
  const existing = await airtable.list('Sync Issues');
  const byFingerprint = new Map(existing.map((r) => [r.fields.fingerprint, r]));
  const currentFingerprints = new Set(issues.map((i) => i.fingerprint));

  const creates = [];
  const updates = [];

  for (const issue of issues) {
    const prior = byFingerprint.get(issue.fingerprint);

    if (!prior) {
      creates.push({
        fingerprint: issue.fingerprint,
        classification: issue.classification,
        title: issue.title,
        detail: issue.detail,
        first_seen: timestamp,
        last_seen: timestamp,
        occurrence_count: 1,
        resolved: false,
        cohort: [cohortId],
        sync_run: [syncRunId],
      });
      continue;
    }

    updates.push({
      id: prior.id,
      fields: {
        last_seen: timestamp,
        occurrence_count: (prior.fields.occurrence_count ?? 0) + 1,
        // A resolved issue that recurs is reopened. The Asana layer reads this
        // transition to decide between commenting and filing fresh.
        resolved: false,
        detail: issue.detail,
        sync_run: [syncRunId],
      },
    });
  }

  // Anything previously open that did not recur is now fixed.
  const resolved = existing
    .filter((r) => !r.fields.resolved && !currentFingerprints.has(r.fields.fingerprint))
    .map((r) => ({ id: r.id, fields: { resolved: true } }));

  const created = creates.length ? await airtable.create('Sync Issues', creates) : [];
  if (updates.length) await airtable.update('Sync Issues', updates);
  if (resolved.length) await airtable.update('Sync Issues', resolved);

  return {
    opened: created.length,
    recurring: updates.length,
    resolved: resolved.length,
    // The Asana layer needs the full picture, including which are new.
    newIssues: issues.filter((i) => !byFingerprint.has(i.fingerprint)),
    records: [...created, ...existing],
  };
}

/**
 * Run one cohort end to end.
 *
 * @param {object} deps  { airtable, fetchSnapshot, platform }
 * @param {object} opts  { contextId, trigger, dryRun }
 */
export async function syncCohort({ airtable, fetchSnapshot, platform }, opts = {}) {
  const { contextId, trigger = 'manual', dryRun = false } = opts;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const log = [];
  const note = (line) => {
    log.push(line);
    if (opts.verbose !== false) console.log(`  ${line}`);
  };

  let cohort;
  let runRecordId = null;

  try {
    cohort = await loadCohort(airtable, contextId);
    note(`cohort: ${cohort.fields.name}`);

    // Open the ledger before doing anything expensive.
    if (!dryRun) {
      const [runRecord] = await airtable.create('Sync Runs', [
        {
          run_id: runId,
          trigger,
          status: 'running',
          started_at: startedAt,
          cohort: [cohort.id],
        },
      ]);
      runRecordId = runRecord.id;
    }

    const requirementRecords = await loadRequirements(airtable, cohort);
    note(`requirements: ${requirementRecords.length}`);

    const endpoints = resolveEndpoints(cohort);
    if (endpoints.derived) note('endpoints derived from issuer + context id (no launch persisted yet)');

    const snapshot = await fetchSnapshot(platform, endpoints);
    note(`snapshot: ${snapshot.learners.length} active learners, ${snapshot.lineItems.length} line items`);

    const requirements = normalizeRequirements(requirementRecords);
    const result = evaluateReadiness(snapshot, requirements);
    note(
      `evaluated: ${result.summary.ready} ready, ${result.summary.notReady} not ready, ` +
        `${result.summary.needsReview} needs review`
    );

    if (dryRun) {
      note('dry run - nothing written');
      return { runId, dryRun: true, ...result, log };
    }

    // --- Learners -----------------------------------------------------------
    // Merged on sourced_id. That is safe here because program ids encode the
    // cohort (PS-24A-0001). If they ever stop doing so, a learner in two
    // cohorts would collapse into one row and this needs a composite key.
    const learnerUpsert = await airtable.upsert(
      'Learners',
      result.learners.map((l) => ({
        display_name: l.displayName ?? l.canvasUserId,
        sourced_id: l.sourcedId,
        canvas_user_id: l.canvasUserId,
        email: l.email ?? undefined,
        enrollment_status: 'active',
        readiness_status: l.status,
        requirements_met: l.requirementsMet,
        requirements_total: l.requirementsTotal,
        blocking_summary: l.blockingSummary,
        last_evaluated_at: l.evaluatedAt,
        cohort: [cohort.id],
      })),
      ['sourced_id']
    );
    note(`learners: ${learnerUpsert.created} created, ${learnerUpsert.updated} updated`);

    // --- Readiness ----------------------------------------------------------
    // Needs record ids for the link fields, so it has to follow the learner
    // write rather than run alongside it.
    const learnerIdBySourcedId = new Map(
      learnerUpsert.records.map((r) => [r.fields.sourced_id, r.id])
    );
    const requirementIdByName = new Map(requirementRecords.map((r) => [r.fields.name, r.id]));

    const readinessRows = result.readiness.map((row) => ({
      key: row.key,
      met: row.met,
      observed_value: row.observedValue ?? undefined,
      observed_label: row.observedLabel,
      evaluated_at: row.evaluatedAt,
      learner: [learnerIdBySourcedId.get(row.sourcedId)].filter(Boolean),
      requirement: [requirementIdByName.get(row.requirementName)].filter(Boolean),
      sync_run: [runRecordId],
    }));

    const readinessUpsert = await airtable.upsert('Readiness', readinessRows, ['key']);
    note(`readiness: ${readinessUpsert.created} created, ${readinessUpsert.updated} updated`);

    // --- Issues -------------------------------------------------------------
    const issueSummary = await reconcileIssues(airtable, result.issues, {
      cohortId: cohort.id,
      syncRunId: runRecordId,
      timestamp: result.summary.evaluatedAt,
    });
    if (result.issues.length) {
      note(
        `issues: ${issueSummary.opened} new, ${issueSummary.recurring} recurring, ` +
          `${issueSummary.resolved} auto-resolved`
      );
    } else if (issueSummary.resolved) {
      note(`issues: ${issueSummary.resolved} auto-resolved, none outstanding`);
    }

    // --- Close the ledger ---------------------------------------------------
    const status = result.issues.length ? 'partial' : 'success';
    await airtable.update('Sync Runs', [
      {
        id: runRecordId,
        fields: {
          status,
          finished_at: new Date().toISOString(),
          learners_evaluated: result.summary.learnersEvaluated,
          records_written: learnerUpsert.created + learnerUpsert.updated +
            readinessUpsert.created + readinessUpsert.updated,
          error_summary: result.issues.map((i) => i.title).join('\n'),
        },
      },
    ]);

    return { runId, status, ...result, issueSummary, log };
  } catch (err) {
    const classification = err.classification ?? 'unclassified';

    // Best effort: if the ledger row exists, mark it failed. If this write is
    // what failed, there is nothing more to do but surface the original error.
    if (runRecordId && !dryRun) {
      try {
        await airtable.update('Sync Runs', [
          {
            id: runRecordId,
            fields: {
              status: 'failed',
              finished_at: new Date().toISOString(),
              error_summary: `[${classification}] ${err.message}`,
            },
          },
        ]);
      } catch {
        console.error('  could not update the sync run ledger; original error follows');
      }
    }

    throw new SyncError(err.message, { classification, cause: err });
  }
}
