/**
  Airtable client.
 
  Three constraints drive everything here:
    - 5 requests/second per base, and exceeding it earns a 30 second lockout
    - 10 records maximum per write, upsert included
    - no transactions, so a half-finished run leaves half-written data
 
  The third is why every sync opens a Sync Runs row before doing any work.
 */

const AIRTABLE_API = 'https://api.airtable.com/v0';

let airtableLastCall_ = 0;

function airtablePace_() {
  const since = Date.now() - airtableLastCall_;
  if (since < CONFIG.AIRTABLE_MIN_INTERVAL_MS) {
    Utilities.sleep(CONFIG.AIRTABLE_MIN_INTERVAL_MS - since);
  }
  airtableLastCall_ = Date.now();
}

function airtableRequest_(table, options) {
  options = options || {};
  const method = options.method || 'get';
  const query = options.query ? '?' + toQuery_(options.query) : '';
  const url = AIRTABLE_API + '/' + CONFIG.airtableBaseId + '/' + encodeURIComponent(table) + query;

  let last = null;

  for (let attempt = 1; attempt <= CONFIG.MAX_ATTEMPTS; attempt++) {
    airtablePace_();

    const params = {
      method: method,
      headers: { Authorization: 'Bearer ' + CONFIG.airtablePat },
      muteHttpExceptions: true,
    };
    if (options.body) {
      params.contentType = 'application/json';
      params.payload = JSON.stringify(options.body);
    }

    const response = UrlFetchApp.fetch(url, params);
    const status = response.getResponseCode();
    const text = response.getContentText();

    if (status >= 200 && status < 300) return JSON.parse(text);

    const classification = classifyHttp_(status, text);
    last = new SyncError(
      'Airtable ' + status + ' on ' + table + ': ' + text.slice(0, 250),
      classification,
      { status: status, table: table }
    );

    if (classification !== 'transient') throw last;

    // Airtable's penalty for exceeding the rate limit is a flat 30 seconds.
    // Anything shorter just burns an attempt against a closed door.
    const backoff = status === 429 ? 30000 : Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 400);
    if (attempt < CONFIG.MAX_ATTEMPTS) Utilities.sleep(backoff);
  }

  throw last;
}

function airtableList_(table, options) {
  options = options || {};
  const records = [];
  let offset = null;
  let pages = 0;

  do {
    const query = { pageSize: 100 };
    if (options.filterByFormula) query.filterByFormula = options.filterByFormula;
    if (options.view) query.view = options.view;
    if (offset) query.offset = offset;

    const page = airtableRequest_(table, { query: query });
    records.push.apply(records, page.records);
    offset = page.offset;
    pages += 1;
  } while (offset && pages < 50);

  return records;
}

function chunk_(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
  Insert-or-update, merging on the given field(s).
 
  A 4-learner cohort with 4 requirements is 16 readiness rows -- two calls.
  A 60-learner cohort is 300 rows, 30 calls, about 8 seconds at safe pacing.
  Well inside the 6 minute execution limit, but worth knowing where the
  ceiling is: roughly 400 learners before a single run needs splitting.
 */
function airtableUpsert_(table, records, fieldsToMergeOn) {
  const summary = { created: 0, updated: 0, records: [] };

  chunk_(records, CONFIG.BATCH_SIZE).forEach((batch) => {
    const result = airtableRequest_(table, {
      method: 'patch',
      body: {
        performUpsert: { fieldsToMergeOn: fieldsToMergeOn },
        records: batch.map((fields) => ({ fields: fields })),
        typecast: true,
      },
    });

    summary.created += (result.createdRecords || []).length;
    summary.updated += (result.updatedRecords || []).length;
    summary.records.push.apply(summary.records, result.records || []);
  });

  return summary;
}

function airtableCreate_(table, records) {
  const out = [];
  chunk_(records, CONFIG.BATCH_SIZE).forEach((batch) => {
    const result = airtableRequest_(table, {
      method: 'post',
      body: { records: batch.map((fields) => ({ fields: fields })), typecast: true },
    });
    out.push.apply(out, result.records);
  });
  return out;
}

function airtableUpdate_(table, records) {
  const out = [];
  chunk_(records, CONFIG.BATCH_SIZE).forEach((batch) => {
    const result = airtableRequest_(table, {
      method: 'patch',
      body: { records: batch, typecast: true },
    });
    out.push.apply(out, result.records);
  });
  return out;
}