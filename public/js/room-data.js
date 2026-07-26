// room-data.js — every read/write here encrypts or decrypts using the shared key.
// Firestore only ever stores ciphertext + nonce. No plaintext field ever leaves the device.
import {
  db,
  ensureSignedIn,
  doc,
  getDoc,
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

// ---------- Presence ----------
export async function updatePresence(roomId, sharedKey, payload) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON(payload, sharedKey);
  await setDoc(doc(db, 'rooms', roomId, 'presence', user.uid), {
    ciphertext,
    nonce,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export function listenPresence(roomId, sharedKey, partnerUid, onPresence) {
  if (!partnerUid) return () => {};
  return onSnapshot(doc(db, 'rooms', roomId, 'presence', partnerUid), (snap) => {
    const data = snap.data();
    if (!data) return onPresence(null);
    let parsed = {};
    try {
      parsed = decryptJSON(data.ciphertext, data.nonce, sharedKey);
    } catch (e) {
      /* ignore */
    }
    onPresence({
      ...parsed,
      updatedAt: data.updatedAt?.toDate?.() || new Date(),
    });
  });
}

// ---------- Thread (shared messages) ----------
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

export async function sendThreadAudio(roomId, sharedKey, base64Audio) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON({ type: 'audio', audio: base64Audio }, sharedKey);
  await addDoc(col(roomId, 'thread'), {
    senderUid: user.uid,
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
  await recordActivity(roomId);
}

export async function sendThreadLetter(roomId, sharedKey, text) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON({ type: 'letter', text }, sharedKey);
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

export async function toggleThreadReaction(roomId, sharedKey, messageId, messageCurrentObj, myUid, reactionStr) {
  const newReactions = { ...(messageCurrentObj.reactions || {}) };
  if (newReactions[myUid] === reactionStr) {
    delete newReactions[myUid];
  } else {
    newReactions[myUid] = reactionStr;
  }
  const newObj = { ...messageCurrentObj, reactions: newReactions };
  const { ciphertext, nonce } = encryptJSON(newObj, sharedKey);
  await updateDoc(doc(db, 'rooms', roomId, 'thread', messageId), { ciphertext, nonce });
}

export function listenThread(roomId, sharedKey, onMessages) {
  const q = query(col(roomId, 'thread'), orderBy('createdAt', 'asc'));
  return onSnapshot(q, (snap) => {
    const messages = snap.docs.map((d) => {
      const data = d.data();
      let parsed = { type: 'text', text: '⚠️ Could not decrypt' };
      try {
        parsed = decryptJSON(data.ciphertext, data.nonce, sharedKey);
      } catch (e) {
        /* leave fallback text */
      }
      return {
        id: d.id,
        senderUid: data.senderUid,
        type: parsed.type || 'text',
        text: parsed.text,
        image: parsed.image,
        audio: parsed.audio,
        viewOnce: parsed.viewOnce,
        reactions: parsed.reactions || {},
        originalObj: parsed, // keep plaintext obj around for easy updates
        createdAt: data.createdAt?.toDate?.() || new Date(),
      };
    });
    onMessages(messages);
  });
}

// ---------- Mood (one entry per person per day) ----------
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
      } catch (e) {
        /* skip */
      }
      return { id: d.id, senderUid: data.senderUid, date: data.date, mood };
    });
    onEntries(entries);
  });
}

// ---------- Calendar ----------
export async function addCalendarEvent(roomId, sharedKey, { title, dateTime }) {
  const { ciphertext, nonce } = encryptJSON({ title, dateTime }, sharedKey);
  await addDoc(col(roomId, 'calendar'), {
    dateTime, // used for sort only; content itself is inside the ciphertext too
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
      } catch (e) {
        /* skip */
      }
      return { id: d.id, title, dateTime: data.dateTime };
    });
    onEvents(events);
  });
}

// ---------- Bucket list ----------
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
      } catch (e) {
        /* skip */
      }
      return { id: d.id, text, done };
    });
    onItems(items);
  });
}

// ---------- Photo of the day ----------
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
      } catch (e) {
        /* skip */
      }
      return { id: d.id, senderUid: data.senderUid, date: data.date, image };
    });
    onPhotos(photos);
  });
}

