// OAuth 2.0 token endpoint for LTI Advantage service calls.
//
// This is the piece that lets the tool talk to the platform OUTSIDE a browser
// launch -- which is what a nightly sync job needs. The tool signs a JWT with
// its own private key (private_key_jwt client authentication) and trades it
// for a short-lived bearer token scoped to specific LTI services.

import { decodeJwt, jwtVerify, createRemoteJWKSet, SignJWT } from 'jose';
import { getPrivateKey, getKid } from './keys.js';
import { tools, PLATFORM_ISSUER } from './registrations.js';

export const TOKEN_ENDPOINT = `${PLATFORM_ISSUER}/token`;

export const SCOPES = {
  MEMBERSHIPS: 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
  LINE_ITEMS: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly',
  RESULTS: 'https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly',
  SCORE: 'https://purl.imsglobal.org/spec/lti-ags/scope/score',
};

const SUPPORTED = new Set(Object.values(SCOPES));

const toolJwksCache = new Map();
function toolJwks(uri) {
  if (!toolJwksCache.has(uri)) toolJwksCache.set(uri, createRemoteJWKSet(new URL(uri)));
  return toolJwksCache.get(uri);
}

// Replay guard. A client_assertion is single-use; without this, anyone who
// captures one can mint tokens until it expires.
const seenJtis = new Map();
function claimJti(jti, expSeconds) {
  const now = Date.now();
  for (const [k, expiresAt] of seenJtis) if (expiresAt < now) seenJtis.delete(k);
  if (seenJtis.has(jti)) return false;
  seenJtis.set(jti, expSeconds * 1000);
  return true;
}

export async function handleToken(req, res) {
  const { grant_type, client_assertion_type, client_assertion, scope } = req.body || {};

  if (grant_type !== 'client_credentials') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  if (client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'client_assertion_type must be jwt-bearer',
    });
  }
  if (!client_assertion) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'missing client_assertion' });
  }

  // Peek at the UNVERIFIED claims for one reason only: to learn which tool is
  // calling, so we know whose JWKS to verify the signature against. Nothing
  // read here is trusted until jwtVerify succeeds below.
  let clientId;
  try {
    clientId = decodeJwt(client_assertion).sub;
  } catch {
    return res.status(400).json({ error: 'invalid_request', error_description: 'malformed client_assertion' });
  }

  const tool = tools[clientId];
  if (!tool) return res.status(401).json({ error: 'invalid_client' });

  let assertion;
  try {
    const result = await jwtVerify(client_assertion, toolJwks(tool.jwksUri), {
      issuer: clientId,
      subject: clientId,
      audience: [TOKEN_ENDPOINT, PLATFORM_ISSUER],
      clockTolerance: 30,
    });
    assertion = result.payload;
  } catch (err) {
    return res.status(401).json({ error: 'invalid_client', error_description: err.message });
  }

  if (!assertion.jti || !claimJti(assertion.jti, assertion.exp)) {
    return res.status(401).json({
      error: 'invalid_client',
      error_description: 'client_assertion must carry a unique jti',
    });
  }

  // Grant the intersection of what was asked for and what we support. Real
  // platforms also intersect with what the admin approved at install time.
  const requested = String(scope || '').split(' ').filter(Boolean);
  const granted = requested.filter((s) => SUPPORTED.has(s));
  if (granted.length === 0) {
    return res.status(400).json({ error: 'invalid_scope' });
  }

  const expiresIn = 3600;
  const accessToken = await new SignJWT({ scope: granted.join(' '), client_id: clientId })
    .setProtectedHeader({ alg: 'RS256', kid: getKid() })
    .setIssuer(PLATFORM_ISSUER)
    .setAudience(PLATFORM_ISSUER)
    .setSubject(clientId)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .sign(getPrivateKey());

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: granted.join(' '),
  });
}
