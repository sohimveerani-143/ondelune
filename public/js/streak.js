// streak.js — a "talking streak": counts consecutive days where BOTH partners did
// something real (sent a message, logged a mood, added a photo/event/list item).
// Merely opening the app never counts — recordActivity() is only called from
// inside the actual write functions in room-data.js.
import { db, ensureSignedIn, doc, setDoc, onSnapshot, collection, query, orderBy, limit } from './firebase.js';

function todayUTC(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Deliberately swallows its own errors. This is a side effect of sending, not
// part of sending: if the streak write fails, the message itself has already
// been stored, and letting this throw would report a successful send as failed.
export async function recordActivity(roomId) {
  try {
    const user = await ensureSignedIn();
    const date = todayUTC();
    const id = `${date}_${user.uid}`;
    await setDoc(doc(db, 'rooms', roomId, 'activity', id), {
      uid: user.uid,
      date,
      updatedAt: Date.now(),
    });
  } catch (e) {
    console.warn('Streak activity not recorded:', e?.code || e?.message || e);
  }
}

// memberUids: the room's two uids (order doesn't matter here).
export function listenStreak(roomId, memberUids, onStreak) {
  const q = query(collection(db, 'rooms', roomId, 'activity'), orderBy('date', 'desc'), limit(160));
  return onSnapshot(q, (snap) => {
    const [uidA, uidB] = memberUids;
    const datesA = new Set();
    const datesB = new Set();
    snap.docs.forEach((d) => {
      const data = d.data();
      if (data.uid === uidA) datesA.add(data.date);
      else if (data.uid === uidB) datesB.add(data.date);
    });

    const bothActive = (dateStr) => datesA.has(dateStr) && datesB.has(dateStr);

    let streak = 0;
    let offset = bothActive(todayUTC()) ? 0 : -1; // don't zero out the streak right at midnight
    while (bothActive(todayUTC(offset))) {
      streak += 1;
      offset -= 1;
    }
    onStreak(streak);
  });
}
