// store.js — persists this device's identity locally. Never synced anywhere.
import * as idbKeyval from 'https://esm.sh/idb-keyval@6';

const { get, set, del } = idbKeyval;
const KEY = 'tidelight-identity-v1';

export async function loadIdentity() {
  return (await get(KEY)) || null;
}

export async function saveIdentity(identity) {
  await set(KEY, identity);
  return identity;
}

export async function updateIdentity(patch) {
  const current = (await loadIdentity()) || {};
  const next = { ...current, ...patch };
  await saveIdentity(next);
  return next;
}

export async function clearIdentity() {
  await del(KEY);
}

export function isPaired(identity) {
  return !!(identity && identity.partnerPublicKey && identity.roomId);
}

// ---------------- Unread bookkeeping ----------------
// Kept in its own key rather than inside the identity, because "what have I
// already looked at" is per-device state and has no business travelling into
// the encrypted cloud backup of your keys.
const SEEN_KEY = 'tidelight-seen-v1';

export async function loadSeen() {
  return (await get(SEEN_KEY)) || {};
}

export async function setSeen(section, count) {
  const current = (await get(SEEN_KEY)) || {};
  current[section] = count;
  await set(SEEN_KEY, current);
  return current;
}

export async function clearSeen() {
  await del(SEEN_KEY);
}
