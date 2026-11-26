import { expect, test } from 'vitest';
import {
  COUNTDOWN_MS,
  PUSH_CAP,
  RESULT_MS,
  ROUND_MS,
  SUMO_MAX,
  SUMO_REACH,
  type Mover,
  type SumoGame,
  newSumo,
  sumoJoin,
  sumoLeave,
  sumoOutside,
  sumoPlaces,
  sumoPush,
  sumoPushes,
  sumoStart,
  sumoTick,
  sumoView,
} from '../../shared/minigames/sumo';

const ring = { x: 0, z: 0, r: 4 };
const ann = { id: 'a', name: 'Ann' };
const bao = { id: 'b', name: 'Bao' };
const chi = { id: 'c', name: 'Chi' };
const still = (x: number, z: number): Mover => ({ x, z, px: x, pz: z });
const len = (v: { dx: number; dz: number }) => Math.hypot(v.dx, v.dz);

type Spots = Record<string, { x: number; z: number; seat?: string | null } | null>;
const at = (spots: Spots) => (id: string) => spots[id] ?? null;
const tick = (g: SumoGame, now: number, spots: Spots) => sumoTick(g, now, at(spots), ring);
/** A game with these players, started at time 0 and past the countdown. */
function bout(...ps: { id: string; name: string }[]) {
  const g = newSumo();
  for (const p of ps) sumoJoin(g, p);
  sumoStart(g, ps[0].id, 0);
  const spots: Spots = {};
  ps.forEach((p, i) => (spots[p.id] = { x: i - 1, z: 0 }));
  tick(g, COUNTDOWN_MS, spots);
  return { g, spots };
}

// The pushing.

test('nobody is pushed when they are apart', () => {
  expect(sumoPush(still(0, 0), still(SUMO_REACH, 0))).toBeNull();
  expect(sumoPush({ x: 0, z: 0, px: -1, pz: 0 }, still(3, 0))).toBeNull();
  expect(sumoPushes({ a: still(0, 0), b: still(2, 2) })).toEqual({});
});

test('a charging player moves a standing one, and barely moves themselves', () => {
  const p = sumoPush({ x: 0, z: 0, px: -0.4, pz: 0 }, still(1, 0))!;
  expect(p.b.dx).toBeGreaterThan(0.2); // pushed away from the charger
  expect(p.b.dz).toBeCloseTo(0);
  expect(p.a.dx).toBeLessThanOrEqual(0);
  expect(len(p.b)).toBeGreaterThan(len(p.a) * 5);
  // And the same the other way round, along the other axis.
  const q = sumoPush(still(0, 0), { x: 0, z: 1, px: 0, pz: 1.4 })!;
  expect(q.a.dz).toBeLessThan(-0.2);
  expect(len(q.a)).toBeGreaterThan(len(q.b) * 5);
});

test('head-on charges at equal speed cancel: both are held apart by the same small amount', () => {
  const p = sumoPush({ x: 0, z: 0, px: -0.4, pz: 0 }, { x: 1, z: 0, px: 1.4, pz: 0 })!;
  expect(p.a.dx).toBeCloseTo(-p.b.dx);
  expect(len(p.a)).toBeCloseTo((SUMO_REACH - 1) / 2); // just half the overlap each, no extra shove
  // Two people standing still against each other are the same.
  const q = sumoPush(still(0, 0), still(1, 0))!;
  expect(len(q.a)).toBeCloseTo(len(q.b));
});

test('the faster of two chargers wins the exchange', () => {
  const p = sumoPush({ x: 0, z: 0, px: -0.5, pz: 0 }, { x: 1, z: 0, px: 1.1, pz: 0 })!;
  expect(len(p.b)).toBeGreaterThan(len(p.a));
});

test('walking away from someone is not a charge', () => {
  // a is backing off; b stands. Neither is charging, so the overlap is shared evenly.
  const p = sumoPush({ x: 0, z: 0, px: 0.4, pz: 0 }, still(1, 0))!;
  expect(len(p.a)).toBeCloseTo(len(p.b));
});

test('pushes are capped, for a pair and for a pile-up', () => {
  const p = sumoPush({ x: 0, z: 0, px: -50, pz: 0 }, still(0.1, 0))!;
  expect(len(p.b)).toBeLessThanOrEqual(PUSH_CAP + 1e-9);
  expect(len(p.a)).toBeLessThanOrEqual(PUSH_CAP + 1e-9);
  // Two chargers hitting the same person from the same side.
  const all = sumoPushes({ a: { x: 0, z: 0.1, px: -9, pz: 0.1 }, b: { x: 0, z: -0.1, px: -9, pz: -0.1 }, c: still(0.5, 0) });
  expect(len(all.c)).toBeLessThanOrEqual(PUSH_CAP + 1e-9);
  expect(all.c.dx).toBeGreaterThan(0);
});

