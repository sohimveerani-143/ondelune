// firebase.js — thin wrapper around the Firebase modular SDK (loaded via CDN, no build step).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  signOut as firebaseSignOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  getDocs,
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
  increment,
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

// Firebase restores a persisted session ASYNCHRONOUSLY. In the moment right
// after getAuth(), auth.currentUser is always null — even when a real, valid
// session is sitting in IndexedDB waiting to be read back. Trusting that null
// caused the worst bug this app has had: boot() saw "nobody is signed in",
// called signInAnonymously(), and silently replaced the paired account with a
// brand-new one. The device kept its keys and room id but was no longer a
// member of its own room, so every read and write was refused by the server.
// Nothing below may look at auth.currentUser until this settles.
let readyPromise = null;
export function authReady() {
  if (readyPromise) return readyPromise;
  readyPromise =
    typeof auth.authStateReady === 'function'
      ? auth.authStateReady()
      : new Promise((resolve) => {
          const unsub = onAuthStateChanged(
            auth,
            () => {
              unsub();
              resolve();
            },
            () => {
              unsub();
              resolve();
            }
          );
        });
  return readyPromise;
}

// The signed-in account, or null — never creates one. Use this when "nobody is
// signed in" is a state to handle rather than a state to fix, which is the case
// anywhere a paired identity already exists on the device.
export async function currentUserOrNull() {
  await authReady();
  return auth.currentUser;
}

export async function ensureSignedIn() {
  await authReady();
  if (!auth.currentUser) {
    await signInAnonymously(auth);
  }
  return auth.currentUser;
}

export async function signOutOfAccount() {
  await firebaseSignOut(auth);
}

export {
  doc,
  getDoc,
  getDocs,
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
  increment,
};
