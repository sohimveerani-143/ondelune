// room-data.js — every read/write here encrypts or decrypts using the shared key.
// Firestore only ever stores ciphertext + nonce. No plaintext field ever leaves the device.
import {
  db,
  ensureSignedIn,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  collection,
  addDoc,
  query,
  orderBy,
  limit as fbLimit,
  serverTimestamp,
} from './firebase.js';
import { encryptJSON, decryptJSON } from './crypto.js';
import { recordActivity } from './streak.js';

function col(roomId, name) {
  return collection(db, 'rooms', roomId, name);
}

// ---------- Thread (shared messages) ----------
// `replyTo` is a small {id, snippet, senderUid} object stored INSIDE the
// encrypted payload — the quote is content, so it gets the same protection as
// the message itself. Firestore never sees the quoted words.
export async function sendThreadMessage(roomId, sharedKey, text, replyTo) {
  const user = await ensureSignedIn();
  const payload = { type: 'text', text };
  if (replyTo) payload.replyTo = replyTo;
  const { ciphertext, nonce } = encryptJSON(payload, sharedKey);
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

// Voice notes: same encrypt-then-store pattern as photos, capped client-side
// to keep the encrypted doc comfortably under Firestore's 1MB limit.
export async function sendThreadVoice(roomId, sharedKey, base64Audio, durationSeconds) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON(
    { type: 'voice', audio: base64Audio, audioDuration: durationSeconds },
    sharedKey
  );
  await addDoc(col(roomId, 'thread'), {
    senderUid: user.uid,
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
  await recordActivity(roomId);
}

// Memory pinning: copies the message's content into its own collection so it
// survives independently of the original (which may later be deleted).
export async function pinMessageAsMemory(roomId, sharedKey, message) {
  const { ciphertext, nonce } = encryptJSON(
    {
      type: message.type,
      text: message.text,
      image: message.image,
      audio: message.audio,
      audioDuration: message.audioDuration,
      originalSenderUid: message.senderUid,
    },
    sharedKey
  );
  await addDoc(col(roomId, 'memories'), {
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
}

export async function deleteMemory(roomId, memoryId) {
  await deleteDoc(doc(db, 'rooms', roomId, 'memories', memoryId));
}

export function listenMemories(roomId, sharedKey, onMemories) {
  const q = query(col(roomId, 'memories'), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    const memories = snap.docs.map((d) => {
      const data = d.data();
      let parsed = { type: 'text', text: '⚠️ Could not decrypt' };
      try {
        parsed = decryptJSON(data.ciphertext, data.nonce, sharedKey);
      } catch (e) {
        /* skip */
      }
      return {
        id: d.id,
        type: parsed.type,
        text: parsed.text,
        image: parsed.image,
        audio: parsed.audio,
        audioDuration: parsed.audioDuration,
        originalSenderUid: parsed.originalSenderUid,
        createdAt: data.createdAt?.toDate?.() || new Date(),
      };
    });
    onMemories(memories);
  });
}

// Reactions live in their own encrypted field on the message doc, so adding one
// never re-encrypts (or risks clobbering) the message body itself.
export async function setReaction(roomId, sharedKey, messageId, reactions) {
  const { ciphertext, nonce } = encryptJSON(reactions || {}, sharedKey);
  await updateDoc(doc(db, 'rooms', roomId, 'thread', messageId), {
    rxCipher: ciphertext,
    rxNonce: nonce,
  });
}

function decodeMessageDoc(d, sharedKey) {
  const data = d.data();
  let parsed = { type: 'text', text: '⚠️ Could not decrypt' };
  try {
    parsed = decryptJSON(data.ciphertext, data.nonce, sharedKey);
  } catch (e) {
    /* leave fallback text */
  }
  let reactions = {};
  if (data.rxCipher && data.rxNonce) {
    try {
      reactions = decryptJSON(data.rxCipher, data.rxNonce, sharedKey) || {};
    } catch (e) {
      /* ignore an unreadable reaction — never break the message */
    }
  }
  return {
    id: d.id,
    senderUid: data.senderUid,
    type: parsed.type || 'text',
    text: parsed.text,
    image: parsed.image,
    audio: parsed.audio,
    audioDuration: parsed.audioDuration,
    viewOnce: parsed.viewOnce,
    replyTo: parsed.replyTo || null,
    reactions,
    pending: d.metadata?.hasPendingWrites,
    createdAt: data.createdAt?.toDate?.() || new Date(),
  };
}

// Paginated: pulls only the newest `max` messages, so a long history never
// drags a whole year of base64 photos onto an old phone. The query runs
// descending (that's what `limit` anchors to) and is flipped back for display.
// `reachedStart` tells the UI whether an "earlier messages" button is needed.
export function listenThread(roomId, sharedKey, onMessages, max = 60) {
  const q = query(col(roomId, 'thread'), orderBy('createdAt', 'desc'), fbLimit(max));
  return onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    const messages = snap.docs.map((d) => decodeMessageDoc(d, sharedKey)).reverse();
    onMessages(messages, { reachedStart: snap.docs.length < max });
  });
}

// Cheap listener for notifications: only ever pulls the single newest message,
// so it can stay subscribed app-wide without dragging the whole history around.
export function listenLatestMessage(roomId, sharedKey, onMessage) {
  const q = query(col(roomId, 'thread'), orderBy('createdAt', 'desc'), fbLimit(1));
  return onSnapshot(q, (snap) => {
    if (snap.empty) return onMessage(null);
    onMessage(decodeMessageDoc(snap.docs[0], sharedKey));
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

export function listenPhotos(roomId, sharedKey, onPhotos, max = 14) {
  // Cap the query itself so a growing photo history never pulls every base64
  // image down onto a low-RAM device — only the most recent `max` load.
  const q = query(col(roomId, 'photos'), orderBy('createdAt', 'desc'), fbLimit(max));
  return onSnapshot(q, (snap) => {
    const photos = snap.docs.map((d) => {
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
export const EXPENSE_CATEGORIES = ['General', 'Travel', 'Gifts', 'Food', 'Calls', 'Bills', 'Other'];

export async function addExpense(roomId, sharedKey, { description, amount, paidBy, category }) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON(
    { description, amount, paidBy: paidBy || user.uid, category: category || 'General' },
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
        amount: Number(parsed.amount) || 0,
        paidBy: parsed.paidBy,
        // Entries written before categories existed simply fall back to General.
        category: parsed.category || 'General',
        createdAt: data.createdAt?.toDate?.() || new Date(),
      };
    });
    onExpenses(expenses);
  });
}

// ---------- Savings tracker (several goals at once, e.g. a flight AND a ring) ----------
// Each goal is its own encrypted doc; contributions carry the goal's id so they
// can be totalled per goal. Contributions saved before multi-goal existed have
// no goalId and are grouped under "Unassigned" rather than being lost.
export async function addSavingsGoal(roomId, sharedKey, { label, target }) {
  const { ciphertext, nonce } = encryptJSON({ label, target: Number(target) || 0 }, sharedKey);
  const ref = await addDoc(col(roomId, 'savingsGoals'), {
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateSavingsGoal(roomId, sharedKey, goalId, { label, target }) {
  const { ciphertext, nonce } = encryptJSON({ label, target: Number(target) || 0 }, sharedKey);
  await updateDoc(doc(db, 'rooms', roomId, 'savingsGoals', goalId), { ciphertext, nonce });
}

export async function deleteSavingsGoal(roomId, goalId) {
  await deleteDoc(doc(db, 'rooms', roomId, 'savingsGoals', goalId));
}

export function listenSavingsGoals(roomId, sharedKey, onGoals) {
  const q = query(col(roomId, 'savingsGoals'), orderBy('createdAt', 'asc'));
  return onSnapshot(q, (snap) => {
    onGoals(
      snap.docs.map((d) => {
        const data = d.data();
        let parsed = { label: '⚠️ Could not decrypt', target: 0 };
        try {
          parsed = decryptJSON(data.ciphertext, data.nonce, sharedKey);
        } catch (e) {
          /* skip */
        }
        return { id: d.id, label: parsed.label, target: Number(parsed.target) || 0 };
      })
    );
  });
}

export async function addSavingsEntry(roomId, sharedKey, { label, amount, goalId }) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON(
    { label, amount, contributedBy: user.uid, goalId: goalId || null },
    sharedKey
  );
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
        amount: Number(parsed.amount) || 0,
        contributedBy: parsed.contributedBy,
        goalId: parsed.goalId || null,
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

// ---------- Letters (write now, unlocks on a future date) ----------
// Note: the "locked until" gate is enforced by the client's own UI, not by
// cryptographic time-lock (that's a genuinely different, much heavier
// primitive). The content is always properly encrypted; the date is an
// honor-system reveal between the two of you, same as the rest of the app.
export async function addLetter(roomId, sharedKey, { text, unlockAt }) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON({ text }, sharedKey);
  await addDoc(col(roomId, 'letters'), {
    senderUid: user.uid,
    unlockAt,
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
}

export async function deleteLetter(roomId, letterId) {
  await deleteDoc(doc(db, 'rooms', roomId, 'letters', letterId));
}

export function listenLetters(roomId, sharedKey, onLetters) {
  const q = query(col(roomId, 'letters'), orderBy('unlockAt', 'asc'));
  return onSnapshot(q, (snap) => {
    const letters = snap.docs.map((d) => {
      const data = d.data();
      const unlocked = new Date(data.unlockAt).getTime() <= Date.now();
      let text = null;
      if (unlocked) {
        try {
          text = decryptJSON(data.ciphertext, data.nonce, sharedKey).text;
        } catch (e) {
          text = '⚠️ Could not decrypt';
        }
      }
      return {
        id: d.id,
        senderUid: data.senderUid,
        unlockAt: data.unlockAt,
        unlocked,
        text,
      };
    });
    onLetters(letters);
  });
}

// ---------- Nudges ----------
// A one-tap "I'm thinking about you" that needs no words. The nudge kind is
// encrypted like everything else; only the timestamp and sender are plaintext.
export const NUDGES = [
  { id: 'thinking', emoji: '💭', label: 'Thinking of you' },
  { id: 'miss', emoji: '🤍', label: 'Miss you' },
  { id: 'call', emoji: '📞', label: 'Call me?' },
  { id: 'goodnight', emoji: '🌙', label: 'Goodnight' },
];

export function nudgeById(id) {
  return NUDGES.find((n) => n.id === id) || NUDGES[0];
}

export async function sendNudge(roomId, sharedKey, nudgeId) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON({ nudgeId }, sharedKey);
  await addDoc(col(roomId, 'nudges'), {
    senderUid: user.uid,
    ciphertext,
    nonce,
    createdAt: serverTimestamp(),
  });
  await recordActivity(roomId);
}

export function listenLatestNudge(roomId, sharedKey, onNudge) {
  const q = query(col(roomId, 'nudges'), orderBy('createdAt', 'desc'), fbLimit(1));
  return onSnapshot(q, (snap) => {
    if (snap.empty) return onNudge(null);
    const d = snap.docs[0];
    const data = d.data();
    let nudgeId = 'thinking';
    try {
      nudgeId = decryptJSON(data.ciphertext, data.nonce, sharedKey).nudgeId || 'thinking';
    } catch (e) {
      /* fall back to the default kind rather than dropping the nudge */
    }
    onNudge({
      id: d.id,
      senderUid: data.senderUid,
      nudgeId,
      createdAt: data.createdAt?.toDate?.() || new Date(),
    });
  });
}

// ---------- Archive export ----------
// Reads every collection once and decrypts it in memory. The caller is
// responsible for re-encrypting under a passphrase before anything is written
// to disk — plaintext must never reach a file the user could sync somewhere.
export async function buildRoomArchive(roomId, sharedKey) {
  const plainOf = (d) => {
    const data = d.data();
    try {
      return { id: d.id, ...decryptJSON(data.ciphertext, data.nonce, sharedKey) };
    } catch (e) {
      return { id: d.id, undecryptable: true };
    }
  };
  const grab = async (name, extra = () => ({})) => {
    try {
      const snap = await getDocs(col(roomId, name));
      return snap.docs.map((d) => ({ ...plainOf(d), ...extra(d) }));
    } catch (e) {
      return [];
    }
  };
  const withMeta = (d) => {
    const data = d.data();
    return {
      senderUid: data.senderUid || null,
      createdAt: data.createdAt?.toDate?.().toISOString() || null,
    };
  };

  const [thread, journal, letters, memories, bucketlist, calendar, expenses, savings, savingsGoals, mood] =
    await Promise.all([
      grab('thread', withMeta),
      grab('journal', withMeta),
      grab('letters', withMeta),
      grab('memories', withMeta),
      grab('bucketlist'),
      grab('calendar'),
      grab('expenses', withMeta),
      grab('savings', withMeta),
      grab('savingsGoals'),
      grab('mood', withMeta),
    ]);

  return {
    format: 'tidelight-archive',
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: {
      messages: thread.length, journal: journal.length, letters: letters.length,
      memories: memories.length, list: bucketlist.length, events: calendar.length,
      expenses: expenses.length, savings: savings.length, goals: savingsGoals.length,
    },
    thread, journal, letters, memories, bucketlist, calendar, expenses, savings, savingsGoals, mood,
  };
}

// ---------- Profile pictures ----------
// Stored per-uid so each person only ever writes their own; both are readable
// by both members under the same room rules as everything else.
export async function setMyAvatar(roomId, sharedKey, base64Image) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON({ avatar: base64Image }, sharedKey);
  await setDoc(doc(db, 'rooms', roomId, 'profiles', user.uid), { ciphertext, nonce });
}

export function listenProfiles(roomId, sharedKey, memberUids, onProfiles) {
  const unsubs = memberUids.map((uid) =>
    onSnapshot(doc(db, 'rooms', roomId, 'profiles', uid), (snap) => {
      const data = snap.data();
      let avatar = null;
      if (data) {
        try {
          avatar = decryptJSON(data.ciphertext, data.nonce, sharedKey).avatar;
        } catch (e) {
          /* skip */
        }
      }
      onProfiles(uid, avatar);
    })
  );
  return () => unsubs.forEach((u) => u());
}
