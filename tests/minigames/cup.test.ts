import { expect, test } from 'vitest';
import { PITCH } from '../../shared/layout';
import { EXTRA_MS, MATCH_MS, PAUSE_MS, cupGoal, cupJoin, cupKickoff, cupLeave, cupShuffle, cupSpots, cupSummary, cupSwitch, cupTeam, cupTick, cupView, newCup } from '../../shared/minigames/cup';

const names = ['Ann', 'Bao', 'Chi', 'Dung', 'Em', 'Fay'];
/** A lobby of n players with ids a, b, c… Joining alternates Red, Blue, Red… */
const lobby = (n: number) => {
  const g = newCup();
  for (let i = 0; i < n; i++) cupJoin(g, { id: String.fromCharCode(97 + i), name: names[i] ?? `P${i}` });
  return g;
};
/** A match of n players that has got past the opening countdown, at time PAUSE_MS. */
const playing = (n: number) => {
  const g = lobby(n);
  cupKickoff(g, 'a', 0);
  cupTick(g, PAUSE_MS);
  return g;
};
const sizes = (g: ReturnType<typeof newCup>) => [cupTeam(g, 'red').length, cupTeam(g, 'blue').length];

test('joining deals people to the shorter side, and joining twice does nothing', () => {
  const g = lobby(5);
  expect(sizes(g)).toEqual([3, 2]);
  expect(cupJoin(g, { id: 'a', name: 'Ann' })).toBe(false);
  expect(g.players.map((p) => p.team)).toEqual(['red', 'blue', 'red', 'blue', 'red']);
});

test('switching sides is allowed only while it keeps the sides within one', () => {
  const two = lobby(2);
  expect(cupSwitch(two, 'a')).toBe(false); // would be 0 against 2
  const three = lobby(3); // a, c Red; b Blue
  expect(cupSwitch(three, 'b')).toBe(false); // would be 3 against 0
  expect(cupSwitch(three, 'zed')).toBe(false);
  expect(cupSwitch(three, 'a')).toBe(true);
  expect(sizes(three)).toEqual([1, 2]);
});

test('shuffle re-deals evenly, only for someone playing, and follows the dice', () => {
  for (const n of [2, 5, 20]) {
    const g = lobby(n);
    expect(cupShuffle(g, 'zed')).toBe(false);
    expect(cupShuffle(g, 'a')).toBe(true);
    const [r, b] = sizes(g);
    expect(r + b).toBe(n);
    expect(Math.abs(r - b)).toBeLessThanOrEqual(1);
  }
  const g = lobby(3);
  cupShuffle(g, 'a', () => 0.99); // no swaps, Blue dealt first
  expect(g.players.map((p) => p.team)).toEqual(['blue', 'red', 'blue']);
});

test('kick-off needs two players and someone in the game, and starts with a rooted pause', () => {
  const one = lobby(1);
  expect(cupKickoff(one, 'a', 0)).toBe(false);
  const g = lobby(2);
  expect(cupKickoff(g, 'zed', 0)).toBe(false);
  expect(cupKickoff(g, 'b', 1000)).toBe(true);
  expect(cupKickoff(g, 'a', 1001)).toBe(false); // already going
  expect(cupView(g, 2000)).toMatchObject({ phase: 'kickoff', pause: PAUSE_MS - 1000, clock: MATCH_MS, score: [0, 0] });
  expect(cupTick(g, 1000 + PAUSE_MS - 1)).toBeNull();
  expect(cupTick(g, 1000 + PAUSE_MS)).toBe('play');
  expect(cupView(g, 1000 + PAUSE_MS + 5000).clock).toBe(MATCH_MS - 5000);
});

test('teams cannot be changed once the match is on', () => {
  const g = playing(3);
  expect(cupSwitch(g, 'a')).toBe(false);
  expect(cupShuffle(g, 'a')).toBe(false);
});

test('kick-off spots are spread out, on the pitch, and in the right half', () => {
  for (const n of [2, 7, 20, 26]) {
    const g = lobby(n);
    const spots = cupSpots(g);
    expect(spots).toHaveLength(n);
    for (const s of spots) {
      const team = g.players.find((p) => p.id === s.id)!.team;
      // Red defends the west goal, so Red lines up west of the centre spot.
      if (team === 'red') expect(s.x).toBeLessThan(PITCH.cx - 2);
      else expect(s.x).toBeGreaterThan(PITCH.cx + 2);
      expect(s.x).toBeGreaterThan(PITCH.x1 + 1);
      expect(s.x).toBeLessThan(PITCH.x2 - 1);
      expect(s.z).toBeGreaterThan(PITCH.z1 + 1);
      expect(s.z).toBeLessThan(PITCH.z2 - 1);
    }
    for (const a of spots) for (const b of spots) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(1.2);
  }
});

