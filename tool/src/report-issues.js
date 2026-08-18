// Turns Airtable Sync Issues state into Asana tasks.
//
// The value here is in what it does NOT do. A naive integration files a task
// per error, which means an expired token produces sixty identical tasks and
// staff learn to ignore the project. This layer files once per distinct
// problem and then keeps that one task current.
//
// Four transitions, driven entirely by state already in Airtable:
//
//   new and worth filing      -> create a task, write the gid back
//   recurring, count changed  -> comment on the existing task
//   recurring, task completed -> reopen it and comment
//   stopped occurring         -> complete the task with a closing comment
//
// The Airtable row is the source of truth. Asana is a view of it that happens
// to be where staff already work.

/**
 * Should this issue produce an Asana task at all?
 *
 * Transient failures get one run's grace. A network blip that fixes itself
 * before the next sync should not have generated a ticket -- but one that
 * survives two consecutive runs is real and needs a human.
 *
 * Everything else files immediately: a config error or a broken requirement
 * will not self-heal, and every hour it sits unreported is an hour learners
 * are being evaluated against rules that do not work.
 */
export function shouldFile(fields) {
  if (fields.resolved) return false;
  if (fields.classification === 'transient') return (fields.occurrence_count ?? 1) >= 2;
  return true;
}

function taskName(fields, cohortName) {
  const tag = fields.classification ?? 'issue';
  return `[${tag}] ${fields.title}${cohortName ? ` — ${cohortName}` : ''}`;
}

function taskNotes(fields, { cohortName, runId, dashboardUrl }) {
  const lines = [
    fields.detail ?? '',
    '',
    '— — —',
    `Cohort: ${cohortName ?? 'unknown'}`,
    `Classification: ${fields.classification}`,
    `First seen: ${fields.first_seen ?? 'unknown'}`,
    `Sync run: ${runId ?? 'unknown'}`,
    `Fingerprint: ${fields.fingerprint}`,
  ];

  if (dashboardUrl) lines.push('', `Dashboard: ${dashboardUrl}`);

  lines.push(
    '',
    'This task was opened automatically by the certification readiness sync.',
    'It will close itself once the underlying problem stops recurring.'
  );

  return lines.join('\n');
}

/**
 * @param {object} deps { airtable, asana }
 * @param {object} opts { cohortName, runId, dashboardUrl, dryRun }
 */
export async function reportIssues({ airtable, asana }, opts = {}) {
  const { cohortName, runId, dashboardUrl, dryRun = false } = opts;

  const rows = await airtable.list('Sync Issues');
  const actions = { created: [], commented: [], reopened: [], closed: [], skipped: [] };
  const airtableUpdates = [];

  for (const row of rows) {
    const f = row.fields;
    const gid = f.asana_task_gid;
    const count = f.occurrence_count ?? 1;
    const reported = f.asana_last_reported_count ?? 0;

    // --- Resolved: close the task -----------------------------------------
    if (f.resolved) {
      if (!gid) continue;

      if (!dryRun) {
        await asana.addComment(
          gid,
          `Resolved automatically: this issue did not recur in sync run ${runId ?? '(unknown)'}. ` +
            `Closing. It will reopen if the problem returns.`
        );
        await asana.setCompleted(gid, true);
      }

      actions.closed.push(f.title);
      airtableUpdates.push({ id: row.id, fields: { asana_last_reported_count: 0 } });
      continue;
    }

    // --- Not worth filing yet ---------------------------------------------
    if (!shouldFile(f)) {
      actions.skipped.push(`${f.title} (transient, first occurrence)`);
      continue;
    }

    // --- New: create the task ---------------------------------------------
    if (!gid) {
      if (dryRun) {
        actions.created.push(f.title);
        continue;
      }

      const task = await asana.createTask({
        name: taskName(f, cohortName),
        notes: taskNotes(f, { cohortName, runId, dashboardUrl }),
      });

      actions.created.push(f.title);
      airtableUpdates.push({
        id: row.id,
        fields: {
          asana_task_gid: task.gid,
          asana_task_url: task.url,
          asana_last_reported_count: count,
        },
      });
      continue;
    }

    // --- Existing task: comment only if something changed ------------------
    if (count <= reported) continue;

    if (!dryRun) {
      // Someone may have closed the task by hand. A recurrence means it was
      // closed prematurely, so reopen rather than commenting into the void.
      let wasCompleted = false;
      try {
        const task = await asana.getTask(gid);
        wasCompleted = Boolean(task.completed);
        if (wasCompleted) await asana.setCompleted(gid, false);
      } catch (err) {
        // A deleted task should not fail the sync. Clear the gid so the next
        // run files a fresh one.
        if (err.status === 404) {
          airtableUpdates.push({
            id: row.id,
            fields: { asana_task_gid: '', asana_task_url: '', asana_last_reported_count: 0 },
          });
          actions.skipped.push(`${f.title} (task deleted in Asana; will refile next run)`);
          continue;
        }
        throw err;
      }

      await asana.addComment(
        gid,
        `Still occurring — ${count} sync run(s) affected as of ${f.last_seen ?? 'now'}. ` +
          `Latest run: ${runId ?? '(unknown)'}.` +
          (wasCompleted ? '\n\nThis task was reopened because the problem recurred after it was closed.' : '')
      );

      (wasCompleted ? actions.reopened : actions.commented).push(f.title);
    } else {
      actions.commented.push(f.title);
    }

    airtableUpdates.push({ id: row.id, fields: { asana_last_reported_count: count } });
  }

  if (airtableUpdates.length && !dryRun) {
    await airtable.update('Sync Issues', airtableUpdates);
  }

  return actions;
}

