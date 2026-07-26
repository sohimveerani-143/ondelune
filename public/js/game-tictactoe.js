// game-tictactoe.js — deliberately simple and turn-based (not real-time twitch),
// which fits how an LDR app actually gets used, and stays light on older devices.
import { db, ensureSignedIn, doc, setDoc, onSnapshot } from './firebase.js';
import { encryptJSON, decryptJSON } from './crypto.js';
import { recordActivity } from './streak.js';

const EMPTY_BOARD = Array(9).fill(null);
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function checkWinner(board) {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return board.every(Boolean) ? 'draw' : null;
}

export function listenGame(roomId, sharedKey, onState) {
  return onSnapshot(doc(db, 'rooms', roomId, 'game', 'tictactoe'), (snap) => {
    const data = snap.data();
    if (!data) return onState(null);
    try {
      onState(decryptJSON(data.ciphertext, data.nonce, sharedKey));
    } catch (e) {
      onState(null);
    }
  });
}

export async function startNewGame(roomId, sharedKey, memberUids) {
  const [uidA, uidB] = [...memberUids].sort();
  const state = { board: EMPTY_BOARD, turnUid: uidA, xUid: uidA, oUid: uidB, winner: null };
  const { ciphertext, nonce } = encryptJSON(state, sharedKey);
  await setDoc(doc(db, 'rooms', roomId, 'game', 'tictactoe'), { ciphertext, nonce });
}

export async function makeMove(roomId, sharedKey, currentState, cellIndex) {
  const user = await ensureSignedIn();
  if (!currentState || currentState.winner) return;
  if (currentState.turnUid !== user.uid) return;
  if (currentState.board[cellIndex]) return;

  const mark = user.uid === currentState.xUid ? 'X' : 'O';
  const board = [...currentState.board];
  board[cellIndex] = mark;
  const winner = checkWinner(board);
  const nextTurnUid = currentState.turnUid === currentState.xUid ? currentState.oUid : currentState.xUid;

  const nextState = {
    ...currentState,
    board,
    winner,
    turnUid: winner ? currentState.turnUid : nextTurnUid,
  };
  const { ciphertext, nonce } = encryptJSON(nextState, sharedKey);
  await setDoc(doc(db, 'rooms', roomId, 'game', 'tictactoe'), { ciphertext, nonce });
  await recordActivity(roomId);
}
