// auth-recovery.js — OPTIONAL, but recommended. Upgrades the anonymous identity to
// one recoverable by email + password, using Firebase's "link" flow so the UID
// (and therefore your paired room) stays the same. The backup itself is encrypted
// with a key derived from your password before it ever leaves the device.
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

  const backup = await encryptWithPassphrase(
    {
      displayName: identity.displayName,
      timezone: identity.timezone,
      publicKey: identity.publicKey,
      secretKey: identity.secretKey,
      partnerPublicKey: identity.partnerPublicKey || null,
      partnerName: identity.partnerName || null,
      partnerTimezone: identity.partnerTimezone || null,
      roomId: identity.roomId || null,
    },
    password
  );

  await setDoc(doc(db, 'users', auth.currentUser.uid, 'backup', 'identity'), {
    ...backup,
    updatedAt: Date.now(),
  });
}

export async function recoverFromEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const snap = await getDoc(doc(db, 'users', cred.user.uid, 'backup', 'identity'));
  if (!snap.exists()) {
    throw new Error('No backup was found for this account.');
  }
  return decryptWithPassphrase(snap.data(), password);
}