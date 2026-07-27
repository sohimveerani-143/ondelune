/* firebase-messaging-sw.js — Firebase Cloud Messaging service worker.
 *
 * This runs ONLY when Tidelight is fully closed. While the app is open — even in
 * a hidden background tab — the page itself receives the message and shows the
 * notification, so this worker never doubles up with it.
 *
 * A service worker can't load ES modules via importScripts, so this file uses
 * the Firebase "compat" build. It's isolated to this one file and doesn't affect
 * the buildless, modular app in /js.
 *
 * PRIVACY: the push payload the server sends NEVER contains message content.
 * The Cloud Function that sends it cannot decrypt anything — it only knows that
 * *something* arrived — so the notification says exactly that and no more. The
 * real, decrypted preview is only ever shown by the app itself, on-device.
 *
 * Keep the config below in sync with js/firebase-config.js.
 */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyAtyEoNfQlEjHwzTy8ydH7ydOYiqZu3zN4',
  authDomain: 'tether-7228f.firebaseapp.com',
  projectId: 'tether-7228f',
  storageBucket: 'tether-7228f.firebasestorage.app',
  messagingSenderId: '548763512165',
  appId: '1:548763512165:web:51bbedda2a5fe8df9c858c',
});

// Registering messaging is what lets FCM deliver to this worker. We deliberately
// do NOT add an onBackgroundMessage handler: with a plain `notification` payload
// and no handler, Firebase auto-displays the notification and wires up the click
// (focus the open tab, or open the app) on its own. Less code, fewer ways to
// break the one thing this worker exists to do.
firebase.messaging();
