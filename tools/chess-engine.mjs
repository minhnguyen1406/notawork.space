// A small chess engine for the room's "Claude" character: alpha-beta search over chess.js,
// material plus piece-square tables, captures searched to quiet. Club-beginner strength.
import { Chess } from 'chess.js';

const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Piece-square tables from White's side, rank 8 first. Black reads them mirrored.
const PST = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
};

/** Score from the point of view of the side to move. */
function evaluate(chess) {
  let score = 0;
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) continue;
      const v = VALUE[p.type] + PST[p.type][p.color === 'w' ? r * 8 + f : (7 - r) * 8 + f];
      score += p.color === 'w' ? v : -v;
    }
  }
  return chess.turn() === 'w' ? score : -score;
}

// The room always promotes to a queen, so other promotions aren't options.
const legal = (chess) => chess.moves({ verbose: true }).filter((m) => !m.promotion || m.promotion === 'q');
const order = (m) => (m.captured ? 10 * VALUE[m.captured] - VALUE[m.piece] : 0) + (m.promotion ? 800 : 0);
const sorted = (moves) => moves.sort((a, b) => order(b) - order(a));

const MATE = 100000;
class OutOfTime extends Error {}

/** Pick a move for the side to move. Returns { from, to, san, score, depth } or null if there is none. */
export function bestMove(fen, { ms = 2000, maxDepth = 4 } = {}) {
  const chess = new Chess(fen);
  const deadline = Date.now() + ms;
  let nodes = 0;

  // Checked often: move generation is slow enough that a coarser check overruns the clock badly.
  const tick = () => {
    if ((++nodes & 15) === 0 && Date.now() > deadline) throw new OutOfTime();
  };

  const quiet = (alpha, beta, left) => {
    tick();
    const stand = evaluate(chess);
    if (left === 0 || stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    for (const m of sorted(legal(chess).filter((x) => x.captured))) {
      chess.move(m);
      const score = -quiet(-beta, -alpha, left - 1);
      chess.undo();
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  };

  const search = (depth, alpha, beta, ply) => {
    tick();
    if (chess.isCheckmate()) return -MATE + ply;
    if (chess.isDraw() || chess.isStalemate()) return 0;
    if (depth === 0) return quiet(alpha, beta, 3);
    for (const m of sorted(legal(chess))) {
      chess.move(m);
      const score = -search(depth - 1, -beta, -alpha, ply + 1);
      chess.undo();
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  };

  const root = sorted(legal(chess));
  if (!root.length) return null;
  let best = { move: root[0], score: 0, depth: 0 };
  try {
    for (let depth = 1; depth <= maxDepth; depth++) {
      let top = null;
      let alpha = -Infinity;
      for (const m of root) {
        chess.move(m);
        // A little noise at the root so games don't repeat move for move.
        const score = -search(depth - 1, -Infinity, -alpha + 12, 1) + Math.random() * 8;
        chess.undo();
        if (!top || score > top.score) top = { move: m, score, depth };
        if (score > alpha) alpha = score;
      }
      best = top;
      // Search the best line first next time round.
      root.sort((a, b) => (a === best.move ? -1 : b === best.move ? 1 : 0));
      if (Math.abs(best.score) > MATE - 100) break;
    }
  } catch (err) {
    if (!(err instanceof OutOfTime)) throw err;
    // Out of time mid-search: the stack unwound without undoing, so keep the last finished depth.
  }
  return { from: best.move.from, to: best.move.to, san: best.move.san, score: Math.round(best.score), depth: best.depth };
}
