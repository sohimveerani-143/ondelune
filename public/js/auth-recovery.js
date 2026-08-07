// auth-recovery.js — OPTIONAL, but recommended. Upgrades the anonymous identity to
// one recoverable by email + password. Critically, this uses Firebase's "link"
// flow rather than creating a new account — the UID stays the same, so the paired
// room and all history remain accessible after recovery. Nothing here weakens the
// end-to-end encryption: the backup itself is encrypted with a key derived from
// your password before it ever leaves the device, so Firebase still only ever
// stores ciphertext.
import { auth, db, doc, setDoc, getDoc } from './firebase.js';
import {
  EmailAuthProvider,
  linkWithCredential,
  signInWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  encryptWithPassphrase,
  decryptWithPassphrase,
  encryptWithRawKey,
  decryptWithRawKey,
  randomKeyB64,
} from './crypto.js';

// Everything needed to be fully functional again on a new device.
// `partnerUid` in particular MUST be here: it was missing originally, and
// without it a recovered device still opens and shows history but has no idea
// who its partner is — presence, unread badges, the streak, profile pictures,
// expense attribution and the game all quietly stop working.
function backupPayload(identity) {
  return {
    displayName: identity.displayName,
    timezone: identity.timezone,
    gender: identity.gender || null,
    publicKey: identity.publicKey,
    secretKey: identity.secretKey,
    partnerPublicKey: identity.partnerPublicKey || null,
    partnerName: identity.partnerName || null,
    partnerTimezone: identity.partnerTimezone || null,
    partnerUid: identity.partnerUid || null,
    roomId: identity.roomId || null,
    myUid: identity.myUid || null,
  };
}

function backupRef(uid) {
  return doc(db, 'users', uid, 'backup', 'identity');
}

// Returns the locally-held backup key, which the caller must persist into the
// device identity — without it the backup can never be refreshed again without
// asking for the password.
export async function setUpRecovery(email, password, identity) {
  const credential = EmailAuthProvider.credential(email, password);
  try {
    await linkWithCredential(auth.currentUser, credential);
  } catch (e) {
    // Firebase's own wording here is opaque, and the distinction matters a lot:
    // an address already attached to some other account cannot be used, because
    // linking is the only thing that keeps this device's account id intact.
    if (e?.code === 'auth/email-already-in-use' || e?.code === 'auth/credential-already-in-use') {
      throw new Error(
        'That email already belongs to another account. Recovery has to attach to the account this device is already using, so pick a different email address.'
      );
    }
    if (e?.code === 'auth/weak-password') {
      throw new Error('That password is too weak — use at least six characters.');
    }
    if (e?.code === 'auth/operation-not-allowed') {
      throw new Error(
        'Email/password sign-in is not switched on for this Firebase project yet (Authentication → Sign-in method).'
      );
    }
    throw e;
  }

  const backupKey = randomKeyB64();
  await writeBackup({ ...identity, myUid: auth.currentUser.uid }, backupKey, password);
  return backupKey;
}

// The payload is sealed with the random backup key; the backup key is sealed
// with the password. Refreshing later only needs the former.
async function writeBackup(identity, backupKey, password) {
  const payload = await encryptWithRawKey(backupPayload(identity), backupKey);
  const wrappedKey = await encryptWithPassphrase({ backupKey }, password);
  await setDoc(backupRef(auth.currentUser.uid), {
    v: 2,
    payload,
    wrappedKey,
    updatedAt: Date.now(),
  });
}

// Called whenever the backed-up facts change — above all when pairing finishes.
// The original code only ever wrote this backup during onboarding, which is
// BEFORE pairing exists, so every backup taken that way restored a device that
// had no room and no partner. Best-effort by design: a failed refresh must
// never interrupt whatever the user was actually doing.
export async function refreshBackup(identity) {
  if (!identity?.recoveryEmail || !identity?.backupKey || !auth.currentUser) return false;
  try {
    const payload = await encryptWithRawKey(backupPayload(identity), identity.backupKey);
    await setDoc(backupRef(auth.currentUser.uid), { v: 2, payload, updatedAt: Date.now() }, { merge: true });
    return true;
  } catch (e) {
    return false;
  }
}

// Called on a fresh device with no local identity at all.
export async function recoverFromEmail(email, password) {
  let cred;
  try {
    cred = await signInWithEmailAndPassword(auth, email, password);
  } catch (e) {
    if (e?.code === 'auth/invalid-credential' || e?.code === 'auth/wrong-password') {
      throw new Error('That email and password did not match. Check both and try again.');
    }
    if (e?.code === 'auth/user-not-found') {
      throw new Error('No account exists for that email address.');
    }
    if (e?.code === 'auth/too-many-requests') {
      throw new Error('Too many attempts. Wait a few minutes and try again.');
    }
    throw e;
  }

  const snap = await getDoc(backupRef(cred.user.uid));
  if (!snap.exists()) {
    throw new Error('No backup was found for this account.');
  }
  const data = snap.data();

  // v1 backups sealed the whole payload with the password directly, leaving no
  // key behind to refresh with. This is the one moment the password is legitimately
  // in hand, so upgrade to the v2 envelope here rather than leaving the account
  // permanently unable to keep its own backup current.
  if (!data.v || data.v < 2) {
    const recovered = await decryptWithPassphrase(data, password);
    const backupKey = randomKeyB64();
    try {
      await writeBackup({ ...recovered, myUid: cred.user.uid }, backupKey, password);
      return { ...recovered, backupKey };
    } catch (e) {
      return { ...recovered, backupKey: null };
    }
  }

  const { backupKey } = await decryptWithPassphrase(data.wrappedKey, password);
  const recovered = await decryptWithRawKey(data.payload, backupKey);
  return { ...recovered, backupKey };
}
