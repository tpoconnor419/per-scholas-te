// Airtable data client.
//
// Handles the three things that bite you at cohort scale: the 5 req/sec per
// base rate limit, the 10-record cap on upsert batches, and turning HTTP
// failures into the same `classification` vocabulary the LTI provider uses,
// so one error handler covers both halves of the sync.

const API = 'https://api.airtable.com/v0';

export class AirtableError extends Error {
  constructor(message, { status, classification, table }) {
    super(message);
    this.name = 'AirtableError';
    this.status = status;
    this.classification = classification;
    this.table = table;
  }
}

function classify(status) {
  if (status === 429 || status >= 500) return 'transient';
  if (status === 401 || status === 403) return 'config';
  return 'permanent';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serial queue spacing calls ~4/sec, one below Airtable's limit. Exceeding it
// earns a 30 second lockout, which costs far more than the pacing does.
class RateLimiter {
  constructor(minIntervalMs = 250) {
    this.minInterval = minIntervalMs;
    this.chain = Promise.resolve();
    this.last = 0;
  }

  run(fn) {
    const result = this.chain.then(async () => {
      const wait = this.minInterval - (Date.now() - this.last);
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      return fn();
    });
    this.chain = result.catch(() => {});
    return result;
  }
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class AirtableClient {
  constructor({ pat, baseId, maxAttempts = 4 } = {}) {
    this.pat = pat ?? process.env.AIRTABLE_PAT;
    this.baseId = baseId ?? process.env.AIRTABLE_BASE_ID;
    this.maxAttempts = maxAttempts;
    this.limiter = new RateLimiter();

    if (!this.pat || !this.baseId) {
      throw new AirtableError('AIRTABLE_PAT and AIRTABLE_BASE_ID are required', {
        status: 0,
        classification: 'config',
        table: null,
      });
    }
  }

  async #request(table, { method = 'GET', path = '', query, body } = {}) {
    const url = new URL(`${API}/${this.baseId}/${encodeURIComponent(table)}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
        else url.searchParams.set(k, v);
      }
    }

    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const res = await this.limiter.run(() =>
        fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.pat}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      );

      if (res.ok) return res.json();

      const detail = (await res.text()).slice(0, 300);
      const classification = classify(res.status);
      lastError = new AirtableError(`${method} ${table} -> ${res.status}: ${detail}`, {
        status: res.status,
        classification,
        table,
      });

      if (classification !== 'transient') throw lastError;

      // A 429 here means the limiter was outpaced by another process hitting
      // the same base. Airtable's penalty is 30s; anything shorter just burns
      // an attempt.
      const backoff = res.status === 429 ? 30_000 : 2 ** attempt * 400 + Math.random() * 300;
      if (attempt < this.maxAttempts) await sleep(backoff);
    }

    throw lastError;
  }

  /** Every record in a table, following pagination. */
  async list(table, { view, filterByFormula, fields } = {}) {
    const records = [];
    let offset;

    do {
      const page = await this.#request(table, {
        query: {
          view,
          filterByFormula,
          offset,
          pageSize: 100,
          ...(fields ? { 'fields[]': fields } : {}),
        },
      });
      records.push(...page.records);
      offset = page.offset;
    } while (offset);

    return records;
  }

  /**
   * Insert-or-update, merging on the given field(s).
   *
   * Airtable caps this at 10 records per request, so a 300-row readiness
   * write becomes 30 sequential calls -- roughly 8 seconds at the pacing
   * above. That is the main reason the sync is a background job.
   */
  async upsert(table, records, fieldsToMergeOn, { typecast = true } = {}) {
    const summary = { created: 0, updated: 0, records: [] };

    for (const batch of chunk(records, 10)) {
      const result = await this.#request(table, {
        method: 'PATCH',
        body: {
          performUpsert: { fieldsToMergeOn },
          records: batch.map((fields) => ({ fields })),
          typecast,
        },
      });

      summary.created += (result.createdRecords || []).length;
      summary.updated += (result.updatedRecords || []).length;
      summary.records.push(...(result.records || []));
    }

    return summary;
  }

  async create(table, records, { typecast = true } = {}) {
    const out = [];
    for (const batch of chunk(records, 10)) {
      const result = await this.#request(table, {
        method: 'POST',
        body: { records: batch.map((fields) => ({ fields })), typecast },
      });
      out.push(...result.records);
    }
    return out;
  }

  async update(table, records, { typecast = true } = {}) {
    const out = [];
    for (const batch of chunk(records, 10)) {
      const result = await this.#request(table, {
        method: 'PATCH',
        body: { records: batch, typecast },
      });
      out.push(...result.records);
    }
    return out;
  }

  /** Delete specific records by id. Batched at 10 per request. */
  async destroy(table, recordIds) {
    let deleted = 0;
    for (const batch of chunk(recordIds, 10)) {
      const result = await this.#request(table, {
        method: 'DELETE',
        query: { 'records[]': batch },
      });
      deleted += (result.records || []).length;
    }
    return deleted;
  }

  /** Delete every record in a table. The table itself survives. */
  async truncate(table) {
    const records = await this.list(table, { fields: [] });
    if (records.length === 0) return 0;
    return this.destroy(
      table,
      records.map((r) => r.id)
    );
  }
}
