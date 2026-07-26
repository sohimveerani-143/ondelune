// notify.js — new-message notifications.
//
// READ THIS BEFORE "IMPROVING" IT:
// These are LOCAL notifications, fired by this device while Tidelight is still
// running (foreground, or backgrounded but not killed). They are real and they
// work — but they are NOT server push. If the app is fully closed or the phone
// evicts it from memory, nothing arrives until it's opened again.
//
// True push (delivery to a closed app) needs Firebase Cloud Messaging, and FCM
// can only be *sent* from a trusted server — the send API requires a service
// account key, which must never sit in client code. So it would mean a Cloud
// Function (Blaze plan) and, to keep E2EE intact, an encrypted payload that the
// service worker decrypts locally. That's a real, buildable path; it's just not
// something the client can fake on its own. The UI says exactly this, rather
// than implying notifications are more reliable than they are.

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