test('two people on exactly the same spot are still separated', () => {
  const p = sumoPush(still(1, 1), still(1, 1))!;
  expect(len(p.a)).toBeGreaterThan(0);
  expect(p.a.dx).toBeCloseTo(-p.b.dx);
});

test('starting spots are inside the ring, spread out, and outside spots are outside', () => {
  for (let n = 2; n <= SUMO_MAX; n++) {
    const s = sumoPlaces(n, ring);
    expect(s).toHaveLength(n);
    for (const p of s) expect(Math.hypot(p.x, p.z)).toBeLessThan(ring.r);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(Math.hypot(s[i].x - s[j].x, s[i].z - s[j].z)).toBeGreaterThan(SUMO_REACH);
  }
  expect(Math.hypot(sumoOutside(1, 1, ring).x, sumoOutside(1, 1, ring).z)).toBeGreaterThan(ring.r);
  expect(Math.hypot(sumoOutside(0, 0, ring).x, sumoOutside(0, 0, ring).z)).toBeGreaterThan(ring.r);
});

// The match.

test('it takes two to start, only a player can start, and nobody joins twice or mid-match', () => {
  const g = newSumo();
  expect(sumoJoin(g, ann)).toBe(true);
  expect(sumoJoin(g, ann)).toBe(false);
  expect(sumoStart(g, 'a', 0)).toEqual([]);
  sumoJoin(g, bao);
  expect(sumoStart(g, 'zed', 0)).toEqual([]);
  expect(sumoStart(g, 'b', 0)).toEqual([{ k: 'place' }]);
  expect(g.phase).toBe('countdown');
  expect(g.alive).toEqual(['a', 'b']);
  expect(sumoJoin(g, chi)).toBe(false);
  expect(sumoStart(g, 'a', 1)).toEqual([]); // already going
});

test('no more than eight can join', () => {
  const g = newSumo();
  for (let i = 0; i < SUMO_MAX; i++) expect(sumoJoin(g, { id: `p${i}`, name: `P${i}` })).toBe(true);
  expect(sumoJoin(g, ann)).toBe(false);
});

test('the countdown roots the round for three seconds, and being outside does not count yet', () => {
  const g = newSumo();
  sumoJoin(g, ann);
  sumoJoin(g, bao);
  sumoStart(g, 'a', 0);
  const spots = { a: { x: 0, z: 0 }, b: { x: 99, z: 0 } };
  expect(tick(g, COUNTDOWN_MS - 1, spots)).toEqual([]);
  expect(g.phase).toBe('countdown');
  expect(tick(g, COUNTDOWN_MS, { a: { x: 0, z: 0 }, b: { x: 1, z: 0 } })).toEqual([{ k: 'go' }]);
  expect(g.phase).toBe('bout');
  expect(sumoView(g, COUNTDOWN_MS + 1000).left).toBe(ROUND_MS - 1000);
});

test('stepping outside the ring puts you out, and the last one in wins the round', () => {
  const { g, spots } = bout(ann, bao, chi);
  spots.c = { x: 4.01, z: 0 };
  expect(tick(g, 4000, spots)).toEqual([{ k: 'out', id: 'c' }]);
  expect(g.alive).toEqual(['a', 'b']);
  spots.b = { x: 0, z: -5 };
  expect(tick(g, 5000, spots)).toEqual([
    { k: 'out', id: 'b' },
    { k: 'round', id: 'a', timeout: false },
  ]);
  expect(g.phase).toBe('result');
  expect(g.wins).toEqual({ a: 1 });
  expect(sumoView(g, 5000).players.map((p) => p.wins)).toEqual([1, 0, 0]);
});

test('standing right on the edge is still in', () => {
  const { g, spots } = bout(ann, bao);
  spots.a = { x: 4, z: 0 };
  expect(tick(g, 4000, spots)).toEqual([]);
});

test('sitting down or vanishing from the room puts you out', () => {
  const one = bout(ann, bao, chi);
  one.spots.b = { x: 0, z: 0, seat: 'sofa-1' };
  expect(tick(one.g, 4000, one.spots)).toEqual([{ k: 'out', id: 'b' }]);
  one.spots.c = null;
  expect(tick(one.g, 4100, one.spots)).toContainEqual({ k: 'round', id: 'a', timeout: false });
});

test('if the last two go out on the same tick, the one nearer the centre takes the round', () => {
  const { g, spots } = bout(ann, bao);
  spots.a = { x: 6, z: 0 };
  spots.b = { x: 0, z: 4.5 };
  expect(tick(g, 4000, spots)).toContainEqual({ k: 'round', id: 'b', timeout: false });
});

