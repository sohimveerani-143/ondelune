// pairing.js — one-time link pairing.
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

export function listenForJoin(pairingId, onJoined) {
  return onSnapshot(doc(db, 'pairings', pairingId), (snap) => {
    const data = snap.data();
    if (data && data.status === 'paired' && data.joinerPublicKey) {
      onJoined(data);
    }
  });
}

export async function finalizeRoomAsCreator({ myPublicKey, partnerPublicKey, myUid, partnerUid }) {
  const roomId = await computeRoomId(myPublicKey, partnerPublicKey);
  await setDoc(
    doc(db, 'rooms', roomId),
    { memberUids: [myUid, partnerUid].sort() },
    { merge: true }
  );
  return roomId;
}

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
    myUid: user.uid,
  };
}