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
  onSnapshot,
  runTransaction,
  collection,
  addDoc,
  query,
  orderBy,
  serverTimestamp,
  enableIndexedDbPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

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
  onSnapshot,
  runTransaction,
  collection,
  addDoc,
  query,
  orderBy,
  serverTimestamp,
};