// pairing.js — one-time link pairing. Once a pairing doc is marked 'paired',
// it can never be reused, and there is no UI anywhere to add a second partner.
import {
  db,
  ensureSignedIn,
  doc,
  setDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from './firebase.js';
import { randomToken, computeRoomId } from './crypto.js';

export function pairingLinkFor(pairingId) {
  const url = new URL(window.location.href);
  url.hash = `pair=${pairingId}`;
  return url.toString();
}

export function getPairingIdFromUrl() {
  const match = window.location.hash.match(/pair=([a-f0-9]+)/);
  return match ? match[1] : null;
}

// Called by the person generating the link.
export async function createPairing({ publicKey, displayName, timezone }) {
  const user = await ensureSignedIn();
  const pairingId = randomToken(8);
  await setDoc(doc(db, 'pairings', pairingId), {
    creatorUid: user.uid,
    creatorPublicKey: publicKey,
    creatorName: displayName,
    creatorTimezone: timezone,
    status: 'pending',
    createdAt: serverTimestamp(),
  });
  return pairingId;
}

// Creator side: listen until the partner joins.
// onError is invoked if the listener itself fails (e.g. a permission or network
// error). Without it, a failed listener would die silently and the creator would
// wait forever — the exact "stuck on Waiting for them" symptom.
export function listenForJoin(pairingId, onJoined, onError) {
  return onSnapshot(
    doc(db, 'pairings', pairingId),
    (snap) => {
      const data = snap.data();
      if (data && data.status === 'paired' && data.joinerPublicKey) {
        onJoined(data);
      }
    },
    (err) => {
      if (onError) onError(err);
    }
  );
}

// Once the creator sees the join, finalize the shared room doc.
export async function finalizeRoomAsCreator({ myPublicKey, partnerPublicKey, myUid, partnerUid }) {
  const roomId = await computeRoomId(myPublicKey, partnerPublicKey);
  await setDoc(
    doc(db, 'rooms', roomId),
    { memberUids: [myUid, partnerUid].sort() },
    { merge: true }
  );
  return roomId;
}

// Called by the person who opened the link. Transaction guarantees a
// pairing link can only ever be consumed once — a second attempt throws.
export async function joinPairing(pairingId, { publicKey, displayName, timezone }) {
  const user = await ensureSignedIn();
  const pairingRef = doc(db, 'pairings', pairingId);

  const creatorInfo = await runTransaction(db, async (tx) => {
    const snap = await tx.get(pairingRef);
    if (!snap.exists()) {
      throw new Error('This pairing link is invalid.');
    }
    const data = snap.data();
    if (data.status === 'paired') {
      throw new Error('This pairing link has already been used.');
    }
    // A pairing link is meant to connect two different people. If the same
    // anonymous account opens its own link (e.g. two tabs in one browser
    // profile share a UID), fail clearly instead of "pairing" with itself.
    if (data.creatorUid === user.uid) {
      throw new Error(
        "This link was created on this same account. Open it on your partner's device (or a private/incognito window), not the one that made it."
      );
    }
    tx.update(pairingRef, {
      joinerUid: user.uid,
      joinerPublicKey: publicKey,
      joinerName: displayName,
      joinerTimezone: timezone,
      status: 'paired',
      joinedAt: serverTimestamp(),
    });
    return data;
  });

  const roomId = await computeRoomId(publicKey, creatorInfo.creatorPublicKey);
  await setDoc(
    doc(db, 'rooms', roomId),
    { memberUids: [user.uid, creatorInfo.creatorUid].sort() },
    { merge: true }
  );

  return {
    roomId,
    partnerPublicKey: creatorInfo.creatorPublicKey,
    partnerName: creatorInfo.creatorName,
    partnerTimezone: creatorInfo.creatorTimezone,
    creatorUid: creatorInfo.creatorUid,
    myUid: user.uid,
  };
}