test('a goal counts, credits the scorer, stops the clock and holds a kick-off pause', () => {
  const g = playing(4);
  const t = PAUSE_MS + 30_000;
  expect(cupGoal(g, 'red', 'Ann', t)).toBe('goal');
  expect(g.score).toEqual([1, 0]);
  expect(g.scorers).toEqual([{ name: 'Ann', team: 'red', goals: 1 }]);
  expect(cupView(g, t + 1000)).toMatchObject({ phase: 'kickoff', pause: PAUSE_MS - 1000, clock: MATCH_MS - 30_000 });
  // A ball knocked in during the pause is not a goal.
  expect(cupGoal(g, 'blue', 'Bao', t + 500)).toBeNull();
  expect(g.score).toEqual([1, 0]);
  expect(cupTick(g, t + PAUSE_MS)).toBe('play');
  expect(cupView(g, t + PAUSE_MS).clock).toBe(MATCH_MS - 30_000);
  cupGoal(g, 'red', 'Ann', t + PAUSE_MS + 10);
  expect(g.scorers[0].goals).toBe(2);
});

test('goals with no match on, or with a nonsense side, are ignored', () => {
  const g = lobby(2);
  expect(cupGoal(g, 'red', 'Ann', 0)).toBeNull();
  expect(g.score).toEqual([0, 0]);
  const p = playing(2);
  expect(cupGoal(p, 'green', 'Ann', PAUSE_MS + 1)).toBeNull();
  expect(cupGoal(p, 'blue', 42, PAUSE_MS + 1)).toBe('goal'); // counts, scorer unknown
  expect(p.scorers[0].name).toBe('Someone');
});

test('an own goal counts for the other side but not towards top scorer', () => {
  const g = playing(2); // Ann Red, Bao Blue
  cupGoal(g, 'blue', 'Ann', PAUSE_MS + 1);
  expect(g.score).toEqual([0, 1]);
  expect(g.scorers).toEqual([]);
  expect(g.last).toEqual({ by: 'Ann', side: 'blue', own: true });
});

test('at full time the higher score wins and the top scorer is named', () => {
  const g = playing(4);
  let t = PAUSE_MS + 1000;
  for (const [side, by] of [['red', 'Ann'], ['blue', 'Bao'], ['red', 'Chi'], ['red', 'Ann']] as const) {
    cupGoal(g, side, by, t);
    cupTick(g, (t += PAUSE_MS));
    t += 1000;
  }
  expect(cupTick(g, g.until - 1)).toBeNull();
  expect(cupTick(g, g.until)).toBe('final');
  expect(g.phase).toBe('lobby');
  expect(g.result).toMatchObject({ winner: 'red', score: [3, 1], winners: ['a', 'c'], top: ['Ann'], topGoals: 2, forfeit: false });
  expect(cupSummary(g.result!)).toBe('Full time: Red 3 – 1 Blue. Red win! Top scorer: Ann (2).');
  // And straight back in the lobby, ready for another.
  expect(cupKickoff(g, 'b', t + 99_999)).toBe(true);
  expect(g.score).toEqual([0, 0]);
});

test('level at full time: one minute of next goal wins', () => {
  const g = playing(2);
  const full = PAUSE_MS + MATCH_MS;
  expect(cupTick(g, full)).toBe('extra');
  expect(cupView(g, full)).toMatchObject({ phase: 'play', extra: true, clock: EXTRA_MS });
  expect(cupGoal(g, 'blue', 'Bao', full + 20_000)).toBe('final');
  expect(g.result).toMatchObject({ winner: 'blue', score: [0, 1], winners: ['b'], top: ['Bao'] });
  expect(g.phase).toBe('lobby');
});

test('still level after the extra minute is a draw', () => {
  const g = playing(2);
  const full = PAUSE_MS + MATCH_MS;
  cupTick(g, full);
  expect(cupTick(g, full + EXTRA_MS - 1)).toBeNull();
  expect(cupTick(g, full + EXTRA_MS)).toBe('final');
  expect(g.result).toMatchObject({ winner: null, winners: [], top: [] });
  expect(cupSummary(g.result!)).toBe('Full time: Red 0 – 0 Blue. It is a draw.');
});

