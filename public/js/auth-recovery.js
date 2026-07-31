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
import { encryptWithPassphrase, decryptWithPassphrase } from './crypto.js';

export async function setUpRecovery(email, password, identity) {
  const credential = EmailAuthProvider.credential(email, password);
  await linkWithCredential(auth.currentUser, credential);

  // Everything needed to be fully functional again on a new device.
  // `partnerUid` in particular MUST be here: it was missing originally, and
  // without it a recovered device still opens and shows history but has no idea
  // who its partner is — presence, unread badges, the streak, profile pictures,
  // expense attribution and the game all quietly stop working.
  const backup = await encryptWithPassphrase(
    {
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
    },
    password
  );

  await setDoc(doc(db, 'users', auth.currentUser.uid, 'backup', 'identity'), {
    ...backup,
    updatedAt: Date.now(),
  });
}

// Called on a fresh device with no local identity at all.
export async function recoverFromEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const snap = await getDoc(doc(db, 'users', cred.user.uid, 'backup', 'identity'));
  if (!snap.exists()) {
    throw new Error('No backup was found for this account.');
  }
  return decryptWithPassphrase(snap.data(), password);
}
