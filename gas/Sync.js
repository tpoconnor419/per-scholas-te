/**
  The sync itself, plus the two ways it gets started: a nightly time-driven
  trigger, and a webhook for on-demand runs.
 
  Ordering is deliberate:
    1. take a lock       (a second run would race on the same upsert keys)
    2. open the ledger   (a crash still leaves evidence the run happened)
    3. load config       (cheap; fails fast on misconfiguration)
    4. fetch Canvas      (slow; most likely to fail)
    5. evaluate          (pure; cannot fail on data)
    6. write learners, then readiness (readiness links to learner record ids)
    7. reconcile issues, report to Asana
    8. close the ledger
 
  A run that dies at step 4 leaves a Sync Runs row reading "running" with no
  finished_at. That is how you tell a crashed job from one that never fired --
  which look identical without a ledger.
 */

function runSync() {
  // Triggers can overlap if a run is slow. Two concurrent syncs would race on
  // the same upsert keys and produce a ledger nobody can interpret.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    Logger.log('Another sync is already running; skipping this trigger.');
    return { skipped: 'locked' };
  }

  const started = new Date();
  const runId = Utilities.getUuid();
  const contextId = CONFIG.canvasCourseId;
  let runRecordId = null;

  try {
    Logger.log('Sync %s starting for %s', runId, contextId);

    // --- Cohort and rules from Airtable -----------------------------------
    const cohorts = airtableList_('Cohorts', {
      filterByFormula: "{canvas_context_id} = '" + contextId + "'",
    });
    if (cohorts.length === 0) {
      throw new SyncError('No cohort in Airtable with canvas_context_id "' + contextId + '"', 'config');
    }
    if (cohorts.length > 1) {
      throw new SyncError(cohorts.length + ' cohorts share canvas_context_id "' + contextId +
        '". Context ids must be unique.', 'config');
    }
    const cohort = cohorts[0];

    const created = airtableCreate_('Sync Runs', [{
      run_id: runId,
      trigger: 'scheduled',
      status: 'running',
      started_at: started.toISOString(),
      cohort: [cohort.id],
    }]);
    runRecordId = created[0].id;

    const trackIds = cohort.fields.track || [];
    if (!trackIds.length) {
      throw new SyncError('Cohort "' + cohort.fields.name + '" is not linked to a track', 'config');
    }

    const requirementRecords = airtableList_('Requirements').filter((r) =>
      (r.fields.track || []).some((id) => trackIds.indexOf(id) !== -1)
    );
    if (!requirementRecords.length) {
      throw new SyncError('No requirements linked to the track for "' + cohort.fields.name + '"', 'config');
    }
    Logger.log('Loaded %s requirements', requirementRecords.length);

    // --- Canvas ------------------------------------------------------------
    const snapshot = fetchCourseSnapshot_();
    Logger.log('Canvas: %s active learners, %s assignments',
      snapshot.learners.length, snapshot.lineItems.length);

    // --- Evaluate ----------------------------------------------------------
    const requirements = normalizeRequirements_(requirementRecords);
    const result = evaluateReadiness_(snapshot, requirements);
    Logger.log('Evaluated: %s ready, %s not ready, %s needs review',
      result.summary.ready, result.summary.notReady, result.summary.needsReview);

    // --- Learners ----------------------------------------------------------
    const learnerUpsert = airtableUpsert_('Learners', result.learners.map((l) => ({
      display_name: l.displayName || l.canvasUserId,
      sourced_id: l.sourcedId,
      canvas_user_id: l.canvasUserId,
      email: l.email || undefined,
      enrollment_status: 'active',
      readiness_status: l.status,
      requirements_met: l.requirementsMet,
      requirements_total: l.requirementsTotal,
      blocking_summary: l.blockingSummary,
      last_evaluated_at: l.evaluatedAt,
      cohort: [cohort.id],
    })), ['sourced_id']);
    Logger.log('Learners: %s created, %s updated', learnerUpsert.created, learnerUpsert.updated);

    // --- Readiness ---------------------------------------------------------
    // Needs record ids for the link fields, so it follows the learner write
    // rather than running alongside it.
    const learnerIdBySourcedId = {};
    learnerUpsert.records.forEach((r) => { learnerIdBySourcedId[r.fields.sourced_id] = r.id; });

    const requirementIdByName = {};
    requirementRecords.forEach((r) => { requirementIdByName[r.fields.name] = r.id; });

    const readinessUpsert = airtableUpsert_('Readiness', result.readiness.map((row) => ({
      key: row.key,
      met: row.met,
      observed_value: row.observedValue === null ? undefined : row.observedValue,
      observed_label: row.observedLabel,
      evaluated_at: row.evaluatedAt,
      learner: [learnerIdBySourcedId[row.sourcedId]].filter(Boolean),
      requirement: [requirementIdByName[row.requirementName]].filter(Boolean),
      sync_run: [runRecordId],
    })), ['key']);
    Logger.log('Readiness: %s created, %s updated', readinessUpsert.created, readinessUpsert.updated);

    // --- Issues ------------------------------------------------------------
    reconcileIssues_(result.issues, cohort.id, runRecordId, result.summary.evaluatedAt);

    const asanaActions = reportIssues_(cohort.fields.name, runId);
    if (asanaActions && asanaActions.created) {
      Logger.log('Asana: %s created, %s updated, %s closed',
        asanaActions.created.length, asanaActions.commented.length, asanaActions.closed.length);
    }

    // --- Close the ledger --------------------------------------------------
    airtableUpdate_('Sync Runs', [{
      id: runRecordId,
      fields: {
        status: result.issues.length ? 'partial' : 'success',
        finished_at: new Date().toISOString(),
        learners_evaluated: result.summary.learnersEvaluated,
        records_written: learnerUpsert.created + learnerUpsert.updated +
          readinessUpsert.created + readinessUpsert.updated,
        error_summary: result.issues.map((i) => i.title).join('\n'),
      },
    }]);

    Logger.log('Sync %s finished in %ss', runId, ((Date.now() - started) / 1000).toFixed(1));
    return { runId: runId, summary: result.summary };

  } catch (err) {
    const classification = err.classification || 'unclassified';
    Logger.log('Sync failed [%s]: %s', classification, err.message);

    if (runRecordId) {
      try {
        airtableUpdate_('Sync Runs', [{
          id: runRecordId,
          fields: {
            status: 'failed',
            finished_at: new Date().toISOString(),
            error_summary: '[' + classification + '] ' + err.message,
          },
        }]);
      } catch (ledgerErr) {
        Logger.log('Could not update the ledger: %s', ledgerErr.message);
      }
    }

    // A hard failure is exactly the case staff most need told about, and it
    // goes through the same dedupe as everything else.
    try {
      recordSyncFailure_(err, contextId, runId);
      reportIssues_(contextId, runId);
    } catch (reportErr) {
      Logger.log('Could not report the failure: %s', reportErr.message);
    }

    throw err;   // surfaces in the execution log and trigger failure email

  } finally {
    lock.releaseLock();
  }
}

