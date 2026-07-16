// firebase.js — thin wrapper around the Firebase modular SDK (loaded via CDN, no build step).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
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

export async function ensureSignedIn() {
  if (!auth.currentUser) {
    await signInAnonymously(auth);
  }
  return auth.currentUser;
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