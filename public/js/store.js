// store.js — persists this device's identity locally. Never synced anywhere.
import * as idbKeyval from 'https://esm.sh/idb-keyval@6';

const { get, set } = idbKeyval;
const KEY = 'ondelune-identity-v1';

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

export function isPaired(identity) {
  return !!(identity && identity.partnerPublicKey && identity.roomId);
}