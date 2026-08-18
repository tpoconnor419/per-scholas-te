/**
  Asana ticketing.
 
  The value here is in what it does NOT do. A naive integration files a ticket
  per error, so an expired token produces sixty identical tickets and staff
  learn to ignore the project. This files once per distinct problem and then
  keeps that one ticket current.
 
  Four transitions, all driven by state already in Airtable:
    new and worth filing      create a task, write the gid back
    recurring, count changed  comment on the existing task
    recurring, task closed    reopen it and comment
    stopped occurring         complete the task with a closing comment
 */

const ASANA_API = 'https://app.asana.com/api/1.0';

function asanaRequest_(path, options) {
  options = options || {};
  const method = options.method || 'get';
  let last = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const params = {
      method: method,
      headers: { Authorization: 'Bearer ' + CONFIG.asanaPat, Accept: 'application/json' },
      muteHttpExceptions: true,
    };
    if (options.body) {
      params.contentType = 'application/json';
      params.payload = JSON.stringify({ data: options.body });
    }

    const response = UrlFetchApp.fetch(ASANA_API + path, params);
    const status = response.getResponseCode();
    const text = response.getContentText();

    if (status >= 200 && status < 300) return JSON.parse(text).data;

    const classification = classifyHttp_(status, text);
    last = new SyncError('Asana ' + status + ' on ' + path + ': ' + text.slice(0, 250),
      classification, { status: status });

    if (classification !== 'transient') throw last;
    if (attempt < 3) Utilities.sleep(Math.pow(2, attempt) * 700);
  }

  throw last;
}

function asanaCreateTask_(name, notes) {
  if (!CONFIG.asanaProjectGid) {
    throw new SyncError('ASANA_PROJECT_GID is required to create tasks', 'config');
  }
  const task = asanaRequest_('/tasks', {
    method: 'post',
    body: { name: name, notes: notes, projects: [CONFIG.asanaProjectGid] },
  });
  return {
    gid: task.gid,
    url: 'https://app.asana.com/0/' + CONFIG.asanaProjectGid + '/' + task.gid,
  };
}

/**
  Should this issue produce a ticket at all?
 
  Transient failures get one run's grace. A Canvas throttle or a network blip
  that clears before the next run should not have generated a ticket -- but
  one that survives two consecutive runs is real and needs a human.
 
  Everything else files immediately: a config error or a broken requirement
  will not self-heal, and every hour it sits unreported is an hour learners
  are evaluated against rules that do not work.
 */
function shouldFile_(fields) {
  if (fields.resolved) return false;
  if (fields.classification === 'transient') return (fields.occurrence_count || 1) >= 2;
  return true;
}

function taskNotes_(fields, cohortName, runId) {
  return [
    fields.detail || '',
    '',
    '- - -',
    'Cohort: ' + (cohortName || 'unknown'),
    'Classification: ' + fields.classification,
    'First seen: ' + (fields.first_seen || 'unknown'),
    'Sync run: ' + (runId || 'unknown'),
    'Fingerprint: ' + fields.fingerprint,
    '',
    'Opened automatically by the certification readiness sync in Google Apps Script.',
    'It will close itself once the underlying problem stops recurring.',
  ].join('\n');
}

