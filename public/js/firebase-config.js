// firebase-config.js
// Replace these with YOUR Firebase project's values.
// Get them from: Firebase Console → Project Settings → General → "Your apps" → SDK setup and config
// These values are not secret (they identify your project, not authenticate requests) —
// it's safe for them to sit in this file even though the app is public.
export const firebaseConfig = {
  apiKey: "AIzaSyAtyEoNfQlEjHwzTy8ydH7ydOYiqZu3zN4",
  authDomain: "tether-7228f.firebaseapp.com",
  projectId: "tether-7228f",
  storageBucket: "tether-7228f.firebasestorage.app",
  messagingSenderId: "548763512165",
  appId: "1:548763512165:web:51bbedda2a5fe8df9c858c",
  measurementId: "G-3PPM6P02E2"
};

// Web Push (VAPID) PUBLIC key — required for server push to a fully-closed app.
// Get it from: Firebase Console → Project Settings → Cloud Messaging →
// "Web configuration" → Web Push certificates → Key pair (generate if empty).
// It's a public key, so it's fine sitting here like the rest of the config.
// While this is empty, push simply stays off and the app falls back to the
// local-only notifications it already had — nothing breaks.
export const vapidKey = "";
