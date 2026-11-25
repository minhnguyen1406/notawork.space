import { expect, test } from 'vitest';
import { Chess } from 'chess.js';
import { bestMove } from '../tools/chess-engine.mjs';

test('finds mate in one', () => {
  // White: Qh5, Bc4 against f7 (scholar's mate).
  const m = bestMove('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', { ms: 1500 });
  expect(m.san).toBe('Qxf7#');
});

test('takes a queen left hanging', () => {
  const m = bestMove('rnb1kbnr/pppp1ppp/8/4p3/4P2q/2N5/PPPP1PPP/R1BQKBNR w KQkq - 0 1'.replace('4P2q', '4P1q1'), { ms: 1500 });
  // The black queen on g4 can simply be taken by the white queen on d1.
  expect(m.san).toBe('Qxg4');
});

test('does not hang its own queen to a pawn', () => {
  const m = bestMove('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', { ms: 1200 });
  const after = new Chess('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  after.move({ from: m.from, to: m.to, promotion: 'q' });
  // Whatever it played, Black must not be able to win the queen for nothing next move.
  const losesQueen = after.moves({ verbose: true }).some((r) => r.captured === 'q' && r.piece === 'p');
  expect(losesQueen).toBe(false);
});

test('returns null when there is no move, and always a legal move otherwise', () => {
  expect(bestMove('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'.replace('5Q2', '6Q1'), { ms: 300 })).toBeNull(); // checkmated
  const chess = new Chess();
  for (let i = 0; i < 12; i++) {
    const m = bestMove(chess.fen(), { ms: 150, maxDepth: 2 });
    expect(() => chess.move({ from: m.from, to: m.to, promotion: 'q' })).not.toThrow();
  }
}, 20_000);

test('keeps to its thinking time', () => {
  const started = Date.now();
  bestMove('r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9', { ms: 400, maxDepth: 6 });
  expect(Date.now() - started).toBeLessThan(900);
});