test('after sixty seconds the player nearest the centre wins the round', () => {
  const { g, spots } = bout(ann, bao, chi);
  spots.a = { x: 3, z: 0 };
  spots.b = { x: 0.5, z: 0.5 };
  spots.c = { x: -2, z: 0 };
  expect(tick(g, COUNTDOWN_MS + ROUND_MS - 1, spots)).toEqual([]);
  expect(tick(g, COUNTDOWN_MS + ROUND_MS, spots)).toEqual([{ k: 'round', id: 'b', timeout: true }]);
  expect(g.wins.b).toBe(1);
});

test('the next round starts after a pause with everyone back in, and two wins take the match', () => {
  const { g, spots } = bout(ann, bao, chi);
  spots.b = spots.c = { x: 9, z: 9 };
  let t = 4000;
  tick(g, t, spots);
  expect(tick(g, t + RESULT_MS - 1, spots)).toEqual([]);
  t += RESULT_MS;
  expect(tick(g, t, spots)).toEqual([{ k: 'place' }]);
  expect(g.round).toBe(2);
  expect(g.alive).toEqual(['a', 'b', 'c']);
  // Round 2 goes to Bao, so nobody has the match yet.
  const r2 = { a: { x: 9, z: 0 }, b: { x: 0, z: 0 }, c: { x: 9, z: 0 } };
  t += COUNTDOWN_MS;
  tick(g, t, { a: { x: 1, z: 0 }, b: { x: 0, z: 0 }, c: { x: -1, z: 0 } });
  tick(g, (t += 100), r2);
  expect(g.wins).toEqual({ a: 1, b: 1 });
  expect(g.phase).toBe('result');
  // Round 3 goes to Ann: match over.
  tick(g, (t += RESULT_MS), r2);
  tick(g, (t += COUNTDOWN_MS), { a: { x: 1, z: 0 }, b: { x: 0, z: 0 }, c: { x: -1, z: 0 } });
  const ev = tick(g, (t += 100), spots);
  expect(ev).toContainEqual({ k: 'match', id: 'a', name: 'Ann' });
  expect(g.phase).toBe('lobby');
  expect(g.champion).toEqual({ id: 'a', name: 'Ann' });
  expect(sumoView(g, t).left).toBe(0);
  // A new match wipes the old score.
  expect(sumoStart(g, 'c', t)).toEqual([{ k: 'place' }]);
  expect(g.wins).toEqual({});
  expect(g.champion).toBeNull();
  expect(g.round).toBe(1);
});

test('leaving mid-bout counts as going out, and the match is called off if one player is left', () => {
  const three = bout(ann, bao, chi);
  expect(sumoLeave(three.g, 'c', 4000)).toEqual([]);
  expect(three.g.alive).toEqual(['a', 'b']);
  expect(sumoLeave(three.g, 'zed', 4000)).toBeNull();

  const out = bout(ann, bao, chi);
  out.spots.c = { x: 9, z: 0 };
  tick(out.g, 4000, out.spots);
  // Bao leaves while only Ann and Bao are still in: Ann takes the round.
  expect(sumoLeave(out.g, 'b', 4100)).toEqual([{ k: 'round', id: 'a', timeout: false }]);
  expect(out.g.phase).toBe('result');
  expect(sumoLeave(out.g, 'c', 4200)).toEqual([{ k: 'abandon' }]);
  expect(out.g.phase).toBe('lobby');
  expect(out.g.players).toEqual([ann]);
  expect(sumoStart(out.g, 'a', 5000)).toEqual([]);
});

test('leaving in the lobby just removes you', () => {
  const g = newSumo();
  sumoJoin(g, ann);
  expect(sumoLeave(g, 'a', 0)).toEqual([]);
  expect(g.players).toEqual([]);
});

// Regressions found by tests/sim/sumo.sim.test.ts.

test('regression: a match where nobody ever wins a round (everyone sat down) is called off, not replayed for ever', () => {
  const g = newSumo();
  for (const p of [ann, bao]) sumoJoin(g, p);
  const seated: Spots = { a: { x: 9, z: 9, seat: 'sofa' }, b: { x: 8, z: 9, seat: 'sofa2' } };
  let now = 0;
  sumoStart(g, 'a', now);
  const seen: string[] = [];
  // Ten minutes of ticks, ten a second, with both of them sitting at a table.
  for (let i = 0; i < 6000 && g.phase !== 'lobby'; i++) seen.push(...tick(g, (now += 100), seated).map((e) => e.k));
  expect(g.phase).toBe('lobby');
  expect(g.round).toBe(3);
  expect(g.champion).toBeNull();
  expect(seen.filter((k) => k === 'abandon')).toEqual(['abandon']);
});