function reportIssues_(cohortName, runId) {
  if (!CONFIG.asanaPat) return { skipped: 'no ASANA_PAT configured' };

  const rows = airtableList_('Sync Issues');
  const actions = { created: [], commented: [], reopened: [], closed: [], skipped: [] };
  const updates = [];

  rows.forEach((row) => {
    const f = row.fields;
    const gid = f.asana_task_gid;
    const count = f.occurrence_count || 1;
    const reported = f.asana_last_reported_count || 0;

    // --- Resolved: close the ticket ---------------------------------------
    if (f.resolved) {
      if (!gid) return;
      asanaRequest_('/tasks/' + gid + '/stories', {
        method: 'post',
        body: {
          text: 'Resolved automatically: this issue did not recur in sync run ' + (runId || 'unknown') +
            '. Closing. It will reopen if the problem returns.',
        },
      });
      asanaRequest_('/tasks/' + gid, { method: 'put', body: { completed: true } });
      actions.closed.push(f.title);
      updates.push({ id: row.id, fields: { asana_last_reported_count: 0 } });
      return;
    }

    if (!shouldFile_(f)) {
      actions.skipped.push(f.title + ' (transient, first occurrence)');
      return;
    }

    // --- New: create the ticket -------------------------------------------
    if (!gid) {
      const task = asanaCreateTask_(
        '[' + f.classification + '] ' + f.title + (cohortName ? ' \u2014 ' + cohortName : ''),
        taskNotes_(f, cohortName, runId)
      );
      actions.created.push(f.title);
      updates.push({
        id: row.id,
        fields: {
          asana_task_gid: task.gid,
          asana_task_url: task.url,
          asana_last_reported_count: count,
        },
      });
      return;
    }

    // --- Existing: comment only if something changed ------------------------
    if (count <= reported) return;

    let wasCompleted = false;
    try {
      const task = asanaRequest_('/tasks/' + gid + '?opt_fields=gid,completed');
      wasCompleted = Boolean(task.completed);
      if (wasCompleted) asanaRequest_('/tasks/' + gid, { method: 'put', body: { completed: false } });
    } catch (err) {
      // A deleted task should not fail the sync. Clear the gid so the next run
      // files a fresh one.
      if (err.status === 404) {
        updates.push({
          id: row.id,
          fields: { asana_task_gid: '', asana_task_url: '', asana_last_reported_count: 0 },
        });
        actions.skipped.push(f.title + ' (task deleted in Asana; will refile next run)');
        return;
      }
      throw err;
    }

    asanaRequest_('/tasks/' + gid + '/stories', {
      method: 'post',
      body: {
        text: 'Still occurring \u2014 ' + count + ' sync run(s) affected as of ' +
          (f.last_seen || 'now') + '. Latest run: ' + (runId || 'unknown') + '.' +
          (wasCompleted ? '\n\nReopened because the problem recurred after the task was closed.' : ''),
      },
    });

    (wasCompleted ? actions.reopened : actions.commented).push(f.title);
    updates.push({ id: row.id, fields: { asana_last_reported_count: count } });
  });

  if (updates.length) airtableUpdate_('Sync Issues', updates);
  return actions;
}

/**
  Record a hard failure as a Sync Issue so it goes through the same
  fingerprint dedupe as everything else. Without this, a flapping Canvas
  endpoint files a fresh ticket on every scheduled run.
 */
function recordSyncFailure_(error, contextId, runId) {
  const classification = error.classification || 'unclassified';
  const now = new Date().toISOString();
  const fp = 'runfail_' + contextId + '_' + classification;

  const detail = 'The certification readiness sync could not complete.\n\n' +
    'Error: ' + error.message + '\n' +
    'Classification: ' + classification + '\n' +
    'Latest run: ' + (runId || 'not started') + '\n\n' +
    (classification === 'config'
      ? 'Credentials or setup need fixing. Retries will not help.'
      : classification === 'transient'
        ? 'This may clear on the next scheduled run. A ticket is filed only if it persists.'
        : 'This error did not match a known category and needs investigation.');

  const existing = airtableList_('Sync Issues', {
    filterByFormula: "{fingerprint} = '" + fp + "'",
  });

  if (existing.length === 0) {
    airtableCreate_('Sync Issues', [{
      fingerprint: fp,
      classification: classification,
      title: 'Sync failed for ' + contextId,
      detail: detail,
      first_seen: now,
      last_seen: now,
      occurrence_count: 1,
      resolved: false,
    }]);
  } else {
    airtableUpdate_('Sync Issues', [{
      id: existing[0].id,
      fields: {
        last_seen: now,
        occurrence_count: (existing[0].fields.occurrence_count || 0) + 1,
        resolved: false,
        detail: detail,
      },
    }]);
  }
}