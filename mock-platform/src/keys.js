// Generates an RSA keypair for the platform on startup and exposes it as a
// JWKS. In a real platform these keys would be long-lived and rotated, not
// regenerated on every boot -- kept simple here for practice purposes.

import { generateKeyPair, exportJWK } from 'jose';
import { randomUUID } from 'crypto';

const kid = randomUUID();
let privateKey;
let publicJwk;

export async function initKeys() {
  const { publicKey, privateKey: privKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  privateKey = privKey;
  publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';
}

export function getPrivateKey() {
  return privateKey;
}

export function getKid() {
  return kid;
}

export function getJwks() {
  return { keys: [publicJwk] };
}
