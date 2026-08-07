// ludo.js — the networked half of Ludo. The rules live in ludo-rules.js and
// know nothing about any of this.
//
// Ludo is the one thing in Tidelight that deliberately reaches outside the two
// of you: a seat can be filled by anyone you send a link to. That is why a game
// canNOT live under rooms/{roomId} — a guest is not a member of your room, and
// the security rules that protect everything else would (rightly) refuse them.
//
// So games sit in their own top-level collection, and the privacy story is kept
// intact a different way: the game id is an unguessable 128-bit token, and the
// state is encrypted with a key that travels only in the link's #fragment,
// which browsers never transmit to a server. Firebase stores ciphertext it has
// no key for, exactly as it does for the rest of the app. What a guest can see
// is one Ludo game and nothing else — no room, no messages, no history.
import {
  db,
  ensureSignedIn,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  onSnapshot,
  runTransaction,
  collection,
} from './firebase.js';
import { encryptJSON, decryptJSON, randomToken, randomBoxKeyB64, boxKeyFromB64 } from './crypto.js';
import * as Rules from './ludo-rules.js';

// A seat is "live" if its player checked in recently. Deliberately forgiving:
// phones sleep, tunnels drop, and briefly handing someone's turn to a bot is far
// more annoying than waiting a few extra seconds.
export const HEARTBEAT_MS = 5000;
export const PRESENCE_TIMEOUT_MS = 25000;
// How long a bot appears to think. Long enough to read what happened, short
// enough not to feel like waiting on the network.
export const AI_THINK_MS = 1100;

function gameRef(gameId) {
  return doc(db, 'games', gameId);
}

function presenceRef(gameId, uid) {
  return doc(db, 'games', gameId, 'presence', uid);
}

// ---- Link encoding ----
// base64url, because a raw base64 key carries +, / and = — all of which get
// mangled somewhere between a chat app, a URL bar and a copy-paste.
function toUrlSafe(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromUrlSafe(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return b64 + '='.repeat((4 - (b64.length % 4)) % 4);
}

export function ludoLinkFor(gameId, keyB64) {
  const url = new URL(window.location.href);
  url.hash = `ludo=${gameId}.${toUrlSafe(keyB64)}`;
  return url.toString();
}

export function ludoInviteFromUrl() {
  const match = window.location.hash.match(/ludo=([a-f0-9]+)\.([A-Za-z0-9_-]+)/);
  if (!match) return null;
  return { gameId: match[1], keyB64: fromUrlSafe(match[2]) };
}

// ---- State I/O ----
async function writeState(gameId, key, state) {
  const { ciphertext, nonce } = encryptJSON(state, key);
  await setDoc(gameRef(gameId), { ciphertext, nonce, updatedAt: Date.now() });
}

function readState(snapshot, key) {
  const data = snapshot.data ? snapshot.data() : snapshot;
  if (!data || !data.ciphertext) return null;
  try {
    return decryptJSON(data.ciphertext, data.nonce, key);
  } catch (e) {
    // A wrong key means a truncated link, which is worth saying out loud rather
    // than showing as an empty board.
    return null;
  }
}

export function listenGame(gameId, key, onState, onError) {
  return onSnapshot(
    gameRef(gameId),
    (snap) => onState(snap.exists() ? readState(snap, key) : null),
    (err) => onError && onError(err)
  );
}

// ---- Creating and joining ----
export async function createGame({ hostName }) {
  const user = await ensureSignedIn();
  const gameId = randomToken(16);
  const keyB64 = randomBoxKeyB64();
  const key = boxKeyFromB64(keyB64);

  const state = {
    v: 1,
    hostUid: user.uid,
    status: 'lobby',
    seatOrder: Rules.SEATS,
    seats: {
      red: { occupied: true, kind: 'human', uid: user.uid, name: hostName || 'Host' },
      green: { occupied: false, kind: 'empty' },
      yellow: { occupied: false, kind: 'empty' },
      blue: { occupied: false, kind: 'empty' },
    },
    tokens: {
      red: Rules.newTokens(),
      green: Rules.newTokens(),
      yellow: Rules.newTokens(),
      blue: Rules.newTokens(),
    },
    turn: null,
    roll: null,
    rollsInARow: 0,
    moveCount: 0,
    winner: null,
    createdAt: Date.now(),
  };
  await writeState(gameId, key, state);
  return { gameId, keyB64, key };
}

// Takes the first free seat. Runs in a transaction so two guests opening the
// link at the same moment cannot both land in green.
export async function claimSeat(gameId, key, name) {
  const user = await ensureSignedIn();
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(gameRef(gameId));
    if (!snap.exists()) throw new Error('That game no longer exists.');
    const state = readState(snap, key);
    if (!state) throw new Error('That link is incomplete — ask for it again.');

    // Already seated: rejoining after a reload keeps your seat and your name.
    const mine = Rules.SEATS.find((s) => state.seats[s]?.uid === user.uid);
    if (mine) return { state, seat: mine };

    if (state.status === 'finished') throw new Error('That game has already finished.');

    const free = Rules.SEATS.find((s) => !state.seats[s]?.occupied);
    if (!free) throw new Error('That game is full.');

    const next = {
      ...state,
      seats: {
        ...state.seats,
        [free]: { occupied: true, kind: 'human', uid: user.uid, name: name || 'Guest' },
      },
    };
    const { ciphertext, nonce } = encryptJSON(next, key);
    tx.set(gameRef(gameId), { ciphertext, nonce, updatedAt: Date.now() });
    return { state: next, seat: free };
  });
}