/**
 * A sync that died before producing issues still needs reporting. This turns
 * the thrown error into the same shape reconcileIssues writes, so a hard
 * failure flows through identical dedupe rather than a parallel code path.
 */
// export function issueFromSyncError(error, { contextId, runId }) {
//   return {
//     fingerprint: `runfail_${contextId}_${error.classification ?? 'unclassified'}`,
//     classification: error.classification ?? 'unclassified',
//     title: `Sync failed for ${contextId}`,
//     detail:
//       `The certification readiness sync could not complete.\n\n` +
//       `Error: ${error.message}\n` +
//       `Classification: ${error.classification ?? 'unclassified'}\n` +
//       `Run: ${runId}\n\n` +
//       (error.classification === 'config'
//         ? 'A config error means credentials or setup need fixing. Retries will not help.'
//         : error.classification === 'transient'
//           ? 'A transient error may clear on the next scheduled run.'
//           : 'This error did not match a known category and needs investigation.'),
//   };
// }

/**
 * Record a hard sync failure as a Sync Issue.
 *
 * A run that dies before producing issues still needs reporting, and it must
 * go through the same fingerprint dedupe as everything else. Otherwise a
 * flapping platform files a fresh task on every attempt -- which is the exact
 * behaviour this layer exists to prevent.
 */
export async function recordSyncFailure(airtable, error, { contextId, runId }) {
  const classification = error.classification ?? 'unclassified';
  const now = new Date().toISOString();

  const issue = {
    fingerprint: `runfail_${contextId}_${classification}`,
    classification,
    title: `Sync failed for ${contextId}`,
    detail:
      `The certification readiness sync could not complete.\n\n` +
      `Error: ${error.message}\n` +
      `Classification: ${classification}\n` +
      `Latest run: ${runId ?? 'not started'}\n\n` +
      (classification === 'config'
        ? 'Credentials or setup need fixing. Retries will not help.'
        : classification === 'transient'
          ? 'This may clear on the next run. It files a task only if it persists.'
          : 'This error did not match a known category and needs investigation.'),
  };

  const existing = await airtable.list('Sync Issues', {
    filterByFormula: `{fingerprint} = '${issue.fingerprint}'`,
  });

  if (existing.length === 0) {
    await airtable.create('Sync Issues', [
      { ...issue, first_seen: now, last_seen: now, occurrence_count: 1, resolved: false },
    ]);
  } else {
    await airtable.update('Sync Issues', [
      {
        id: existing[0].id,
        fields: {
          last_seen: now,
          occurrence_count: (existing[0].fields.occurrence_count ?? 0) + 1,
          resolved: false,
          detail: issue.detail,
        },
      },
    ]);
  }
}