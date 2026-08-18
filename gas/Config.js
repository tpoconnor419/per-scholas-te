/**
  Configuration and secrets.
 
  Nothing sensitive lives in code. Script Properties are stored per-project,
  are not visible in the editor's source, and do not travel if the project is
  copied or version-controlled with clasp. Run setupProperties() once from the
  editor to populate them.
 
  Apps Script files share one global scope -- there is no import/export. Load
  order follows the file order in the project, so this file is named to sort
  first.
 */

const CONFIG = {
  // Canvas
  get canvasBaseUrl() { return prop_('CANVAS_BASE_URL'); },
  get canvasToken() { return prop_('CANVAS_API_TOKEN'); },
  get canvasCourseId() { return prop_('CANVAS_COURSE_ID'); },

  // Airtable
  get airtablePat() { return prop_('AIRTABLE_PAT'); },
  get airtableBaseId() { return prop_('AIRTABLE_BASE_ID'); },

  // Asana
  get asanaPat() { return propOptional_('ASANA_PAT'); },
  get asanaProjectGid() { return propOptional_('ASANA_PROJECT_GID'); },

  // Tuning
  AIRTABLE_MIN_INTERVAL_MS: 250,   // stay under 5 req/sec per base
  MAX_ATTEMPTS: 4,
  BATCH_SIZE: 10,                  // Airtable's hard cap per write
  LOCK_TIMEOUT_MS: 30000,
};

function prop_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new SyncError(
      `Missing script property "${key}". Run setupProperties() or set it under ` +
      `Project Settings > Script Properties.`,
      'config'
    );
  }
  return value.trim();
}

function propOptional_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  return value ? value.trim() : null;
}

/**
  One error type across Canvas, Airtable and Asana.
 
  `classification` is what decides behaviour downstream:
    transient     retry; only file a ticket if it survives two runs
    config        will not self-heal; file immediately
    permanent     a bad request; file immediately
    data_quality  the data is wrong, not the code
    unclassified  a failure mode we did not anticipate -- always file
 */
class SyncError extends Error {
  constructor(message, classification, extra) {
    super(message);
    this.name = 'SyncError';
    this.classification = classification || 'unclassified';
    Object.assign(this, extra || {});
  }
}

function classifyHttp_(status, body) {
  if (status === 429 || status >= 500) return 'transient';
  // Canvas signals throttling with 403 plus an exhausted rate-limit header,
  // not 429. Treating every 403 as a permissions problem would turn a
  // recoverable throttle into a false alarm at 2am.
  if (status === 403 && /rate limit/i.test(body || '')) return 'transient';
  if (status === 401 || status === 403) return 'config';
  return 'permanent';
}

/**
  Run once from the editor, then delete the values from this function.
  Anything typed here is in the source; the properties store is not.
 */
function setupProperties() {
  PropertiesService.getScriptProperties().setProperties({
    CANVAS_BASE_URL: '',
    CANVAS_API_TOKEN: '',
    CANVAS_COURSE_ID: '',
    AIRTABLE_PAT: '',
    AIRTABLE_BASE_ID: '',
    ASANA_PAT: '',
    ASANA_PROJECT_GID: '',
  });
  Logger.log('Script properties set. Now clear the values from setupProperties().');
}

/** Confirms every credential works before you debug the wrong thing. */
function checkConnections() {
  const results = [];

  try {
    const me = canvasGet_('/api/v1/users/self');
    results.push(`Canvas   OK  ${me.name}`);
  } catch (err) {
    results.push(`Canvas   FAIL [${err.classification}] ${err.message}`);
  }

  try {
    const rows = airtableList_('Requirements');
    results.push(`Airtable OK  ${rows.length} requirements`);
  } catch (err) {
    results.push(`Airtable FAIL [${err.classification}] ${err.message}`);
  }

  if (CONFIG.asanaPat) {
    try {
      const workspaces = asanaRequest_('/workspaces');
      results.push(`Asana    OK  ${workspaces.length} workspace(s)`);
    } catch (err) {
      results.push(`Asana    FAIL [${err.classification}] ${err.message}`);
    }
  } else {
    results.push('Asana    SKIP (no ASANA_PAT set)');
  }

  Logger.log(results.join('\n'));
  return results;
}