test('regression: a round somebody wins clears the count of empty rounds', () => {
  const g = newSumo();
  for (const p of [ann, bao, chi]) sumoJoin(g, p);
  const seated: Spots = { a: { x: 9, z: 9, seat: 's1' }, b: { x: 8, z: 9, seat: 's2' }, c: { x: 7, z: 9, seat: 's3' } };
  let now = 0;
  sumoStart(g, 'a', now);
  // Two empty rounds, then Chi stands in the ring alone and wins one, then two more empty rounds.
  const round = (spots: Spots) => {
    while (g.phase === 'countdown' || g.phase === 'bout') tick(g, (now += 100), spots);
    while (g.phase === 'result') tick(g, (now += 100), spots);
  };
  round(seated);
  round(seated);
  round({ ...seated, c: { x: 0, z: 0 } });
  expect(g.wins).toEqual({ c: 1 });
  round(seated);
  round(seated);
  expect(g.phase).not.toBe('lobby');
  round(seated);
  expect(g.phase).toBe('lobby');
});

test('regression: positions that are not numbers never give a push that is not a number', () => {
  const bad = [NaN, Infinity, -Infinity, 1e308, -1e308];
  for (const v of bad)
    for (const m of [{ x: v, z: 0, px: 0, pz: 0 }, { x: 0, z: v, px: 0, pz: 0 }, { x: 0.3, z: 0, px: v, pz: 0 }, { x: 0.3, z: 0, px: 0, pz: v }, { x: v, z: v, px: v, pz: v }] as Mover[]) {
      for (const p of [sumoPush(m, still(0.5, 0)), sumoPush(still(0.5, 0), m), sumoPush(m, m)]) {
        if (!p) continue;
        for (const n of [p.a.dx, p.a.dz, p.b.dx, p.b.dz]) expect(Number.isFinite(n)).toBe(true);
        expect(len(p.a)).toBeLessThanOrEqual(PUSH_CAP + 1e-9);
        expect(len(p.b)).toBeLessThanOrEqual(PUSH_CAP + 1e-9);
      }
      for (const out of Object.values(sumoPushes({ a: m, b: still(0.5, 0), c: still(0.2, 0.2) }))) expect(Number.isFinite(out.dx) && Number.isFinite(out.dz)).toBe(true);
    }
});

test('regression: someone whose position is not a number is not "in the ring", and is stood somewhere real when out', () => {
  const { g, spots } = bout(ann, bao, chi);
  spots.a = { x: NaN, z: 0 };
  const ev = tick(g, COUNTDOWN_MS + 100, spots);
  expect(ev).toContainEqual({ k: 'out', id: 'a' });
  expect(g.alive).toEqual(['b', 'c']);
  for (const [x, z] of [[NaN, 0], [0, NaN], [Infinity, -Infinity], [1e308, 1e308]]) {
    const s = sumoOutside(x, z, ring);
    expect(Number.isFinite(s.x) && Number.isFinite(s.z)).toBe(true);
    expect(Math.hypot(s.x - ring.x, s.z - ring.z)).toBeCloseTo(ring.r + 1.2);
  }
});

/** The real server factory with a recording room, for the regressions that are about what it sends. */
async function serverRoom(people: { id: string; x: number; z: number; seat: string | null }[]) {
  const { create } = await import('../../worker/src/minigames/sumo');
  const puts: { id: string; x: number; z: number }[] = [];
  const nudges: string[] = [];
  const nop = () => {};
  const info = () => people.map((p) => ({ ...p, name: p.id, color: '', look: '', ry: 0 }));
  const game = create({ players: info, send: nop, broadcast: nop, notice: nop, emote: nop, put: (id, x, z) => puts.push({ id, x, z }), nudge: (id) => nudges.push(id), resetBall: nop, setScore: nop });
  for (const p of info()) game.onAction(p, { k: 'join' }, 0);
  game.onAction(info()[0], { k: 'start' }, 0);
  return { game, puts, nudges };
}

test('regression: someone sitting down is not moved to a starting place in the ring', async () => {
  const { puts } = await serverRoom([{ id: 'a', x: 0, z: 0, seat: null }, { id: 'b', x: 5, z: 5, seat: 'sofa' }, { id: 'c', x: 1, z: 1, seat: null }]);
  expect(puts.map((p) => p.id)).toEqual(['a', 'c']);
});

test('regression: on the tick the bout starts, people who are not in the ring are not shoved about', async () => {
  // Two cheats who left the ring during the countdown and stand on one spot at the edge of the roof.
  const people = [{ id: 'a', x: 0, z: 0, seat: null as string | null }, { id: 'b', x: 0, z: 0, seat: null as string | null }];
  const { game, nudges } = await serverRoom(people);
  for (const p of people) [p.x, p.z] = [20, 44];
  game.tick!(COUNTDOWN_MS);
  expect(nudges).toEqual([]);
});
