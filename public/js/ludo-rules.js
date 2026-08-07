// ludo-rules.js — the game itself, as pure functions. No Firestore, no DOM, no
// clock. Everything here is a value in, a value out, which is what makes the
// board testable without a second phone and a guest sitting in front of it.
//
// ---- Geometry ----
// A 15×15 grid. The three middle rows and three middle columns form a plus;
// the outer two lanes of each arm carry the 52-square ring, the middle lane is
// that colour's home column, and the centre 3×3 is the finish.
//
// The ring is derived rather than typed out. Four identical 13-square quadrants
// rotated by 90° is what makes the four starts exactly 13 apart, and deriving
// it means that property cannot drift.

const SIZE = 15;

function rotate90(cell) {
  // (r, c) -> (c, SIZE-1-r), i.e. a quarter turn clockwise.
  return [cell[1], SIZE - 1 - cell[0]];
}

function buildRing() {
  // One quadrant, walked clockwise: out along the arm's upper lane, a turn at
  // the inner corner, up the next arm's near lane, then the arm's tip square.
  const quadrant = [
    [6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
    [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],
    [0, 7],
  ];
  const ring = [];
  let block = quadrant;
  for (let q = 0; q < 4; q++) {
    ring.push(...block);
    block = block.map(rotate90);
  }
  return ring;
}

export const RING = buildRing(); // 52 squares
export const SEATS = ['red', 'green', 'yellow', 'blue'];

// Start squares sit one in from each arm's outer edge, which puts them 13
// apart and lands them on the classic board positions.
export const START_INDEX = { red: 1, green: 14, yellow: 27, blue: 40 };

// Safe squares: every start, plus the star square eight on from each start.
// Nothing can be captured while standing on one.
export const SAFE_INDICES = new Set(
  SEATS.flatMap((s) => [START_INDEX[s], (START_INDEX[s] + 8) % 52])
);

// The six squares of a colour's home column, outermost first. Derived from the
// same rotation as the ring so the two can never disagree.
function buildHomeColumns() {
  const columns = {};
  let cells = [
    [7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6],
  ];
  for (const seat of SEATS) {
    columns[seat] = cells;
    cells = cells.map(rotate90);
  }
  return columns;
}
export const HOME_COLUMNS = buildHomeColumns();

// A token's position is a single number, which keeps every rule below to plain
// arithmetic:
//   -1        in the yard
//   0…50      squares travelled on the ring (0 is its own start square)
//   51…56     the six home-column squares
//   57        finished
export const YARD = -1;
export const FINISHED = 57;
const HOME_ENTRY = 51;

export function ringIndexFor(seat, progress) {
  return (START_INDEX[seat] + progress) % 52;
}

// Where a token physically sits, or null while it is still in the yard.
export function cellFor(seat, progress) {
  if (progress === YARD) return null;
  if (progress >= HOME_ENTRY) {
    if (progress >= FINISHED) return [7, 7];
    return HOME_COLUMNS[seat][progress - HOME_ENTRY];
  }
  return RING[ringIndexFor(seat, progress)];
}

export function isSafe(seat, progress) {
  if (progress === YARD || progress >= HOME_ENTRY) return true;
  return SAFE_INDICES.has(ringIndexFor(seat, progress));
}

export function newTokens() {
  return [YARD, YARD, YARD, YARD];
}

// ---- Legal moves ----
// Returns the token indices this seat may move with this roll, each with what
// the move would do — the UI needs the "would capture" flag to highlight, and
// the AI needs it to choose.
export function legalMoves(state, seat, roll) {
  const tokens = state.tokens[seat] || newTokens();
  const moves = [];
  for (let i = 0; i < tokens.length; i++) {
    const from = tokens[i];
    if (from === FINISHED) continue;

    let to;
    if (from === YARD) {
      // Only a six opens the gate.
      if (roll !== 6) continue;
      to = 0;
    } else {
      to = from + roll;
      // Overshooting the finish is not a move; the roll must be exact.
      if (to > FINISHED) continue;
    }

    // A square already holding one of your own tokens is blocked, except the
    // finish, where they all end up together anyway.
    if (to !== FINISHED && tokens.some((t, j) => j !== i && t === to)) continue;

    moves.push({ token: i, from, to, captures: capturesAt(state, seat, to) });
  }
  return moves;
}

// Who would be sent home by landing on `to`. Empty on safe squares and
// anywhere inside a home column, which no other colour can reach.
function capturesAt(state, seat, to) {
  if (to >= HOME_ENTRY || isSafe(seat, to)) return [];
  const target = ringIndexFor(seat, to);
  const hits = [];
  for (const other of SEATS) {
    if (other === seat) continue;
    const theirs = state.tokens[other] || [];
    theirs.forEach((p, idx) => {
      if (p === YARD || p >= HOME_ENTRY) return;
      if (ringIndexFor(other, p) === target) hits.push({ seat: other, token: idx });
    });
  }
  return hits;
}

// ---- Applying a move ----
// Returns a NEW state. The caller is responsible for having checked the move is
// legal — commitMove in ludo.js re-derives it inside the transaction rather
// than trusting anything that arrived over the wire.
export function applyMove(state, seat, tokenIndex, roll) {
  const move = legalMoves(state, seat, roll).find((m) => m.token === tokenIndex);
  if (!move) return null;

  const tokens = {};
  for (const s of SEATS) tokens[s] = [...(state.tokens[s] || newTokens())];
  tokens[seat][tokenIndex] = move.to;
  for (const hit of move.captures) tokens[hit.seat][hit.token] = YARD;

  const finished = tokens[seat].every((t) => t === FINISHED);
  const next = {
    ...state,
    tokens,
    lastMove: { seat, token: tokenIndex, from: move.from, to: move.to, roll, captured: move.captures.length },
    moveCount: (state.moveCount || 0) + 1,
  };

  if (finished) {
    next.winner = seat;
    next.status = 'finished';
    next.turn = null;
    next.roll = null;
    return next;
  }

  // A six, or a capture, earns another roll — otherwise play passes on.
  const rollAgain = roll === 6 || move.captures.length > 0;
  next.roll = null;
  next.turn = rollAgain ? seat : nextSeat(state, seat);
  next.rollsInARow = rollAgain ? (state.rollsInARow || 0) + 1 : 0;

  // Three sixes in a row forfeits the extra turn, the usual house rule that
  // stops one lucky streak running away with the game.
  if (next.rollsInARow >= 3) {
    next.turn = nextSeat(state, seat);
    next.rollsInARow = 0;
  }
  return next;
}

export function nextSeat(state, seat) {
  const order = state.seatOrder || SEATS;
  const i = order.indexOf(seat);
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(i + step) % order.length];
    if (state.seats?.[candidate]?.occupied) return candidate;
  }
  return seat;
}

