// applock.js — an OPTIONAL local PIN. This is a different threat model from the
// cloud recovery in auth-recovery.js: this protects the private key sitting in this
// device's storage from someone who has physical access to your unlocked phone.
// It does NOT touch the cloud — nothing here is sent anywhere.
import { encryptWithPassphrase, decryptWithPassphrase } from './crypto.js';

export async function lockIdentityWithPin(identity, pin) {
  const secretKeyLocked = await encryptWithPassphrase({ secretKey: identity.secretKey }, pin);
  const { secretKey, ...rest } = identity;
  return { ...rest, secretKeyLocked, pinEnabled: true };
}

export async function unlockIdentityWithPin(lockedIdentity, pin) {
  const { secretKey } = await decryptWithPassphrase(lockedIdentity.secretKeyLocked, pin);
  return { ...lockedIdentity, secretKey };
}

export function needsUnlock(identity) {
  return !!(identity?.pinEnabled && !identity.secretKey);
}