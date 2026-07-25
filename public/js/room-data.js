// room-data.js — every read/write here encrypts or decrypts using the shared key.
// Firestore only ever stores ciphertext + nonce. No plaintext field ever leaves the device.
import {
  db,
  ensureSignedIn,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  collection,
  addDoc,
  query,
  orderBy,
  serverTimestamp,
} from './firebase.js';
import { encryptJSON, decryptJSON } from './crypto.js';
import { recordActivity } from './streak.js';

function col(roomId, name) {
  return collection(db, 'rooms', roomId, name);
}

export async function sendThreadMessage(roomId, sharedKey, text) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON({ type: 'text', text }, sharedKey);
  await addDoc(col(roomId, 'thread'), {
    senderUid: user.uid,
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
  await recordActivity(roomId);
}

// View-once photo: once the RECIPIENT opens it, the doc is deleted for both sides.
// This limits exposure time — it cannot stop a screenshot, which no website can do.
export async function sendThreadPhoto(roomId, sharedKey, base64Image, viewOnce) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON({ type: 'photo', image: base64Image, viewOnce: !!viewOnce }, sharedKey);
  await addDoc(col(roomId, 'thread'), {
    senderUid: user.uid,
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
  await recordActivity(roomId);
}

export async function deleteThreadMessage(roomId, messageId) {
  await deleteDoc(doc(db, 'rooms', roomId, 'thread', messageId));
}

export function listenThread(roomId, sharedKey, onMessages) {
  const q = query(col(roomId, 'thread'), orderBy('createdAt', 'asc'));
  return onSnapshot(q, (snap) => {
    const messages = snap.docs.map((d) => {
      const data = d.data();
      let parsed = { type: 'text', text: '⚠️ Could not decrypt' };
      try {
        parsed = decryptJSON(data.ciphertext, data.nonce, sharedKey);
      } catch (e) {}
      return {
        id: d.id,
        senderUid: data.senderUid,
        type: parsed.type || 'text',
        text: parsed.text,
        image: parsed.image,
        viewOnce: parsed.viewOnce,
        createdAt: data.createdAt?.toDate?.() || new Date(),
      };
    });
    onMessages(messages);
  });
}

export async function setTodayMood(roomId, sharedKey, mood) {
  const user = await ensureSignedIn();
  const dateKey = new Date().toISOString().slice(0, 10);
  const docId = `${dateKey}_${user.uid}`;
  const { ciphertext, nonce } = encryptJSON({ mood, date: dateKey }, sharedKey);
  await setDoc(doc(db, 'rooms', roomId, 'mood', docId), {
    senderUid: user.uid,
    date: dateKey,
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
  await recordActivity(roomId);
}

export function listenMood(roomId, sharedKey, onEntries) {
  const q = query(col(roomId, 'mood'), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    const entries = snap.docs.map((d) => {
      const data = d.data();
      let mood = null;
      try {
        mood = decryptJSON(data.ciphertext, data.nonce, sharedKey).mood;
      } catch (e) {}
      return { id: d.id, senderUid: data.senderUid, date: data.date, mood };
    });
    onEntries(entries);
  });
}

export async function addCalendarEvent(roomId, sharedKey, { title, dateTime }) {
  const { ciphertext, nonce } = encryptJSON({ title, dateTime }, sharedKey);
  await addDoc(col(roomId, 'calendar'), {
    dateTime,
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
  await recordActivity(roomId);
}

export function listenCalendar(roomId, sharedKey, onEvents) {
  const q = query(col(roomId, 'calendar'), orderBy('dateTime', 'asc'));
  return onSnapshot(q, (snap) => {
    const events = snap.docs.map((d) => {
      const data = d.data();
      let title = '⚠️ Could not decrypt';
      try {
        title = decryptJSON(data.ciphertext, data.nonce, sharedKey).title;
      } catch (e) {}
      return { id: d.id, title, dateTime: data.dateTime };
    });
    onEvents(events);
  });
}

export async function addBucketItem(roomId, sharedKey, text) {
  const { ciphertext, nonce } = encryptJSON({ text, done: false }, sharedKey);
  await addDoc(col(roomId, 'bucketlist'), {
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
  await recordActivity(roomId);
}

export async function toggleBucketItem(roomId, sharedKey, itemId, currentText, currentDone) {
  const { ciphertext, nonce } = encryptJSON({ text: currentText, done: !currentDone }, sharedKey);
  await updateDoc(doc(db, 'rooms', roomId, 'bucketlist', itemId), { ciphertext, nonce });
}

export function listenBucketList(roomId, sharedKey, onItems) {
  const q = query(col(roomId, 'bucketlist'), orderBy('createdAt', 'asc'));
  return onSnapshot(q, (snap) => {
    const items = snap.docs.map((d) => {
      const data = d.data();
      let text = '⚠️ Could not decrypt';
      let done = false;
      try {
        const parsed = decryptJSON(data.ciphertext, data.nonce, sharedKey);
        text = parsed.text;
        done = parsed.done;
      } catch (e) {}
      return { id: d.id, text, done };
    });
    onItems(items);
  });
}

export async function setTodayPhoto(roomId, sharedKey, base64Jpeg) {
  const user = await ensureSignedIn();
  const dateKey = new Date().toISOString().slice(0, 10);
  const docId = `${dateKey}_${user.uid}`;
  const { ciphertext, nonce } = encryptJSON({ image: base64Jpeg, date: dateKey }, sharedKey);
  await setDoc(doc(db, 'rooms', roomId, 'photos', docId), {
    senderUid: user.uid,
    date: dateKey,
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
  await recordActivity(roomId);
}

export function listenPhotos(roomId, sharedKey, onPhotos, limit = 14) {
  const q = query(col(roomId, 'photos'), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    const photos = snap.docs.slice(0, limit).map((d) => {
      const data = d.data();
      let image = null;
      try {
        image = decryptJSON(data.ciphertext, data.nonce, sharedKey).image;
      } catch (e) {}
      return { id: d.id, senderUid: data.senderUid, date: data.date, image };
    });
    onPhotos(photos);
  });
}

export async function setTogetherSince(roomId, sharedKey, isoDate) {
  const { ciphertext, nonce } = encryptJSON({ togetherSince: isoDate }, sharedKey);
  await setDoc(
    doc(db, 'rooms', roomId, 'meta', 'settings'),
    { ciphertext, nonce },
    { merge: true }
  );
}

export function listenRoomSettings(roomId, sharedKey, onSettings) {
  return onSnapshot(doc(db, 'rooms', roomId, 'meta', 'settings'), (snap) => {
    const data = snap.data();
    if (!data) return onSettings({});
    try {
      onSettings(decryptJSON(data.ciphertext, data.nonce, sharedKey));
    } catch (e) {
      onSettings({});
    }
  });
}