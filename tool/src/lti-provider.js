// Reads certification-relevant data out of the platform over NRPS + AGS and
// normalizes it into one snapshot object.
//
// The readiness evaluator should depend on the SHAPE this returns, never on
// LTI itself. Swap this module for a Canvas REST provider (or a JSON fixture)
// and nothing downstream changes.

import { getServiceToken, ServiceTokenError } from './service-token.js';

export const REQUIRED_SCOPES = [
  'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
  'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly',
  'https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly',
];

const LEARNER_ROLE = '#Learner';

export class ServiceCallError extends Error {
  constructor(message, { status, url, classification }) {
    super(message);
    this.name = 'ServiceCallError';
    this.status = status;
    this.url = url;
    this.classification = classification;
  }
}

function classify(status) {
  if (status === 429 || status >= 500) return 'transient';
  if (status === 401 || status === 403) return 'config';
  return 'permanent';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function svcFetch(url, token, { accept, attempts = 4, timeoutMs = 10_000 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, ...(accept ? { accept } : {}) },
        signal: controller.signal,
      });

      if (res.ok) return await res.json();

      const classification = classify(res.status);
      lastError = new ServiceCallError(
        `${res.status} from ${url}: ${(await res.text()).slice(0, 200)}`,
        { status: res.status, url, classification }
      );

      // Config and permanent failures will not fix themselves. Stop early so
      // a bad token doesn't burn four retries per endpoint.
      if (classification !== 'transient') throw lastError;

      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 250 + Math.random() * 250;
      if (attempt < attempts) await sleep(backoff);
    } catch (err) {
      if (err instanceof ServiceCallError) throw err;
      lastError = new ServiceCallError(`network failure calling ${url}: ${err.message}`, {
        status: 0,
        url,
        classification: 'transient',
      });
      if (attempt < attempts) await sleep(2 ** attempt * 250 + Math.random() * 250);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/**
 * @param {object} platform  entry from tool registrations.js, plus tokenEndpoint
 * @param {object} endpoints { membershipsUrl, lineItemsUrl } from the id_token claims
 * @returns {Promise<{context, learners, lineItems, scores, fetchedAt}>}
 */
export async function fetchCourseSnapshot(platform, endpoints) {
  const { membershipsUrl, lineItemsUrl } = endpoints;
  if (!membershipsUrl || !lineItemsUrl) {
    throw new ServiceCallError('launch did not carry NRPS/AGS endpoints', {
      status: 0,
      url: null,
      classification: 'config',
    });
  }

  const token = await getServiceToken(platform, REQUIRED_SCOPES);

  const [membership, lineItems] = await Promise.all([
    svcFetch(membershipsUrl, token, {
      accept: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json',
    }),
    svcFetch(lineItemsUrl, token, {
      accept: 'application/vnd.ims.lis.v2.lineitemcontainer+json',
    }),
  ]);

  const learners = (membership.members || [])
    .filter((m) => (m.roles || []).some((r) => r.endsWith(LEARNER_ROLE)))
    .filter((m) => (m.status || 'Active') === 'Active')
    .map((m) => ({
      userId: m.user_id,
      name: m.name || null,
      email: m.email || null,
      // The join key to Airtable. Null here is a data-quality issue, not a
      // crash -- let the evaluator flag the learner as needs_review.
      sourcedId: m.lis_person_sourcedid || null,
    }));

  // Results are fetched per line item. On a real cohort this fans out, so
  // cap concurrency rather than firing all of them at once.
  const scores = {};
  for (const item of lineItems) {
    const results = await svcFetch(`${item.id}/results`, token, {
      accept: 'application/vnd.ims.lis.v2.resultcontainer+json',
    });
    scores[item.id] = Object.fromEntries(
      results.map((r) => [
        r.userId,
        {
          score: r.resultScore,
          maximum: r.resultMaximum ?? item.scoreMaximum,
          percent:
            r.resultScore == null
              ? null
              : r.resultScore / (r.resultMaximum ?? item.scoreMaximum),
        },
      ])
    );
  }

  return {
    context: membership.context,
    learners,
    lineItems: lineItems.map((i) => ({
      id: i.id,
      label: i.label,
      tag: i.tag || null,
      resourceId: i.resourceId || null,
      scoreMaximum: i.scoreMaximum,
    })),
    scores,
    fetchedAt: new Date().toISOString(),
  };
}

export { ServiceTokenError };
