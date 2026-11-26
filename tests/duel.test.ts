import { expect, test } from 'vitest';
import { HEARTS, MOVES, REVEAL_MS, ROUND_MS, duelForfeit, duelPick, duelTick, duelView, newDuel, roundWinner } from '../shared/duel';

const ann = { id: 'a', name: 'Ann' };
const bao = { id: 'b', name: 'Bao' };
const start = () => newDuel(1, ann, bao, 0);
/** Play one round with these moves, then move on past the reveal. Returns the time afterwards. */
const round = (d: ReturnType<typeof start>, a: string | null, b: string | null, now: number) => {
  if (a) duelPick(d, 'a', a);
  if (b) duelPick(d, 'b', b);
  duelTick(d, now + (a && b ? 1 : ROUND_MS));
  const after = now + ROUND_MS + REVEAL_MS + 1;
  duelTick(d, after);
  return after;
};

test('each move beats exactly one other and loses to the third', () => {
  expect(roundWinner('pillow', 'chicken')).toBe('a');
  expect(roundWinner('chicken', 'umbrella')).toBe('a');
  expect(roundWinner('umbrella', 'pillow')).toBe('a');
  expect(roundWinner('chicken', 'pillow')).toBe('b');
  for (const m of MOVES) expect(roundWinner(m, m)).toBeNull();
});

test('not choosing in time loses to any move, and two no-shows tie', () => {
  expect(roundWinner(null, 'pillow')).toBe('b');
  expect(roundWinner('umbrella', null)).toBe('a');
  expect(roundWinner(null, null)).toBeNull();
});

test('a round resolves as soon as both have chosen, and the loser drops a heart', () => {
  const d = start();
  duelPick(d, 'a', 'pillow');
  expect(duelTick(d, 100)).toBe(false); // still waiting for Bao
  duelPick(d, 'b', 'chicken');
  expect(duelTick(d, 200)).toBe(true);
  expect(d.phase).toBe('reveal');
  expect(d.b.hearts).toBe(HEARTS - 1);
  expect(d.a.hearts).toBe(HEARTS);
  expect(d.last).toEqual({ a: 'pillow', b: 'chicken', loser: 'b' });
});

test('you cannot change your mind, pick nonsense, or pick for a duel you are not in', () => {
  const d = start();
  expect(duelPick(d, 'a', 'pillow')).toBe(true);
  expect(duelPick(d, 'a', 'umbrella')).toBe(false);
  expect(duelPick(d, 'b', 'sword')).toBe(false);
  expect(duelPick(d, 'zed', 'pillow')).toBe(false);
});

test('nobody can see a move until both are in', () => {
  const d = start();
  duelPick(d, 'a', 'pillow');
  const seen = JSON.stringify(duelView(d, 50));
  expect(seen).not.toContain('pillow');
  expect(duelView(d, 50).a.ready).toBe(true);
  expect(duelView(d, 50).b.ready).toBe(false);
});

test('first to take three hearts wins', () => {
  const d = start();
  let now = 0;
  now = round(d, 'pillow', 'chicken', now);
  now = round(d, 'pillow', 'pillow', now); // a tie costs nothing
  expect(d.b.hearts).toBe(2);
  now = round(d, 'chicken', 'umbrella', now);
  expect(d.phase).toBe('pick');
  duelPick(d, 'a', 'umbrella');
  duelPick(d, 'b', 'pillow');
  duelTick(d, now + 1);
  expect(d.phase).toBe('over');
  expect(d.winner).toBe('a');
  expect(d.b.hearts).toBe(0);
});

test('the clock running out counts as no move', () => {
  const d = start();
  duelPick(d, 'b', 'umbrella');
  expect(duelTick(d, ROUND_MS - 1)).toBe(false);
  expect(duelTick(d, ROUND_MS)).toBe(true);
  expect(d.a.hearts).toBe(HEARTS - 1);
});

test('walking away hands the win to the other fighter', () => {
  const d = start();
  duelForfeit(d, 'a', 10);
  expect(d.phase).toBe('over');
  expect(d.winner).toBe('b');
});

test('a duel that never ends is called a draw after fifteen rounds', () => {
  const d = start();
  let now = 0;
  for (let i = 0; i < 20 && d.phase !== 'over'; i++) now = round(d, 'pillow', 'pillow', now);
  expect(d.phase).toBe('over');
  expect(d.winner).toBe('');
});

// ---- regressions found by tests/sim/duel.sim.test.ts

test('regression: someone who is not in the duel cannot forfeit it', () => {
  const d = start();
  duelForfeit(d, 'zed', 10);
  expect(d.phase).toBe('pick');
  expect(d.winner).toBeNull();
});

test('regression: a broken clock does not resolve a round or freeze the duel', () => {
  const d = start();
  duelPick(d, 'a', 'pillow');
  expect(duelTick(d, NaN)).toBe(false);
  expect(d.phase).toBe('pick');
  expect(d.a.hearts).toBe(HEARTS);
  expect(Number.isFinite(d.until)).toBe(true);
});
