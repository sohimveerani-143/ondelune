// firebase.js — thin wrapper around the Firebase modular SDK (loaded via CDN, no build step).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
  signOut as firebaseSignOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  runTransaction,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
  enableIndexedDbPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Offline persistence is nice-to-have, not required — never let it block startup,
// and never use top-level await here (unsupported in some older mobile WebViews,
// and a silent failure here previously caused a blank screen with no error shown).
let persistenceAttempted = false;
export async function tryEnableOfflinePersistence() {
  if (persistenceAttempted) return;
  persistenceAttempted = true;
  try {
    await enableIndexedDbPersistence(db);
  } catch (e) {
    console.warn('Offline persistence unavailable:', e?.message || e);
  }
}

// Wait for Firebase Auth to finish restoring the persisted session.
// onAuthStateChanged fires exactly once with the restored user (or null)
// before any other auth events. Without this, auth.currentUser is null
// during the brief window between SDK init and session restoration,
// which causes signInAnonymously() to mint a brand-new UID.
let authReadyPromise = null;
function waitForAuthReady() {
  if (!authReadyPromise) {
    authReadyPromise = new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, (user) => {
        unsub();
        resolve(user);
      });
    });
  }
  return authReadyPromise;
}

export async function ensureSignedIn() {
  let user = auth.currentUser;
  if (!user) {
    user = await waitForAuthReady();
  }
  if (!user) {
    await signInAnonymously(auth);
    user = auth.currentUser;
  }
  return user;
}


export async function signOutOfAccount() {
  await firebaseSignOut(auth);
}

export {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  runTransaction,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
};