// A roll with nothing to do with it passes play on immediately. Kept separate
// from applyMove because no token moved and nothing was captured.
export function applyNoMove(state, seat) {
  return {
    ...state,
    roll: null,
    rollsInARow: 0,
    turn: nextSeat(state, seat),
    lastMove: { seat, token: null, roll: state.roll, skipped: true },
    moveCount: (state.moveCount || 0) + 1,
  };
}

// ---- The bot ----
// Ordered preferences rather than a search: Ludo is mostly forced, and a bot
// that plays sensibly and instantly reads better than one that plays perfectly
// after a think. Every branch is a rule a human would recognise.
export function chooseAiMove(state, seat, roll) {
  const moves = legalMoves(state, seat, roll);
  if (moves.length === 0) return null;

  const score = (m) => {
    let s = 0;
    if (m.to === FINISHED) s += 100;                 // get one home
    if (m.captures.length > 0) s += 60;              // send someone back
    if (m.from === YARD) s += 40;                    // more tokens in play
    if (m.to >= HOME_ENTRY) s += 25;                 // safely up the column
    if (isSafe(seat, m.to)) s += 15;                 // land somewhere safe
    if (!isSafe(seat, m.from) && vulnerable(state, seat, m.from)) s += 20; // flee danger
    if (vulnerable(state, seat, m.to)) s -= 25;      // do not walk into it
    s += m.to * 0.4;                                 // all else equal, press on
    return s;
  };

  return moves.reduce((best, m) => (score(m) > score(best) ? m : best), moves[0]);
}

// True if an opponent could reach this square with a single ordinary roll.
function vulnerable(state, seat, progress) {
  if (progress === YARD || progress >= HOME_ENTRY || isSafe(seat, progress)) return false;
  const square = ringIndexFor(seat, progress);
  for (const other of SEATS) {
    if (other === seat || !state.seats?.[other]?.occupied) continue;
    for (const p of state.tokens[other] || []) {
      if (p === YARD || p >= HOME_ENTRY) continue;
      const theirSquare = ringIndexFor(other, p);
      const gap = (square - theirSquare + 52) % 52;
      if (gap >= 1 && gap <= 6) return true;
    }
  }
  return false;
}

export function rollDie() {
  return 1 + Math.floor(Math.random() * 6);
}

export function tokensHome(state, seat) {
  return (state.tokens[seat] || []).filter((t) => t === FINISHED).length;
}
