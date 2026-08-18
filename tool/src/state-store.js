// Tracks state -> nonce for in-flight logins, server-side (not cookies).
// Using a server-side store keyed by the random `state` value sidesteps
// cross-site cookie issues entirely, since the id_token arrives via a
// cross-origin POST from the platform's auto-submit form.
//
// This is in-memory and single-process -- fine for practice, not for
// production (use Redis or similar, with TTLs, in a real deployment).

const store = new Map();
const TTL_MS = 5 * 60 * 1000;

export function saveState(state, data) {
  store.set(state, { ...data, createdAt: Date.now() });
}

export function consumeState(state) {
  const data = store.get(state);
  if (!data) return null;
  store.delete(state); // one-time use: prevents replay of the same state
  if (Date.now() - data.createdAt > TTL_MS) return null;
  return data;
}
