import { createRemoteJWKSet, jwtVerify } from 'jose';
import { platforms } from './registrations.js';
import { consumeState } from './state-store.js';
import { createSession } from './dashboard.js';

const jwksCache = new Map();
function getJwks(uri) {
  if (!jwksCache.has(uri)) jwksCache.set(uri, createRemoteJWKSet(new URL(uri)));
  return jwksCache.get(uri);
}

export async function handleLaunch(req, res) {
  const { id_token, state } = req.body;
  if (!id_token || !state) return res.status(400).send('Missing id_token or state');

  // 1. state must match one we generated at /login and it's single-use
  const saved = consumeState(state);
  if (!saved) return res.status(400).send('Unknown, expired, or already-used state');

  const platform = platforms[saved.iss];
  if (!platform) return res.status(400).send('Unknown platform');

  // 2. verify signature, issuer, audience, exp/iat against the platform's JWKS
  let payload;
  try {
    const jwks = getJwks(platform.jwksUri);
    const result = await jwtVerify(id_token, jwks, {
      issuer: platform.issuer,
      audience: platform.clientId,
    });
    payload = result.payload;
  } catch (err) {
    return res.status(401).send('id_token verification failed: ' + err.message);
  }

  // 3. nonce must match the one we generated, proving this id_token was
  // minted in response to *this* login attempt, not replayed from another
  if (payload.nonce !== saved.nonce) {
    return res.status(401).send('Nonce mismatch');
  }

  // 4. deployment_id must be one we recognize for this platform
  const deploymentId = payload['https://purl.imsglobal.org/spec/lti/claim/deployment_id'];
  if (deploymentId !== platform.deploymentId) {
    return res.status(401).send('Unknown deployment_id');
  }

  const messageType = payload['https://purl.imsglobal.org/spec/lti/claim/message_type'];
  const resourceLink = payload['https://purl.imsglobal.org/spec/lti/claim/resource_link'];
  const context = payload['https://purl.imsglobal.org/spec/lti/claim/context'];
  const roles = payload['https://purl.imsglobal.org/spec/lti/claim/roles'] || [];

  const ags = payload['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint'];
  const nrps = payload['https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice'];

  const endpoints = {
    membershipsUrl: nrps?.context_memberships_url,
    lineItemsUrl: ags?.lineitems,
  };

  const sid = createSession({
    contextId: context?.id,
    issuer: platform.issuer,
    name: payload.name ?? payload.sub,
    roles,
    endpoints,
  });

  console.log('[launch] service endpoints', context?.id, endpoints);

  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=28800`);
  res.redirect('/dashboard');
}
