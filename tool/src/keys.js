// Persistent RSA keypair.
//
// Generating a keypair at startup works fine for a single long-running server,
// and breaks the moment a second process needs to sign as the same party. A
// CLI sync job signs a client assertion with its own fresh key, the platform
// fetches the SERVER's published JWKS, finds no matching kid, and rejects with
// "no applicable key found in the JSON Web Key Set".
//
// So: generate once, write to disk, reuse. Every process in the project then
// signs with the key the JWKS actually advertises.
//
// The kid is the JWK thumbprint rather than a random id, so it is derived from
// the key itself and stays stable across restarts without being stored.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createPublicKey } from 'node:crypto';
import path from 'node:path';
import {
  generateKeyPair,
  exportPKCS8,
  importPKCS8,
  exportJWK,
  calculateJwkThumbprint,
} from 'jose';

const KEY_PATH = process.env.KEY_PATH ?? path.join(process.cwd(), '.keys', 'private.pem');
const ALG = 'RS256';

let privateKey = null;
let publicJwk = null;
let kid = null;

async function loadOrCreate() {
  try {
    const pem = await readFile(KEY_PATH, 'utf8');
    return { key: await importPKCS8(pem, ALG), created: false };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const { privateKey: generated } = await generateKeyPair(ALG, { extractable: true });
  await mkdir(path.dirname(KEY_PATH), { recursive: true });
  await writeFile(KEY_PATH, await exportPKCS8(generated), { mode: 0o600 });
  return { key: generated, created: true };
}

export async function initKeys() {
  if (privateKey) return;

  const { key, created } = await loadOrCreate();
  privateKey = key;

  const jwk = await exportJWK(createPublicKey(privateKey));
  kid = await calculateJwkThumbprint(jwk);
  publicJwk = { ...jwk, kid, alg: ALG, use: 'sig' };

  console.log(`[keys] ${created ? 'generated' : 'loaded'} ${KEY_PATH}  kid ${kid.slice(0, 12)}...`);
}

function assertReady() {
  if (!privateKey) {
    throw new Error('initKeys() must be awaited before using the keypair');
  }
}

export function getPrivateKey() {
  assertReady();
  return privateKey;
}

export function getKid() {
  assertReady();
  return kid;
}

export function getJwks() {
  assertReady();
  return { keys: [publicJwk] };
}
