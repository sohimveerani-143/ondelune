// presence.js — "typing…" and "online / last seen".
//
// HONESTY NOTE: unlike message content, these two signals are stored as plain
// timestamps, not ciphertext. There is nothing to encrypt here — a boolean
// "is typing" and a heartbeat time are pure metadata, the same category as the
// `createdAt` and `senderUid` fields the app already stores in the clear so it
// can sort and attribute messages. The server can therefore see WHEN the two of
// you are active, but never a single word of WHAT you say. If that tradeoff
// isn't wanted, presence can be turned off in Settings and nothing is written.
import { db, ensureSignedIn, doc, setDoc, onSnapshot, collection } from './firebase.js';

const TYPING_WINDOW_MS = 5000;
const HEARTBEAT_MS = 45000;

let heartbeatTimer = null;
let lastTypingWrite = 0;

export async function startHeartbeat(roomId) {
  stopHeartbeat();
  const beat = async () => {
    try {
      const user = await ensureSignedIn();
      await setDoc(
        doc(db, 'rooms', roomId, 'presence', user.uid),
        { uid: user.uid, lastSeen: Date.now() },
        { merge: true }
      );
    } catch (e) {
      // Presence is a nicety, never a blocker — fail quietly and try again next beat.
    }
  };
  beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  return stopHeartbeat;
}

export function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// Throttled so a fast typist doesn't generate a write per keystroke.
export async function signalTyping(roomId) {
  const now = Date.now();
  if (now - lastTypingWrite < 2000) return;
  lastTypingWrite = now;
  try {
    const user = await ensureSignedIn();
    await setDoc(
      doc(db, 'rooms', roomId, 'presence', user.uid),
      { uid: user.uid, lastSeen: now, typingUntil: now + TYPING_WINDOW_MS },
      { merge: true }
    );
  } catch (e) {
    /* non-critical */
  }
}

export async function clearTyping(roomId) {
  lastTypingWrite = 0;
  try {
    const user = await ensureSignedIn();
    await setDoc(
      doc(db, 'rooms', roomId, 'presence', user.uid),
      { uid: user.uid, lastSeen: Date.now(), typingUntil: 0 },
      { merge: true }
    );
  } catch (e) {
    /* non-critical */
  }
}

// Reports on the PARTNER only — your own presence is never shown back to you.
export function listenPartnerPresence(roomId, partnerUid, onPresence) {
  if (!partnerUid) return () => {};
  return onSnapshot(
    doc(db, 'rooms', roomId, 'presence', partnerUid),
    (snap) => {
      const d = snap.data();
      if (!d) return onPresence({ online: false, typing: false, lastSeen: null });
      const now = Date.now();
      onPresence({
        online: !!d.lastSeen && now - d.lastSeen < HEARTBEAT_MS * 2,
        typing: !!d.typingUntil && d.typingUntil > now,
        lastSeen: d.lastSeen || null,
      });
    },
    () => onPresence({ online: false, typing: false, lastSeen: null })
  );
}