// Host-only, and only in the lobby: park a bot in an empty seat, or clear it out.
export async function setSeatToAi(gameId, key, seat, on) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(gameRef(gameId));
    const state = readState(snap, key);
    if (!state || state.status !== 'lobby') return null;
    if (state.seats[seat]?.kind === 'human') return null;

    const next = {
      ...state,
      seats: {
        ...state.seats,
        [seat]: on
          ? { occupied: true, kind: 'ai', name: aiNameFor(seat) }
          : { occupied: false, kind: 'empty' },
      },
    };
    const { ciphertext, nonce } = encryptJSON(next, key);
    tx.set(gameRef(gameId), { ciphertext, nonce, updatedAt: Date.now() });
    return next;
  });
}

function aiNameFor(seat) {
  return { red: 'Coral', green: 'Fern', yellow: 'Amber', blue: 'Tide' }[seat] || 'Bot';
}

// Two real people is the floor, exactly as asked. A board full of bots with one
// human is solitaire, and the whole point of this is playing with someone.
export function humanSeats(state) {
  return Rules.SEATS.filter((s) => state?.seats?.[s]?.kind === 'human');
}

export function liveHumanSeats(state, presence, now = Date.now()) {
  return humanSeats(state).filter((s) => {
    const at = presence?.[state.seats[s].uid];
    return typeof at === 'number' && now - at < PRESENCE_TIMEOUT_MS;
  });
}

export function canStart(state, presence) {
  const seated = Rules.SEATS.filter((s) => state?.seats?.[s]?.occupied).length;
  return seated >= 2 && liveHumanSeats(state, presence).length >= 2;
}

export async function startGame(gameId, key) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(gameRef(gameId));
    const state = readState(snap, key);
    if (!state || state.status !== 'lobby') return null;
    const first = Rules.SEATS.find((s) => state.seats[s]?.occupied);
    const next = { ...state, status: 'playing', turn: first, roll: null, startedAt: Date.now() };
    const { ciphertext, nonce } = encryptJSON(next, key);
    tx.set(gameRef(gameId), { ciphertext, nonce, updatedAt: Date.now() });
    return next;
  });
}

// ---- Presence ----
export async function heartbeat(gameId) {
  try {
    const user = await ensureSignedIn();
    await setDoc(presenceRef(gameId, user.uid), { at: Date.now() });
  } catch (e) {
    /* a missed beat costs nothing; the next one is five seconds away */
  }
}

export async function clearPresence(gameId) {
  try {
    const user = await ensureSignedIn();
    await deleteDoc(presenceRef(gameId, user.uid));
  } catch (e) {
    /* leaving quietly is fine — the timeout catches it either way */
  }
}

export function listenPresence(gameId, onPresence) {
  return onSnapshot(
    collection(db, 'games', gameId, 'presence'),
    (snap) => {
      const map = {};
      snap.docs.forEach((d) => {
        map[d.id] = d.data()?.at || 0;
      });
      onPresence(map);
    },
    () => onPresence({})
  );
}