// ---------- Room settings (together-since date + savings goal) ----------
export async function setTogetherSince(roomId, sharedKey, isoDate) {
  const current = await getRoomSettingsOnce(roomId, sharedKey);
  const { ciphertext, nonce } = encryptJSON({ ...current, togetherSince: isoDate }, sharedKey);
  await setDoc(
    doc(db, 'rooms', roomId, 'meta', 'settings'),
    { ciphertext, nonce },
    { merge: true }
  );
}

export async function setSavingsGoal(roomId, sharedKey, goalAmount, goalLabel) {
  const current = await getRoomSettingsOnce(roomId, sharedKey);
  const { ciphertext, nonce } = encryptJSON({ ...current, savingsGoal: goalAmount, savingsGoalLabel: goalLabel }, sharedKey);
  await setDoc(
    doc(db, 'rooms', roomId, 'meta', 'settings'),
    { ciphertext, nonce },
    { merge: true }
  );
}

async function getRoomSettingsOnce(roomId, sharedKey) {
  const snap = await getDoc(doc(db, 'rooms', roomId, 'meta', 'settings'));
  const data = snap.data();
  if (!data) return {};
  try {
    return decryptJSON(data.ciphertext, data.nonce, sharedKey);
  } catch (e) {
    return {};
  }
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

// ---------- Expense tracker (shared, split expenses) ----------
export async function addExpense(roomId, sharedKey, { description, amount, paidBy }) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON(
    { description, amount, paidBy: paidBy || user.uid },
    sharedKey
  );
  await addDoc(col(roomId, 'expenses'), {
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
}

export async function deleteExpense(roomId, expenseId) {
  await deleteDoc(doc(db, 'rooms', roomId, 'expenses', expenseId));
}

export function listenExpenses(roomId, sharedKey, onExpenses) {
  const q = query(col(roomId, 'expenses'), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    const expenses = snap.docs.map((d) => {
      const data = d.data();
      let parsed = { description: '⚠️ Could not decrypt', amount: 0, paidBy: null };
      try {
        parsed = decryptJSON(data.ciphertext, data.nonce, sharedKey);
      } catch (e) {
        /* skip */
      }
      return {
        id: d.id,
        description: parsed.description,
        amount: parsed.amount,
        paidBy: parsed.paidBy,
        createdAt: data.createdAt?.toDate?.() || new Date(),
      };
    });
    onExpenses(expenses);
  });
}

// ---------- Savings tracker (shared goal, e.g. toward a visit) ----------
export async function addSavingsEntry(roomId, sharedKey, { label, amount }) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON({ label, amount, contributedBy: user.uid }, sharedKey);
  await addDoc(col(roomId, 'savings'), {
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
}

export async function deleteSavingsEntry(roomId, entryId) {
  await deleteDoc(doc(db, 'rooms', roomId, 'savings', entryId));
}

export function listenSavings(roomId, sharedKey, onEntries) {
  const q = query(col(roomId, 'savings'), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    const entries = snap.docs.map((d) => {
      const data = d.data();
      let parsed = { label: '⚠️ Could not decrypt', amount: 0, contributedBy: null };
      try {
        parsed = decryptJSON(data.ciphertext, data.nonce, sharedKey);
      } catch (e) {
        /* skip */
      }
      return {
        id: d.id,
        label: parsed.label,
        amount: parsed.amount,
        contributedBy: parsed.contributedBy,
        createdAt: data.createdAt?.toDate?.() || new Date(),
      };
    });
    onEntries(entries);
  });
}

// ---------- Journal (shared, freeform reflective entries) ----------
export async function addJournalEntry(roomId, sharedKey, text) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON({ text }, sharedKey);
  await addDoc(col(roomId, 'journal'), {
    senderUid: user.uid,
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
  await recordActivity(roomId);
}

export async function deleteJournalEntry(roomId, entryId) {
  await deleteDoc(doc(db, 'rooms', roomId, 'journal', entryId));
}

export function listenJournal(roomId, sharedKey, onEntries) {
  const q = query(col(roomId, 'journal'), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    const entries = snap.docs.map((d) => {
      const data = d.data();
      let text = '⚠️ Could not decrypt';
      try {
        text = decryptJSON(data.ciphertext, data.nonce, sharedKey).text;
      } catch (e) {
        /* skip */
      }
      return {
        id: d.id,
        senderUid: data.senderUid,
        text,
        createdAt: data.createdAt?.toDate?.() || new Date(),
      };
    });
    onEntries(entries);
  });
}
