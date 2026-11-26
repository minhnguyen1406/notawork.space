// Randomised simulation of the chess table. chess.js holds the position; this file rebuilds the
// server's wrapper around it (worker/src/tables.ts: seats, turns, "new game", moves sent on behalf
// of the built-in opponent, queen-only promotion, the status in the view) and plays thousands of
// whole games through it, mixing legal play with everything a browser could send. Checked after
// every step. A failure prints the seed; replay it with
//   SIM_SEED=<seed> SIM_RUNS=1 npx vitest run tests/sim/chess.sim.test.ts
import { Chess, type Square } from 'chess.js';
import { expect, test } from 'vitest';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(ENV.SIM_RUNS) || 150;
const SEED = Number(ENV.SIM_SEED) || 1;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

type Side = 'w' | 'b';
type Status = 'playing' | 'checkmate' | 'stalemate' | 'draw';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** The chess part of worker/src/tables.ts, without the chat. Keep in step with chessAction and chessView. */
class Table {
  chess = new Chess();
  last: { from: string; to: string } | null = null;
  /** The side the built-in opponent plays, if it is sitting at the board. */
  constructor(readonly bot: Side | null) {}

  status(): Status {
    const c = this.chess;
    return c.isCheckmate() ? 'checkmate' : c.isStalemate() ? 'stalemate' : c.isDraw() ? 'draw' : 'playing';
  }

  /** `side` is the seat of the person sending (null for someone watching). Returns true if the board was refreshed. */
  action(side: Side | null, a: unknown): boolean {
    if (!a || typeof a !== 'object') return false;
    const act = a as Record<string, unknown>;
    if (!side) return false; // watchers can't touch the board
    const bot = this.bot;
    if (act.k === 'new') {
      this.chess = new Chess();
      this.last = null;
    } else if ((act.k === 'move' || act.k === 'bot') && typeof act.from === 'string' && typeof act.to === 'string') {
      const mover = act.k === 'bot' ? bot : side;
      if (!mover || (act.k === 'bot' && bot === side)) return false;
      if (this.chess.turn() !== mover || this.chess.isGameOver()) return false;
      try {
        this.chess.move({ from: act.from, to: act.to, promotion: 'q' });
      } catch {
        return false; // not a legal move
      }
      this.last = { from: act.from, to: act.to };
    } else {
      return false;
    }
    return true;
  }
}

const FILES = 'abcdefgh';
const GARBAGE: unknown[] = ['', 'e9', 'i1', 'e2e4', 'E2', ' e2', 'a1 ', 'O-O', 'Nf3', 'toString', '__proto__', '♔', 'a'.repeat(5000), 0, 12, NaN, null, undefined, {}, [], ['e2'], true];

interface Stats {
  games: number;
  plies: number;
  refused: number;
  checkmate: number;
  stalemate: number;
  draw: number;
  drawStillMovable: number;
  promotions: number;
  castles: number;
  enPassant: number;
  botMoves: number;
  newGames: number;
  longest: number;
}

