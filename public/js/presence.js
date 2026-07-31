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

// Tuned for a responsive "typing…" without hammering Firestore. The window is
// short so a stalled indicator self-clears fast; the throttle is well under the
// window so a steady typist keeps it alive with one write per second.
const TYPING_WINDOW_MS = 3500;
const TYPING_THROTTLE_MS = 900;
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

// Stamps "I was here just now" immediately, independent of the heartbeat.
//
// Without this, lastSeen was only ever as fresh as the last 45s tick, so the
// moment someone actually closed the app was never recorded — their partner
// would see a time up to a minute stale, or nothing useful at all. This is
// called when the app is being hidden or closed, which is exactly the instant
// worth recording, and it's the value shown as "last seen".
export async function markSeenNow(roomId) {
  if (!roomId) return;
  try {
    const user = await ensureSignedIn();
    await setDoc(
      doc(db, 'rooms', roomId, 'presence', user.uid),
      { uid: user.uid, lastSeen: Date.now(), typingUntil: 0 },
      { merge: true }
    );
  } catch (e) {
    /* best effort — the page may be going away */
  }
}

// Throttled so a fast typist doesn't generate a write per keystroke.
export async function signalTyping(roomId) {
  const now = Date.now();
  if (now - lastTypingWrite < TYPING_THROTTLE_MS) return;
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
//
// The important subtlety: `typingUntil` is a moment in the future, so whether
// someone "is typing" changes with the clock, not just with new data. Snapshots
// only arrive when the doc is written, so if they stopped typing without another
// write, a purely snapshot-driven view would show "typing…" forever. We therefore
// re-evaluate locally with a timer set to fire exactly when the window lapses.
export function listenPartnerPresence(roomId, partnerUid, onPresence) {
  if (!partnerUid) return () => {};
  let expiryTimer = null;
  let latest = null;

  const emit = () => {
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    const now = Date.now();
    if (!latest) return onPresence({ online: false, typing: false, lastSeen: null, inGame: false, gameSeen: null });

    const typing = !!latest.typingUntil && latest.typingUntil > now;
    onPresence({
      online: !!latest.lastSeen && now - latest.lastSeen < HEARTBEAT_MS * 2,
      typing,
      lastSeen: latest.lastSeen || null,
      inGame: !!latest.gameActive && !!latest.gameSeen && now - latest.gameSeen < GAME_AWAY_MS,
      gameSeen: latest.gameSeen || null,
    });
    if (typing) {
      expiryTimer = setTimeout(emit, latest.typingUntil - now + 50);
    }
  };

  const unsub = onSnapshot(
    doc(db, 'rooms', roomId, 'presence', partnerUid),
    (snap) => {
      latest = snap.data() || null;
      emit();
    },
    () => {
      latest = null;
      emit();
    }
  );

  return () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    unsub();
  };
}

// ---------------- Game presence ----------------
// The game needs a much faster "are they still here" signal than the chat's
// 45s heartbeat, so it gets its own beat while the board is on screen.
export const GAME_AWAY_MS = 22000;
const GAME_BEAT_MS = 8000;
let gameTimer = null;

export async function startGamePresence(roomId) {
  stopGamePresence();
  const beat = async () => {
    try {
      const user = await ensureSignedIn();
      await setDoc(
        doc(db, 'rooms', roomId, 'presence', user.uid),
        { uid: user.uid, lastSeen: Date.now(), gameActive: true, gameSeen: Date.now() },
        { merge: true }
      );
    } catch (e) {
      /* non-critical */
    }
  };
  beat();
  gameTimer = setInterval(beat, GAME_BEAT_MS);
}

// Called when leaving the board or backgrounding the app — flips the flag
// immediately so the partner sees "stepped away" without waiting for a timeout.
export async function stopGamePresence(roomId) {
  if (gameTimer) clearInterval(gameTimer);
  gameTimer = null;
  if (!roomId) return;
  try {
    const user = await ensureSignedIn();
    await setDoc(
      doc(db, 'rooms', roomId, 'presence', user.uid),
      { uid: user.uid, lastSeen: Date.now(), gameActive: false },
      { merge: true }
    );
  } catch (e) {
    /* non-critical */
  }
}
