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
  increment,
} from './firebase.js';
import { encryptJSON, decryptJSON } from './crypto.js';
import { recordActivity } from './streak.js';

function col(roomId, name) {
  return collection(db, 'rooms', roomId, name);
}

// ---------- Unread markers ----------
// A per-section tally of how many things each person has added. This exists so
// the UI can show unread badges by reading ~10 tiny documents, instead of
// downloading every message and photo just to count what's new. Only counts and
// a timestamp are stored — no content, so nothing here needs encrypting.
export const SECTIONS = [
  'thread', 'today', 'calendar', 'list', 'journal',
  'letters', 'memories', 'expenses', 'savings', 'game', 'note',
];

async function bumpMarker(roomId, section) {
  try {
    const user = await ensureSignedIn();
    await setDoc(
      doc(db, 'rooms', roomId, 'markers', section),
      { counts: { [user.uid]: increment(1) }, lastAt: Date.now(), lastBy: user.uid },
      { merge: true }
    );
  } catch (e) {
    // A missed badge must never break the thing the user actually did.
  }
}

export function listenMarkers(roomId, onMarkers) {
  return onSnapshot(
    col(roomId, 'markers'),
    (snap) => {
      const out = {};
      snap.docs.forEach((d) => {
        const data = d.data() || {};
        out[d.id] = { counts: data.counts || {}, lastAt: data.lastAt || 0, lastBy: data.lastBy || null };
      });
      onMarkers(out);
    },
    () => onMarkers({})
  );
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
  await bumpMarker(roomId, 'thread');
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
  await bumpMarker(roomId, 'thread');
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
  await bumpMarker(roomId, 'thread');
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
  await bumpMarker(roomId, 'memories');
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
  await bumpMarker(roomId, 'today');
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
  await bumpMarker(roomId, 'calendar');
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
  await bumpMarker(roomId, 'list');
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
  await bumpMarker(roomId, 'today');
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

// This is a spend LOG, not a split-the-bill ledger. `spentBy` records whose
// spending it was, so either of you can add an entry on the other's behalf
// ("add this for me") — it is deliberately not a debt between you.
// `at` is the moment the money was actually spent, which you can set yourself;
// `createdAt` stays the moment it was logged, and the two are often different.
export async function addExpense(roomId, sharedKey, { description, amount, spentBy, category, at }) {
  const user = await ensureSignedIn();
  const { ciphertext, nonce } = encryptJSON(
    {
      description,
      amount,
      spentBy: spentBy || user.uid,
      category: category || 'General',
      at: at || new Date().toISOString(),
      loggedBy: user.uid,
    },
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
      let parsed = { description: '⚠️ Could not decrypt', amount: 0, spentBy: null };
      try {
        parsed = decryptJSON(data.ciphertext, data.nonce, sharedKey);
      } catch (e) {
        /* skip */
      }
      const createdAt = data.createdAt?.toDate?.() || new Date();
      return {
        id: d.id,
        description: parsed.description,
        amount: Number(parsed.amount) || 0,
        // `paidBy` is the old field name — read it so entries logged before the
        // rename keep showing against the right person.
        spentBy: parsed.spentBy || parsed.paidBy || null,
        loggedBy: parsed.loggedBy || parsed.spentBy || parsed.paidBy || null,
        // Entries written before categories existed simply fall back to General.
        category: parsed.category || 'General',
        at: parsed.at ? new Date(parsed.at) : createdAt,
        createdAt,
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
  await bumpMarker(roomId, 'journal');
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
  await bumpMarker(roomId, 'letters');
}

export async function deleteLetter(roomId, letterId) {
  await deleteDoc(doc(db, 'rooms', roomId, 'letters', letterId));
}

// Whether a letter is unlocked depends on the clock, not on new data — so a
// purely snapshot-driven view would leave a letter sealed past its moment until
// something else happened to write. We re-emit on a timer set to the next
// unlock, so a letter opens the instant it's due even if the screen is just
// sitting there.
export function listenLetters(roomId, sharedKey, onLetters) {
  const q = query(col(roomId, 'letters'), orderBy('unlockAt', 'asc'));
  let docsCache = [];
  let timer = null;

  const emit = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const now = Date.now();
    let nextUnlockAt = Infinity;

    const letters = docsCache.map(({ id, data }) => {
      const at = new Date(data.unlockAt).getTime();
      const unlocked = at <= now;
      if (!unlocked && at < nextUnlockAt) nextUnlockAt = at;
      let text = null;
      if (unlocked) {
        try {
          text = decryptJSON(data.ciphertext, data.nonce, sharedKey).text;
        } catch (e) {
          text = '⚠️ Could not decrypt';
        }
      }
      return { id, senderUid: data.senderUid, unlockAt: data.unlockAt, unlocked, text };
    });
    onLetters(letters);

    if (nextUnlockAt !== Infinity) {
      // setTimeout saturates past ~24.8 days, so cap the wait and re-check.
      const wait = Math.min(nextUnlockAt - now + 250, 6 * 60 * 60 * 1000);
      timer = setTimeout(emit, Math.max(500, wait));
    }
  };

  const unsub = onSnapshot(q, (snap) => {
    docsCache = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    emit();
  });

  return () => {
    if (timer) clearTimeout(timer);
    unsub();
  };
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
  await bumpMarker(roomId, 'note');
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

// ---------- Home note ----------
// A short line you leave on their Home screen. Each person writes only their own
// doc, so there's no contention, and the cap is enforced here as well as in the
// UI so a long note can't slip in another way.
export const NOTE_MAX = 90;

export async function setMyNote(roomId, sharedKey, text) {
  const user = await ensureSignedIn();
  const trimmed = String(text || '').slice(0, NOTE_MAX);
  const { ciphertext, nonce } = encryptJSON({ text: trimmed }, sharedKey);
  await setDoc(doc(db, 'rooms', roomId, 'notes', user.uid), {
    ciphertext,
    nonce,
    updatedAt: Date.now(),
  });
  await bumpMarker(roomId, 'note');
}

export async function clearMyNote(roomId) {
  const user = await ensureSignedIn();
  await deleteDoc(doc(db, 'rooms', roomId, 'notes', user.uid));
}

export function listenNote(roomId, sharedKey, uid, onNote) {
  if (!uid) return () => {};
  return onSnapshot(
    doc(db, 'rooms', roomId, 'notes', uid),
    (snap) => {
      const data = snap.data();
      if (!data) return onNote(null);
      try {
        const parsed = decryptJSON(data.ciphertext, data.nonce, sharedKey);
        onNote({ text: parsed.text || '', updatedAt: data.updatedAt || null });
      } catch (e) {
        onNote(null);
      }
    },
    () => onNote(null)
  );
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
// The profile doc holds several fields (avatar, gender), all inside one
// ciphertext — so every write has to read-modify-write, or setting one field
// would silently wipe the other.
async function readMyProfile(roomId, sharedKey, uid) {
  try {
    const snap = await getDoc(doc(db, 'rooms', roomId, 'profiles', uid));
    const data = snap.data();
    if (!data) return {};
    return decryptJSON(data.ciphertext, data.nonce, sharedKey) || {};
  } catch (e) {
    return {};
  }
}

async function writeMyProfile(roomId, sharedKey, patch) {
  const user = await ensureSignedIn();
  const current = await readMyProfile(roomId, sharedKey, user.uid);
  const { ciphertext, nonce } = encryptJSON({ ...current, ...patch }, sharedKey);
  await setDoc(doc(db, 'rooms', roomId, 'profiles', user.uid), { ciphertext, nonce });
}

export async function setMyAvatar(roomId, sharedKey, base64Image) {
  await writeMyProfile(roomId, sharedKey, { avatar: base64Image });
}

// Shared so the partner's hero scene can draw you the way you describe yourself.
export async function setMyGender(roomId, sharedKey, gender) {
  await writeMyProfile(roomId, sharedKey, { gender });
}

// Calls back with (uid, profile) where profile is { avatar, gender }.
export function listenProfiles(roomId, sharedKey, memberUids, onProfile) {
  const unsubs = memberUids.map((uid) =>
    onSnapshot(doc(db, 'rooms', roomId, 'profiles', uid), (snap) => {
      const data = snap.data();
      let profile = {};
      if (data) {
        try {
          profile = decryptJSON(data.ciphertext, data.nonce, sharedKey) || {};
        } catch (e) {
          /* leave empty rather than breaking the caller */
        }
      }
      onProfile(uid, profile);
    })
  );
  return () => unsubs.forEach((u) => u());
}