function playGame(seed: number, stats: Stats, trace: string[]) {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(list: T[]) => list[int(list.length)];
  const square = () => FILES[int(8)] + (1 + int(8));

  const bot: Side | null = pick([null, null, 'w', 'b']);
  const t = new Table(bot);
  /** Kept in step by standard notation, to learn each move's squares and to cross-check the position. */
  let shadow = new Chess();
  const humans: Side[] = bot ? [bot === 'w' ? 'b' : 'w'] : ['w', 'b'];
  check(t.chess.fen() === START_FEN && t.status() === 'playing', 'bad opening position');
  // How keen the players are to finish: grabbing mates and captures makes for shorter, sharper games.
  const sharp = pick([0, 0.3, 0.7, 0.95]);
  let plies = 0;
  let restarts = 0;

  /** Send one action and check the answer against what the rules of the table say. */
  const send = (side: Side | null, a: unknown, expectOk: boolean | null) => {
    const fen = t.chess.fen(); // the FEN carries the move counters, so any move at all would change it
    const lastBefore = JSON.stringify(t.last);
    const ok = t.action(side, a);
    if (expectOk !== null) check(ok === expectOk, `${JSON.stringify(a)?.slice(0, 80)} from seat ${side} was ${ok ? 'accepted' : 'refused'}`);
    if (!ok) {
      stats.refused++;
      check(t.chess.fen() === fen && JSON.stringify(t.last) === lastBefore, 'a refused action changed the position');
    }
    return ok;
  };

  for (let step = 0; ; step++) {
    check(step < 60_000 && plies < 12_000, 'the game did not end');
    const c = t.chess;
    const turn = c.turn();
    const over = c.isGameOver();
    const status = t.status();
    check(over === (status !== 'playing'), `isGameOver is ${over} but the view says ${status}`);
    if (over) break;
    check(c.fen() === shadow.fen(), 'the table and the reference position have drifted apart');

    const r = rnd();
    if (r < 0.8) {
      // The side to move plays a legal move (never an under-promotion: the table cannot ask for one).
      const sans = c.moves().filter((m) => !/=[RBN]/.test(m));
      check(sans.length > 0, 'no legal move, but the game is not over');
      const mates = sans.filter((m) => m.endsWith('#'));
      const sharpMoves = sans.filter((m) => m.includes('x') || m.includes('='));
      const san = mates.length && rnd() < sharp ? pick(mates) : sharpMoves.length && rnd() < sharp ? pick(sharpMoves) : pick(sans);
      const mv = shadow.move(san);
      trace.push(`${plies}: ${san}`);
      if (trace.length > 16) trace.shift();
      const fenBefore = c.fen();
      // If it is the built-in opponent's turn, the person playing against it sends the move for it.
      const viaBot = bot === turn;
      const sender: Side = viaBot ? humans[0] : turn;
      const extra = rnd() < 0.1 ? { promotion: pick(['n', 'r', 'b', 'k', 7]) } : {}; // the table ignores this
      check(send(sender, { k: viaBot ? 'bot' : 'move', from: mv.from, to: mv.to, ...extra }, true), 'a legal move was refused');
      plies++;
      stats.plies++;
      if (viaBot) stats.botMoves++;
      check(t.chess.fen() !== fenBefore && t.chess.turn() !== turn, 'an accepted move did not change the position or pass the turn');
      check(t.chess.fen() === shadow.fen(), `after ${san} the table has ${t.chess.fen()} but the move gives ${shadow.fen()}`);
      check(t.last?.from === mv.from && t.last?.to === mv.to, 'the last move shown is wrong');
      if (mv.promotion) {
        const piece = t.chess.get(mv.to);
        check(mv.promotion === 'q' && piece?.type === 'q' && piece.color === turn, `a pawn reached the last rank and became ${JSON.stringify(piece)}`);
        stats.promotions++;
      } else if (mv.piece === 'p') {
        check(!/[18]$/.test(mv.to), 'a pawn reached the last rank without promoting');
      }
      if (mv.isKingsideCastle() || mv.isQueensideCastle()) stats.castles++;
      if (mv.isEnPassant()) stats.enPassant++;

      // The position survives a trip through its FEN (which is what browsers are sent).
      const fen = t.chess.fen();
      const copy = new Chess(fen);
      check(copy.fen() === fen, `FEN does not round-trip: ${fen} -> ${copy.fen()}`);
      if (rnd() < 0.1) {
        check(copy.moves().sort().join() === t.chess.moves().sort().join(), `the position rebuilt from ${fen} has different legal moves`);
        check(copy.isCheckmate() === t.chess.isCheckmate() && copy.isStalemate() === t.chess.isStalemate() && copy.isCheck() === t.chess.isCheck(), 'the rebuilt position disagrees about check');
      }
      continue;
    }

    // Everything else a browser could send. None of it may move a piece unless it happens to be a
    // legal move by the right person.
    const kind = int(9);
    const legalFrom = (from: string, to: string) => {
      try {
        return c.moves({ verbose: true, square: from as Square }).some((m) => m.to === to);
      } catch {
        return false;
      }
    };
    const anyLegal = () => {
      const m = shadow.move(pick(c.moves().filter((x) => !/=[RBN]/.test(x))));
      shadow.undo();
      return { from: m.from, to: m.to };
    };
    if (kind === 0) {
      // Someone watching tries a perfectly good move, or to start a new game.
      send(null, rnd() < 0.7 ? { k: 'move', ...anyLegal() } : { k: 'new' }, false);
    } else if (kind === 1) {
      // The player whose turn it is not tries to move the other side's pieces.
      const other: Side = turn === 'w' ? 'b' : 'w';
      if (humans.includes(other)) send(other, { k: 'move', ...anyLegal() }, false);
    } else if (kind === 2) {
      // A move "for the built-in opponent" when there is none, or when it is not its turn.
      if (!bot || bot !== turn) send(pick(humans), { k: 'bot', ...anyLegal() }, false);
    } else if (kind === 3) {
      // Random squares: refused unless that happens to be legal for the person whose turn it is.
      const from = square();
      const to = rnd() < 0.1 ? from : square();
      const sender = bot === turn ? null : turn;
      if (sender) {
        const legal = legalFrom(from, to);
        if (send(sender, { k: 'move', from, to }, legal)) {
          // It was a real move after all: keep the reference in step (always promoting to a queen).
          const piece = t.chess.get(to as Square);
          const played = shadow.move({ from, to, promotion: 'q' });
          check(shadow.fen() === t.chess.fen(), 'an accepted move is not the move that was asked for');
          if (/[18]$/.test(to) && played.piece === 'p') check(piece?.type === 'q', 'a pawn promoted to something other than a queen');
          plies++;
          stats.plies++;
        }
      }
    } else if (kind === 4) {
      // Garbage where the squares should be.
      const sender = pick([...humans, null]);
      send(sender, { k: pick(['move', 'bot']), from: rnd() < 0.5 ? pick(GARBAGE) : square(), to: pick(GARBAGE) }, false);
    } else if (kind === 5) {
      // Not an action at all.
      send(pick([...humans, null]), pick([null, undefined, 0, 'move', [], {}, { k: 'MOVE', from: 'e2', to: 'e4' }, { k: 'resign' }, { from: 'e2', to: 'e4' }, { k: 'move' }, { k: 'move', from: 'e2' }]), false);
    } else if (kind === 6) {
      // An illegal move straight at chess.js, the way the server calls it: it must throw and change nothing.
      const fen = c.fen();
      const from = square();
      const to = square();
      if (!legalFrom(from, to)) {
        let threw = false;
        try {
          c.move({ from, to, promotion: 'q' });
        } catch {
          threw = true;
        }
        check(threw && c.fen() === fen, `chess.js took the illegal move ${from}${to} or changed the position`);
      }
    } else if (kind === 7 && restarts < 2 && rnd() < 0.05) {
      // A seated player presses "New game" in the middle of a game.
      check(send(pick(humans), { k: 'new' }, true), '"New game" was refused');
      check(t.chess.fen() === START_FEN && t.last === null && t.status() === 'playing' && t.chess.history().length === 0, '"New game" did not reset the board');
      shadow = new Chess();
      restarts++;
      stats.newGames++;
    }
  }

  // The game is over, with a status the view knows about.
  const status = t.status();
  check(status === 'checkmate' || status === 'stalemate' || status === 'draw', `the game ended as ${status}`);
  stats[status]++;
  stats.longest = Math.max(stats.longest, plies);
  const c = t.chess;
  if (status === 'checkmate') check(c.isCheck() && c.moves().length === 0, 'checkmate, but the king is not in check or can move');
  if (status === 'stalemate') check(!c.isCheck() && c.moves().length === 0, 'stalemate, but there is a check or a legal move');
  if (status === 'draw') {
    check(c.isDrawByFiftyMoves() || c.isInsufficientMaterial() || c.isThreefoldRepetition(), 'a draw for no reason');
    // chess.js itself would still let play go on here; the table must not.
    const sans = c.moves();
    if (sans.length) {
      stats.drawStillMovable++;
      const m = shadow.move(sans[0]);
      for (const side of [...humans, null]) {
        send(side, { k: 'move', from: m.from, to: m.to }, false);
        send(side, { k: 'bot', from: m.from, to: m.to }, false);
      }
    }
  }
  const finalFen = c.fen();
  for (let i = 0; i < 5; i++) send(pick([...humans, null]), { k: pick(['move', 'bot']), from: square(), to: square() }, false);
  check(c.fen() === finalFen && new Chess(finalFen).fen() === finalFen, 'the finished game changed');
  // Only a seated player can clear the board for another game.
  send(null, { k: 'new' }, false);
  check(send(pick(humans), { k: 'new' }, true) && t.chess.fen() === START_FEN && t.last === null && t.status() === 'playing', '"New game" did not work after the end');
  stats.games++;
}

test(`chess: ${RUNS} random games through the table hold every invariant`, { timeout: 3_600_000 }, () => {
  const stats: Stats = {
    games: 0,
    plies: 0,
    refused: 0,
    checkmate: 0,
    stalemate: 0,
    draw: 0,
    drawStillMovable: 0,
    promotions: 0,
    castles: 0,
    enPassant: 0,
    botMoves: 0,
    newGames: 0,
    longest: 0,
  };
  const t0 = Date.now();
  for (let i = 0; i < RUNS; i++) {
    const seed = SEED + i;
    const trace: string[] = [];
    try {
      playGame(seed, stats, trace);
    } catch (e) {
      throw new Error(`chess sim failed with seed=${seed} (replay: SIM_SEED=${seed} SIM_RUNS=1): ${(e as Error).message}\nlast moves:\n${trace.join(' ')}`);
    }
  }
  console.log(`chess sim: ${JSON.stringify(stats)} in ${Date.now() - t0} ms (first seed ${SEED})`);
  expect(stats.games).toBe(RUNS);
  if (RUNS >= 200) expect(Math.min(stats.checkmate, stats.draw, stats.promotions, stats.castles, stats.botMoves, stats.refused)).toBeGreaterThan(0);
});
