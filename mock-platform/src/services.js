// Mock LTI Advantage service endpoints: Names & Role Provisioning (NRPS)
// and Assignment & Grade Services (AGS), both bearer-token protected.
//
// Also exposes a failureMode toggle so you can make the sync fail on demand --
// useful for demonstrating the Asana error path without editing code mid-demo.

import { createLocalJWKSet, jwtVerify } from 'jose';
import { getJwks } from './keys.js';
import { PLATFORM_ISSUER } from './registrations.js';
import { SCOPES } from './token.js';
import { CONTEXT, MEMBERS, LINE_ITEMS, RESULTS } from './seed.js';

let jwks;
function localJwks() {
  if (!jwks) jwks = createLocalJWKSet(getJwks());
  return jwks;
}

// mode: 'off' | 'error' | 'ratelimit' | 'slow'
export const failureMode = { mode: 'off' };

function applyFailureMode(res) {
  if (failureMode.mode === 'error') {
    res.status(500).json({ error: 'simulated upstream failure' });
    return true;
  }
  if (failureMode.mode === 'ratelimit') {
    res.set('Retry-After', '2').status(429).json({ error: 'simulated rate limit' });
    return true;
  }
  return false;
}

function requireScope(...allowed) {
  return async (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing bearer token' });

    try {
      const { payload } = await jwtVerify(token, localJwks(), {
        issuer: PLATFORM_ISSUER,
        audience: PLATFORM_ISSUER,
      });
      const held = String(payload.scope || '').split(' ');
      if (!allowed.some((s) => held.includes(s))) {
        return res.status(403).json({ error: 'insufficient_scope', required: allowed });
      }
      req.ltiClientId = payload.client_id;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'invalid_token', error_description: err.message });
    }
  };
}

export function mountServices(app) {
  // --- NRPS: the roster ---------------------------------------------------
  app.get(
    '/context/:contextId/memberships',
    requireScope(SCOPES.MEMBERSHIPS),
    async (req, res) => {
      // checking for simulated failure modes first, before checking the contextId
      if (failureMode.mode === 'slow') await new Promise((r) => setTimeout(r, 8000));
      if (applyFailureMode(res)) return;
      if (req.params.contextId !== CONTEXT.id) return res.status(404).json({ error: 'unknown context' });

      let members = MEMBERS;
      if (req.query.role) {
        members = members.filter((m) => m.roles.some((r) => r.endsWith(`#${req.query.role}`)));
      }

      res
        .type('application/vnd.ims.lti-nrps.v2.membershipcontainer+json')
        .json({
          id: `${PLATFORM_ISSUER}${req.originalUrl}`,
          context: { id: CONTEXT.id, label: CONTEXT.label, title: CONTEXT.title },
          members,
        });
    }
  );

  // --- AGS: line items ----------------------------------------------------
  app.get(
    '/context/:contextId/line_items',
    requireScope(SCOPES.LINE_ITEMS),
    async (req, res) => {
      // checking for simulated failure modes first, before checking the contextId
      if (failureMode.mode === 'slow') await new Promise((r) => setTimeout(r, 8000));
      if (applyFailureMode(res)) return;
      if (req.params.contextId !== CONTEXT.id) return res.status(404).json({ error: 'unknown context' });

      let items = LINE_ITEMS;
      if (req.query.tag) items = items.filter((i) => i.tag === req.query.tag);
      if (req.query.resource_id) items = items.filter((i) => i.resourceId === req.query.resource_id);

      res.type('application/vnd.ims.lis.v2.lineitemcontainer+json').json(items);
    }
  );

  // --- AGS: results for one line item ------------------------------------
  app.get(
    '/context/:contextId/line_items/:lineItemId/results',
    requireScope(SCOPES.RESULTS),
    async (req, res) => {
      // checking for simulated failure modes first
      if (failureMode.mode === 'slow') await new Promise((r) => setTimeout(r, 8000));
      if (applyFailureMode(res)) return;

      const { contextId, lineItemId } = req.params;
      const lineItem = LINE_ITEMS.find((i) => i.id.endsWith(`/${lineItemId}`));
      if (!lineItem) return res.status(404).json({ error: 'unknown line item' });

      const rows = (RESULTS[lineItemId] || []).map((r) => ({
        id: `${lineItem.id}/results/${r.userId}`,
        scoreOf: lineItem.id,
        userId: r.userId,
        resultScore: r.resultScore,
        resultMaximum: r.resultMaximum,
      }));

      const filtered = req.query.user_id
        ? rows.filter((r) => r.userId === req.query.user_id)
        : rows;

      res.type('application/vnd.ims.lis.v2.resultcontainer+json').json(filtered);
    }
  );

  // --- Demo control -------------------------------------------------------
  // POST /admin/failure-mode {"mode":"error"} then re-run the sync to show the
  // failure path end to end. No auth: this is a mock platform, not a product.
  app.post('/admin/failure-mode', (req, res) => {
    const mode = req.body?.mode || 'off';
    if (!['off', 'error', 'ratelimit', 'slow'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be off|error|ratelimit|slow' });
    }
    failureMode.mode = mode;
    res.json({ failureMode: failureMode.mode });
  });

  app.get('/admin/failureMode', (req, res) => res.json({ failureMode: failureMode.mode }));
}
