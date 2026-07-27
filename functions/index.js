/**
 * Tidelight Cloud Functions — server-side push notifications.
 *
 * This is the ONLY part of Tidelight that runs on a server, and it exists for
 * exactly one reason: delivering a notification to a phone whose app is fully
 * closed. A browser can't do that on its own — the FCM send API needs a trusted
 * credential, which must never sit in client code — so it lives here, where the
 * admin SDK is trusted automatically.
 *
 * PRIVACY / E2EE: these functions never read message content. They can't — it's
 * encrypted with a key that only the two devices hold. All they read is which
 * two accounts are in a room (already plaintext, needed for security rules) and
 * the recipient's push token. The notification body is a fixed, content-free
 * string. So the end-to-end guarantee is untouched: the server still only ever
 * sees ciphertext, and the words are only ever decrypted on-device.
 *
 * Deploy: see PUSH-SETUP.md. Requires the Blaze (pay-as-you-go) plan.
 */
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 3 });

/**
 * Sends one content-free push to whichever room member did NOT write the doc.
 * Silently cleans up a token FCM reports as dead.
 */
async function pushToPartner(roomId, senderUid, body) {
  if (!roomId || !senderUid) return;
  const db = getFirestore();

  const roomSnap = await db.doc(`rooms/${roomId}`).get();
  const members = (roomSnap.exists && roomSnap.data().memberUids) || [];
  const recipient = members.find((uid) => uid !== senderUid);
  if (!recipient) return;

  const tokenSnap = await db.doc(`rooms/${roomId}/push/${recipient}`).get();
  const token = tokenSnap.exists ? tokenSnap.data().token : null;
  if (!token) return;

  try {
    await getMessaging().send({
      token,
      notification: { title: 'Tidelight', body },
      webpush: {
        notification: {
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
          tag: 'tidelight',
          renotify: true,
        },
        fcmOptions: { link: '/index.html' },
      },
    });
  } catch (err) {
    const code = err && (err.code || (err.errorInfo && err.errorInfo.code));
    // A token dies when the app is uninstalled or the browser data cleared.
    // Drop it so we don't keep trying (and so it can be re-registered fresh).
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      await db.doc(`rooms/${roomId}/push/${recipient}`).delete().catch(() => {});
    } else {
      console.error('push send failed:', code || err);
    }
  }
}

exports.notifyOnMessage = onDocumentCreated('rooms/{roomId}/thread/{id}', (event) => {
  const data = event.data && event.data.data();
  if (!data) return null;
  return pushToPartner(event.params.roomId, data.senderUid, 'New message 🌙');
});

exports.notifyOnNudge = onDocumentCreated('rooms/{roomId}/nudges/{id}', (event) => {
  const data = event.data && event.data.data();
  if (!data) return null;
  return pushToPartner(event.params.roomId, data.senderUid, 'Your person is thinking of you 💭');
});
