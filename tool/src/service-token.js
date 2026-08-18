// Tool-side client for the platform's token endpoint.
//
// This is what makes a background sync job possible: no browser, no launch,
// no user session. The tool proves who it is by signing a short-lived JWT
// with the same private key that backs its published JWKS.

import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { getPrivateKey, getKid } from './keys.js';

const cache = new Map();
const REFRESH_MARGIN_MS = 60_000;

export class ServiceTokenError extends Error {
  constructor(message, { status, classification }) {
    super(message);
    this.name = 'ServiceTokenError';
    this.status = status;
    // 'config' means a human has to fix something (bad key, revoked scope).
    // 'transient' means retry will probably work.
    this.classification = classification;
  }
}

export async function getServiceToken(platform, scopes) {
  const scopeString = [...scopes].sort().join(' ');
  const key = `${platform.issuer}|${scopeString}`;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now() + REFRESH_MARGIN_MS) return hit.token;

  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: getKid() })
    .setIssuer(platform.clientId)
    .setSubject(platform.clientId)
    .setAudience(platform.tokenEndpoint)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(getPrivateKey());

  const response = await fetch(platform.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
      scope: scopeString,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new ServiceTokenError(`token request failed (${response.status}): ${detail}`, {
      status: response.status,
      classification: response.status >= 500 || response.status === 429 ? 'transient' : 'config',
    });
  }

  const json = await response.json();

  // The platform may grant fewer scopes than requested. Fail loudly rather
  // than discovering it as a confusing 403 three calls later.
  const granted = new Set(String(json.scope || '').split(' '));
  const missing = [...scopes].filter((s) => !granted.has(s));
  if (missing.length) {
    throw new ServiceTokenError(`platform withheld scopes: ${missing.join(', ')}`, {
      status: 403,
      classification: 'config',
    });
  }

  cache.set(key, {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  });

  return json.access_token;
}

export function clearTokenCache() {
  cache.clear();
}