test('leaving mid-match removes the player; a side with nobody left forfeits', () => {
  const g = playing(3); // a, c Red; b Blue
  expect(cupLeave(g, 'zed')).toBeNull();
  expect(cupLeave(g, 'a')).toBe('left');
  expect(g.phase).toBe('play');
  expect(cupLeave(g, 'b')).toBe('final');
  expect(g.phase).toBe('lobby');
  expect(g.result).toMatchObject({ winner: 'red', forfeit: true, winners: ['c'] });
  expect(cupSummary(g.result!)).toContain('Red win by forfeit');
});

test('everyone leaving stops the match with no result', () => {
  const g = playing(2);
  cupLeave(g, 'a'); // Blue win by forfeit
  const h = playing(2);
  h.players[1].team = 'red'; // both on one side, as if the other had gone
  cupLeave(h, 'a');
  expect(cupLeave(h, 'b')).toBe('final');
  expect(h.phase).toBe('lobby');
  expect(h.result).toBeNull();
  expect(cupTick(h, 10 ** 9)).toBeNull();
});

test('leaving the lobby, or a lopsided finish, evens the sides up again', () => {
  const g = lobby(4); // a, c Red; b, d Blue
  cupLeave(g, 'b');
  cupLeave(g, 'd');
  expect(sizes(g)).toEqual([1, 1]);
  const m = playing(6);
  cupLeave(m, 'b');
  cupLeave(m, 'd'); // 3 against 1
  expect(sizes(m)).toEqual([3, 1]);
  cupTick(m, PAUSE_MS + MATCH_MS + EXTRA_MS);
  cupTick(m, PAUSE_MS + MATCH_MS + EXTRA_MS * 2);
  expect(m.phase).toBe('lobby');
  expect(sizes(m)).toEqual([2, 2]);
});

test('someone can join a match that is under way, on the shorter side, and gets a spot', () => {
  const g = playing(3);
  expect(cupJoin(g, { id: 'x', name: 'Xuan' })).toBe(true);
  expect(g.players.at(-1)!.team).toBe('blue');
  expect(cupSpots(g).find((s) => s.id === 'x')!.x).toBeGreaterThan(PITCH.cx);
});

test('the view carries nothing but the public state', () => {
  const g = playing(2);
  expect(Object.keys(cupView(g, PAUSE_MS)).sort()).toEqual(['clock', 'extra', 'last', 'phase', 'pause', 'players', 'result', 'scorers', 'score'].sort());
  expect(cupView(newCup(), 0)).toMatchObject({ phase: 'lobby', pause: 0, clock: 0, result: null });
});

test('regression: a shuffle survives a random source that returns exactly 1', () => {
  // Found by tests/sim/cup.sim.test.ts. Math.random never returns 1, but the other games' rules guard
  // against an injected source that does, and this one threw "Cannot set properties of undefined".
  const g = newCup();
  for (const id of ['a', 'b', 'c', 'd', 'e']) cupJoin(g, { id, name: id.toUpperCase() });
  expect(cupShuffle(g, 'a', () => 1)).toBe(true);
  expect(g.players.map((p) => p.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(Math.abs(cupTeam(g, 'red').length - cupTeam(g, 'blue').length)).toBe(1);
});

test('regression: the line-up leaves someone who is sitting down in their chair', async () => {
  // Found by tests/sim: `put` moves a person without standing them up, so a seated player was dragged
  // on to the pitch still "seated". They are lined up like everyone else once they stand.
  const { create } = await import('../../worker/src/minigames/cup');
  const people = [
    { id: 'a', name: 'Ann', color: '', look: '', x: 0, z: 0, ry: 0, seat: null as string | null },
    { id: 'b', name: 'Bao', color: '', look: '', x: 5, z: 5, ry: 0, seat: 'sofa' as string | null },
    { id: 'c', name: 'Chi', color: '', look: '', x: 6, z: 5, ry: 0, seat: 'sofa2' as string | null },
  ];
  const puts: string[] = [];
  const nop = () => {};
  const game = create({ players: () => people, send: nop, broadcast: nop, notice: nop, emote: nop, put: (id) => puts.push(id), nudge: nop, resetBall: nop, setScore: nop });
  game.onAction(people[0], { k: 'join' }, 0);
  game.onAction(people[1], { k: 'join' }, 0);
  game.onAction(people[0], { k: 'kickoff' }, 0);
  expect(puts).toEqual(['a']);
  // Joining mid-match from a chair does not move you either.
  game.onAction(people[2], { k: 'join' }, 100);
  expect(puts).toEqual(['a']);
  // After a goal, whoever has stood up by then is lined up.
  people[1].seat = null;
  game.tick!(PAUSE_MS);
  game.onEvent!({ kind: 'goal', side: 'red', by: 'Ann' }, PAUSE_MS + 1000);
  expect(puts).toEqual(['a', 'a', 'b']);
});