/**
  Issues dedupe by fingerprint across runs, not within one. A recurring
  problem increments a counter; an issue that stops occurring is marked
  resolved, which closes its Asana task automatically instead of leaving
  stale tickets for staff to garbage-collect.
 */
function reconcileIssues_(issues, cohortId, syncRunId, timestamp) {
  const existing = airtableList_('Sync Issues');
  const byFingerprint = {};
  existing.forEach((r) => { byFingerprint[r.fields.fingerprint] = r; });

  const current = {};
  issues.forEach((i) => { current[i.fingerprint] = true; });

  const creates = [];
  const updates = [];

  issues.forEach((issue) => {
    const prior = byFingerprint[issue.fingerprint];
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
    } else {
      updates.push({
        id: prior.id,
        fields: {
          last_seen: timestamp,
          occurrence_count: (prior.fields.occurrence_count || 0) + 1,
          resolved: false,
          detail: issue.detail,
          sync_run: [syncRunId],
        },
      });
    }
  });

  // Anything previously open that did not recur is now fixed.
  existing.forEach((r) => {
    if (!r.fields.resolved && !current[r.fields.fingerprint]) {
      updates.push({ id: r.id, fields: { resolved: true } });
    }
  });

  if (creates.length) airtableCreate_('Sync Issues', creates);
  if (updates.length) airtableUpdate_('Sync Issues', updates);
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** Run once from the editor to install the nightly schedule. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'runSync') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('runSync')
    .timeBased()
    .everyDays(1)
    .atHour(2)          // Apps Script fires within the hour, not on the minute
    .create();

  Logger.log('Nightly trigger installed for ~02:00 in the project time zone.');
}

function removeTrigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'runSync') { ScriptApp.deleteTrigger(t); removed += 1; }
  });
  Logger.log('Removed %s trigger(s).', removed);
}

/**
  Webhook endpoint. Deploy as a web app to get a URL that starts a sync on
  demand -- from the Canvas dashboard, from a form, or from the LTI tool's
  "Sync now" button.
 
  Apps Script web apps cannot verify a signature before the body is read, so
  a shared secret in the payload is the practical guard. Anyone with the URL
  can otherwise trigger a run.
 */
function doPost(e) {
  const respond = (code, obj) => ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);

  let payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return respond(400, { error: 'Body must be JSON' });
  }

  const expected = propOptional_('WEBHOOK_SECRET');
  if (expected && payload.secret !== expected) {
    return respond(401, { error: 'Bad or missing secret' });
  }

  try {
    const result = runSync();
    return respond(200, { ok: true, result: result });
  } catch (err) {
    return respond(500, {
      ok: false,
      error: err.message,
      classification: err.classification || 'unclassified',
    });
  }
}