// Whether a seat is being played by a person right now. A human seat whose
// player has gone quiet is answered by the bot until they come back — this is
// the single source of truth for that, so the board and the turn engine can
// never disagree about who is playing.
export function seatIsBot(state, seat, presence, now = Date.now()) {
  const info = state?.seats?.[seat];
  if (!info?.occupied) return false;
  if (info.kind === 'ai') return true;
  const at = presence?.[info.uid];
  return !(typeof at === 'number' && now - at < PRESENCE_TIMEOUT_MS);
}

// The name to show, and whether a bot has stepped in for a person — which the
// screen has to say plainly rather than quietly swapping who you are playing.
export function seatLabel(state, seat, presence) {
  const info = state?.seats?.[seat];
  if (!info?.occupied) return { name: 'Empty', bot: false, takenOver: false };
  const bot = seatIsBot(state, seat, presence);
  if (info.kind === 'ai') return { name: info.name || aiNameFor(seat), bot: true, takenOver: false };
  return { name: info.name || 'Player', bot, takenOver: bot };
}

// ---- Turns ----
// Every write goes through a transaction keyed on moveCount. That one guard is
// what makes the whole thing safe without a server: a stale client, a double
// tap, or two people both covering for the same absent player all collide on
// the same counter, and only the first one through wins.
async function commit(gameId, key, expectedMoveCount, mutate) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(gameRef(gameId));
    const state = readState(snap, key);
    if (!state) return null;
    if ((state.moveCount || 0) !== expectedMoveCount) return null; // someone else got there first
    const next = mutate(state);
    if (!next) return null;
    const { ciphertext, nonce } = encryptJSON(next, key);
    tx.set(gameRef(gameId), { ciphertext, nonce, updatedAt: Date.now() });
    return next;
  });
}

export async function rollFor(gameId, key, state, seat) {
  return commit(gameId, key, state.moveCount || 0, (fresh) => {
    if (fresh.status !== 'playing' || fresh.turn !== seat || fresh.roll != null) return null;
    // moveCount deliberately does NOT advance here: a roll is half a turn, and
    // the move that follows is guarded against the same counter.
    return { ...fresh, roll: Rules.rollDie(), rolledAt: Date.now() };
  });
}

export async function moveToken(gameId, key, state, seat, tokenIndex) {
  return commit(gameId, key, state.moveCount || 0, (fresh) => {
    if (fresh.status !== 'playing' || fresh.turn !== seat || fresh.roll == null) return null;
    return Rules.applyMove(fresh, seat, tokenIndex, fresh.roll);
  });
}

export async function passTurn(gameId, key, state, seat) {
  return commit(gameId, key, state.moveCount || 0, (fresh) => {
    if (fresh.status !== 'playing' || fresh.turn !== seat || fresh.roll == null) return null;
    if (Rules.legalMoves(fresh, seat, fresh.roll).length > 0) return null;
    return Rules.applyNoMove(fresh, seat);
  });
}

// A bot's whole turn in one transaction. Any human still watching may run this
// on a bot's behalf — there is no host to depend on, so nobody's game stalls
// because the person who created it closed their phone. Contention is handled
// by the same moveCount guard as everything else.
export async function playBotTurn(gameId, key, state, seat) {
  return commit(gameId, key, state.moveCount || 0, (fresh) => {
    if (fresh.status !== 'playing' || fresh.turn !== seat) return null;
    const roll = fresh.roll != null ? fresh.roll : Rules.rollDie();
    const pick = Rules.chooseAiMove(fresh, seat, roll);
    const withRoll = { ...fresh, roll };
    return pick ? Rules.applyMove(withRoll, seat, pick.token, roll) : Rules.applyNoMove(withRoll, seat);
  });
}

// Ends it for everyone. Kept as a status rather than a delete so the other
// screens can say what happened instead of going blank.
export async function abandonGame(gameId, key, reason) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(gameRef(gameId));
    const state = readState(snap, key);
    // Every client notices the game is short-handed at the same moment, so this
    // has to be safe to call several times over.
    if (!state || state.status === 'finished' || state.status === 'abandoned') return null;
    const next = { ...state, status: 'abandoned', abandonedReason: reason || 'left', turn: null, roll: null };
    const { ciphertext, nonce } = encryptJSON(next, key);
    tx.set(gameRef(gameId), { ciphertext, nonce, updatedAt: Date.now() });
    return next;
  });
}

export async function fetchGameOnce(gameId, key) {
  const snap = await getDoc(gameRef(gameId));
  return snap.exists() ? readState(snap, key) : null;
}
