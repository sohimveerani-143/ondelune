// game-tictactoe.js — deliberately simple and turn-based (not real-time twitch),
// which fits how an LDR app actually gets used, and stays light on older devices.
//
// The whole board state is one encrypted doc. Firestore only ever sees
// {ciphertext, nonce} plus a plaintext `updatedAt` used to detect staleness.
import { db, ensureSignedIn, doc, setDoc, getDoc, deleteDoc, onSnapshot } from './firebase.js';
import { encryptJSON, decryptJSON } from './crypto.js';
import { recordActivity } from './streak.js';

const EMPTY_BOARD = Array(9).fill(null);
export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function checkWinner(board) {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { mark: board[a], line };
    }
  }
  return board.every(Boolean) ? { mark: 'draw', line: null } : null;
}

function gameRef(roomId) {
  return doc(db, 'rooms', roomId, 'game', 'tictactoe');
}

async function writeState(roomId, sharedKey, state) {
  const { ciphertext, nonce } = encryptJSON(state, sharedKey);
  await setDoc(gameRef(roomId), { ciphertext, nonce, updatedAt: Date.now() });
}

export function listenGame(roomId, sharedKey, onState) {
  return onSnapshot(
    gameRef(roomId),
    (snap) => {
      const data = snap.data();
      if (!data) return onState(null);
      try {
        onState(decryptJSON(data.ciphertext, data.nonce, sharedKey));
      } catch (e) {
        onState(null);
      }
    },
    () => onState(null)
  );
}

export async function readGameOnce(roomId, sharedKey) {
  try {
    const snap = await getDoc(gameRef(roomId));
    const data = snap.data();
    if (!data) return null;
    return decryptJSON(data.ciphertext, data.nonce, sharedKey);
  } catch (e) {
    return null;
  }
}

// `startedBy` goes first on the very first game; after that the loser (or the
// player who didn't start last time) leads, which keeps it fair without anyone
// having to think about it.
export async function startNewGame(roomId, sharedKey, memberUids, options = {}) {
  const user = await ensureSignedIn();
  const [uidA, uidB] = [...memberUids].sort();
  const previous = options.previous || null;

  let xUid = uidA;
  if (previous && previous.xUid) {
    xUid = previous.xUid === uidA ? uidB : uidA; // alternate who is X
  } else {
    xUid = user.uid; // whoever opens the first game takes X
  }
  const oUid = xUid === uidA ? uidB : uidA;

  const state = {
    board: EMPTY_BOARD,
    turnUid: xUid,
    xUid,
    oUid,
    winner: null,
    winningLine: null,
    status: 'active',
    endedBy: null,
    endedReason: null,
    round: previous ? (previous.round || 1) + 1 : 1,
    scores: previous?.scores || {},
    startedAt: Date.now(),
  };
  await writeState(roomId, sharedKey, state);
  return state;
}

export async function makeMove(roomId, sharedKey, currentState, cellIndex) {
  const user = await ensureSignedIn();
  if (!currentState || currentState.status !== 'active') return null;
  if (currentState.winner) return null;
  if (currentState.turnUid !== user.uid) return null;
  if (currentState.board[cellIndex]) return null;

  const mark = user.uid === currentState.xUid ? 'X' : 'O';
  const board = [...currentState.board];
  board[cellIndex] = mark;
  const result = checkWinner(board);
  const nextTurnUid = currentState.turnUid === currentState.xUid ? currentState.oUid : currentState.xUid;

  const scores = { ...(currentState.scores || {}) };
  if (result && result.mark !== 'draw') {
    const winnerUid = result.mark === 'X' ? currentState.xUid : currentState.oUid;
    scores[winnerUid] = (scores[winnerUid] || 0) + 1;
  } else if (result && result.mark === 'draw') {
    scores.draws = (scores.draws || 0) + 1;
  }

  const nextState = {
    ...currentState,
    board,
    winner: result ? result.mark : null,
    winningLine: result ? result.line : null,
    turnUid: result ? currentState.turnUid : nextTurnUid,
    status: result ? 'finished' : 'active',
    scores,
  };
  await writeState(roomId, sharedKey, nextState);
  await recordActivity(roomId);
  return nextState;
}

// Explicit "I'm done" — ends the game for BOTH people. The partner's screen
// shows a dismissable notice saying who left, which is why `endedBy` is stored
// rather than just deleting the doc.
export async function leaveGame(roomId, sharedKey, currentState) {
  const user = await ensureSignedIn();
  if (!currentState) return;
  await writeState(roomId, sharedKey, {
    ...currentState,
    status: 'ended',
    endedBy: user.uid,
    endedReason: 'left',
    endedAt: Date.now(),
  });
}

// Clears the board entirely so the next visit starts fresh rather than landing
// on someone's old "game over" screen.
export async function clearGame(roomId) {
  try {
    await deleteDoc(gameRef(roomId));
  } catch (e) {
    /* nothing to clear */
  }
}
