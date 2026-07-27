// notify.js — new-message notifications.
//
// TWO PATHS, one job:
//  1. APP OPEN (foreground, or a hidden-but-alive tab): the page's own Firestore
//     listener sees the new message, decrypts it on-device, and shows the
//     notification with a real preview. FCM delivers those to the page's
//     onMessage (a no-op here) and does not double up.
//  2. APP FULLY CLOSED: nothing on-device is running, so Firebase Cloud
//     Messaging delivers a server push that firebase-messaging-sw.js displays.
//     The server cannot decrypt anything, so that push says only that your
//     person reached out — never the message itself. E2EE is fully preserved.
//
// Path 2 requires: a VAPID key in firebase-config.js, and the Cloud Function in
// /functions deployed (Blaze plan). Until both are in place, initPush() no-ops
// cleanly and the app just uses path 1, exactly as before.
import { getMessaging, getToken, onMessage, isSupported } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js';

let pushToken = null;
export function currentPushToken() {
  return pushToken;
}

export function pushConfigured(vapidKey) {
  return !!vapidKey;
}

// Registers this device to receive server push. Safe to call repeatedly.
// Returns { ok, reason?, token? }; never throws.
export async function initPush(app, vapidKey, onToken) {
  if (!vapidKey) return { ok: false, reason: 'unconfigured' };
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return { ok: false, reason: 'permission' };
  }
  let supported = false;
  try {
    supported = await isSupported();
  } catch (e) {
    supported = false;
  }
  if (!supported) return { ok: false, reason: 'unsupported' };

  try {
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey });
    if (!token) return { ok: false, reason: 'no-token' };
    pushToken = token;
    // Foreground receipts are already handled by the app's live listener, so
    // this stays a no-op — it exists only to keep FCM wired up while open.
    onMessage(messaging, () => {});
    if (onToken) await onToken(token);
    return { ok: true, token };
  } catch (e) {
    console.warn('Push init failed:', e?.message || e);
    return { ok: false, reason: 'error', error: e };
  }
}

export function notificationsSupported() {
  return typeof Notification !== 'undefined';
}

export function notificationPermission() {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch (e) {
    return 'denied';
  }
}

// Android Chrome does NOT support `new Notification()` — it throws. The only
// supported path there is the service worker registration, so prefer it and
// keep the constructor purely as a desktop fallback.
export async function showNotification(title, body) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return false;
  const options = {
    body,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'tidelight-message',
    renotify: true,
    silent: false,
  };
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, options);
      return true;
    }
  } catch (e) {
    /* fall through to the constructor */
  }
  try {
    new Notification(title, options);
    return true;
  } catch (e) {
    return false;
  }
}

// A short preview of an already-decrypted message. Decryption happens on-device
// as always — the notification text never touches a server.
export function previewFor(message, partnerName) {
  const who = partnerName || 'Them';
  if (!message) return { title: who, body: 'New message' };
  if (message.type === 'photo') return { title: who, body: '📷 Sent a photo' };
  if (message.type === 'voice') return { title: who, body: '🎤 Sent a voice note' };
  const text = String(message.text || '').slice(0, 120);
  return { title: who, body: text || 'New message' };
}
