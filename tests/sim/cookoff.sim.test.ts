// Cook-off, played thousands of times by a seeded random crowd that also cheats and misbehaves.
// Two sims: the real server factory behind a recording GameIO in a small simulated room, and the pure
// rules. The test keeps its own score from the recipe arithmetic and checks it after every step.
//
//   SIM_RUNS=10000 npx vitest run tests/sim/cookoff.sim.test.ts            more games
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/cookoff.sim.test.ts  replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import { RECIPES } from '../../shared/kitchen';
import { BOUNDS } from '../../shared/layout';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO, RoomEvent, ServerGame } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/cookoff';
import {
  COOKOFF_MAX, COOKOFF_MIN, COUNTDOWN_MS, FEED_LEN, ORDER_MS, ROUND_MS,
  type CookResult, type CookoffGame, type CookoffView, type Team, cookJoin, cookLeave, cookServe, cookStart, cookSwitch, cookTick, cookView, dishPoints, newCookoff, resultText, teamSize,
} from '../../shared/minigames/cookoff';

/** Read without Node's types, which this project does not load. */
const ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(ENV.SIM_RUNS) || 1000;
const SEED0 = Number(ENV.SIM_SEED) || 1;

// ---------------------------------------------------------------------------------------------------------
// Harness. The same in every tests/sim file (kept inline: each game owns only its own files).
// ---------------------------------------------------------------------------------------------------------
type Rnd = () => number;
/** mulberry32: small, fast, and the same everywhere. */
const rng = (seed: number): Rnd => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const int = (r: Rnd, n: number) => Math.floor(r() * n);
const pick = <T>(r: Rnd, xs: readonly T[]): T => xs[int(r, xs.length)];
const chance = (r: Rnd, p: number) => r() < p;
/** Throws with a message; much cheaper than `expect` in a loop that runs millions of times. */
function must(ok: unknown, msg: string | (() => string)): asserts ok {
  if (!ok) throw new Error(typeof msg === 'string' ? msg : msg());
}
const BAD_NUMBERS = [NaN, Infinity, -Infinity, 1e308, -1e308, 1e9, -1e9, -0];
/** Things no honest browser sends as an action. */
const junk = (r: Rnd, ks: readonly string[]): Record<string, unknown> =>
  pick(r, [
    () => ({}),
    () => ({ k: null }),
    () => ({ k: pick(r, BAD_NUMBERS) }),
    () => ({ k: 'nope' }),
    () => ({ k: [pick(r, ks)] }),
    () => ({ k: { k: pick(r, ks) } }),
    () => ({ k: pick(r, ks).toUpperCase() }),
    () => ({ k: '__proto__' }),
    () => ({ k: 'constructor' }),
    () => ({ k: pick(r, ks), x: NaN, z: -Infinity, id: 'p0', team: 7, ms: -5, n: 1e308, to: null, name: 'x'.repeat(5000) }),
    () => Object.create({ k: pick(r, ks) }) as Record<string, unknown>,
    () => JSON.parse('{"__proto__":{"k":"join"},"k":"toString"}') as Record<string, unknown>,
  ])();
/** Fails on NaN, infinities and negative numbers (except under the keys in `signed`) anywhere in a view. */
function scan(v: unknown, signed: readonly string[], path: string, key = ''): void {
  if (typeof v === 'number') {
    must(Number.isFinite(v), `${path} is ${v}`);
    must(v >= 0 || signed.includes(key), `${path} is negative: ${v}`);
  } else if (typeof v === 'string') must(!/undefined|NaN|Infinity|\[object /.test(v), `${path} has broken text: ${v.slice(0, 80)}`);
  else if (Array.isArray(v)) v.forEach((x, i) => (must(x !== undefined, `${path}[${i}] is undefined`), scan(x, signed, `${path}[${i}]`, key)));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, signed, `${path}.${k}`, k);
}
const inRoof = (x: number, z: number) => x >= BOUNDS.x1 && x <= BOUNDS.x2 && z >= BOUNDS.z1 && z <= BOUNDS.z2;
const clampTo = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : Math.max(lo, Math.min(hi, 0)));

type Msg =
  | { k: 'send'; id: string; view: unknown }
  | { k: 'cast'; view: unknown }
  | { k: 'notice'; text: string }
  | { k: 'put'; id: string; x: number; z: number }
  | { k: 'nudge'; id: string; dx: number; dz: number }
  | { k: 'score'; red: number; blue: number };
/** How a simulated person moves: 0 stands, 1 wanders, 2 chases the nearest, 3 flees them, 4 heads for the game, 5 teleports. */
interface Body extends PlayerInfo {
  style: number;
  /** Whether their browser does what `put` and `nudge` say. A cheat's does not. */
  obeys: boolean;
}
const PROBE: PlayerInfo = { id: 'probe', name: 'Probe', color: '#000', look: 'a', x: 0, z: 0, ry: 0, seat: null };

/** A room: people with positions, a clock, and a GameIO that does what the real room does and records it. */
class Room {
  now = 1_700_000_000_000;
  /** Everyone who is in the room now. */
  here: Body[] = [];
  msgs: Msg[] = [];
  /** Messages delivered: a broadcast counts once for everyone in the room. */
  delivered = 0;
  casts = 0;
  score: [number, number] = [0, 0];
  private probed: unknown;
  /** `raw`: positions are not clamped to the roof and may be NaN, which the real room never allows. */
  constructor(readonly r: Rnd, readonly raw: boolean, readonly signed: readonly string[] = []) {}
  body = (id: string) => this.here.find((b) => b.id === id);
  private view(view: unknown, to: number) {
    scan(view, this.signed, 'view');
    this.delivered += to;
  }
  io: GameIO = {
    players: () => this.here.map(({ id, name, color, look, x, z, ry, seat }) => ({ id, name, color, look, x, z, ry, seat })),
    send: (id, view) => {
      if (id === PROBE.id) return void (this.probed = view);
      this.view(view, 1);
      this.msgs.push({ k: 'send', id, view });
    },
    broadcast: (view) => {
      this.view(view, this.here.length);
      this.casts++;
      this.msgs.push({ k: 'cast', view });
    },
    notice: (text) => {
      must(typeof text === 'string' && text.length > 0 && !/undefined|NaN|Infinity|\[object /.test(text), `broken notice: ${text}`);
      this.delivered += this.here.length;
      this.msgs.push({ k: 'notice', text });
    },
    emote: (id, k) => {
      must(typeof id === 'string' && typeof k === 'string' && k.length > 0, `broken emote ${id} ${k}`);
      this.delivered += this.here.length;
    },
    put: (id, x, z) => {
      must(Number.isFinite(x) && Number.isFinite(z), `put ${id} to ${x},${z}`);
      must(this.raw || inRoof(x, z), `put ${id} off the roof: ${x},${z}`);
      this.delivered++;
      this.msgs.push({ k: 'put', id, x, z });
      const b = this.body(id);
      if (!b) return;
      // The real room moves its own record at once; the browser follows unless it cheats.
      b.x = clampTo(x, BOUNDS.x1 + 0.7, BOUNDS.x2 - 0.7);
      b.z = clampTo(z, BOUNDS.z1 + 0.7, BOUNDS.z2 - 0.7);
    },
    nudge: (id, dx, dz) => {
      must(Number.isFinite(dx) && Number.isFinite(dz), `nudge ${id} by ${dx},${dz}`);
      this.delivered++;
      this.msgs.push({ k: 'nudge', id, dx, dz });
      const b = this.body(id);
      if (!b || !b.obeys || b.seat) return;
      must(this.raw || inRoof(b.x + dx, b.z + dz), `nudged ${id} off the roof`);
      b.x += dx;
      b.z += dz;
    },
    resetBall: () => void (this.delivered += this.here.length),
    setScore: (red, blue) => {
      must(Number.isInteger(red) && Number.isInteger(blue) && red >= 0 && blue >= 0, `setScore ${red},${blue}`);
      this.delivered += this.here.length;
      this.score = [red, blue];
      this.msgs.push({ k: 'score', red, blue });
    },
  };
  /** The game's public view right now, as a newcomer would be sent it (undefined if it sends nothing). */
  probe<V>(game: ServerGame): V | undefined {
    this.probed = undefined;
    game.onJoin?.(PROBE, this.now);
    if (this.probed !== undefined) scan(this.probed, this.signed, 'probe');
    return this.probed as V | undefined;
  }
  /** Somewhere a browser might claim to be: usually on the roof, sometimes far off it or nowhere at all. */
  spot(near: { x: number; z: number }, spread: number): { x: number; z: number } {
    const r = this.r;
    let x = near.x + (r() - 0.5) * 2 * spread;
    let z = near.z + (r() - 0.5) * 2 * spread;
    if (chance(r, 0.1)) [x, z] = [BOUNDS.x1 - 30 + r() * 124, BOUNDS.z1 - 30 + r() * 124];
    if (this.raw && chance(r, 0.3)) [x, z] = [chance(r, 0.6) ? pick(r, BAD_NUMBERS) : x, chance(r, 0.6) ? pick(r, BAD_NUMBERS) : z];
    return this.raw ? { x, z } : { x: clampTo(x, BOUNDS.x1, BOUNDS.x2), z: clampTo(z, BOUNDS.z1, BOUNDS.z2) };
  }
  /** Everyone takes a step, at most as far as a person can run in `dt`. */
  move(dt: number, focus: { x: number; z: number }) {
    const r = this.r;
    const step = 8.5 * Math.min(dt, 1000) * 0.001;
    for (const b of this.here) {
      if (b.seat || b.style === 0) continue;
      if (b.style === 5 && chance(r, 0.08)) {
        Object.assign(b, this.spot(focus, 8));
        continue;
      }
      let tx = r() - 0.5;
      let tz = r() - 0.5;
      if (b.style === 2 || b.style === 3) {
        let best: Body | null = null;
        let bd = Infinity;
        for (const o of this.here) {
          const d = Math.hypot(o.x - b.x, o.z - b.z);
          if (o !== b && d < bd) [best, bd] = [o, d];
        }
        if (best) [tx, tz] = b.style === 2 ? [best.x - b.x, best.z - b.z] : [b.x - best.x + (r() - 0.5), b.z - best.z + (r() - 0.5)];
      } else if (b.style === 4) [tx, tz] = [focus.x - b.x + (r() - 0.5) * 3, focus.z - b.z + (r() - 0.5) * 3];
      const len = Math.hypot(tx, tz);
      if (!(len > 1e-9) || !Number.isFinite(len)) continue;
      const go = Math.min(step * (0.3 + 0.7 * r()), b.style === 2 || b.style === 4 ? len : Infinity);
      const x = b.x + (tx / len) * go;
      const z = b.z + (tz / len) * go;
      [b.x, b.z] = this.raw ? [x, z] : [clampTo(x, BOUNDS.x1, BOUNDS.x2), clampTo(z, BOUNDS.z1, BOUNDS.z2)];
    }
  }
  /** Take the messages recorded since the last call. */
  take(): Msg[] {
    const m = this.msgs;
    this.msgs = [];
    return m;
  }
}
const newBody = (room: Room, i: number, near: { x: number; z: number }, spread: number): Body => ({
  id: `p${i}`,
  name: chance(room.r, 0.1) ? pick(room.r, ['', 'Ann', 'Someone', 'x'.repeat(40)]) : `P${i}`,
  color: '#fff',
  look: 'a',
  ...room.spot(near, spread),
  ry: 0,
  seat: null,
  style: int(room.r, 6),
  obeys: chance(room.r, 0.85),
});
const EVENTS = (r: Rnd, names: string[]): RoomEvent =>
  pick(r, [
    (): RoomEvent => ({ kind: 'goal', side: pick(r, ['red', 'blue'] as const), by: pick(r, [...names, '', 'Nobody']) }),
    (): RoomEvent => ({ kind: 'serve', id: pick(r, ['p0', 'p1', 'ghost', '']), name: pick(r, [...names, '']), dish: pick(r, ['Burger', 'Garden Salad', 'The Works', '', 'Mud Pie']) }),
    (): RoomEvent => ({ kind: 'duel', winner: 'P0', loser: 'P1' }),
    (): RoomEvent => ({ kind: 'lap', name: 'P0', ms: pick(r, [0, -1, NaN, 31000]) }),
    (): RoomEvent => ({ kind: 'chess', winner: '' }),
    () => ({ kind: 'goal', side: pick(r, ['green', null, 7, undefined]), by: pick(r, [null, 7, undefined, {}]) }) as unknown as RoomEvent,
    () => ({ kind: 'serve', id: null, name: 5, dish: pick(r, [null, NaN, {}, undefined]) }) as unknown as RoomEvent,
    () => ({ kind: pick(r, ['', 'nope', null]) }) as unknown as RoomEvent,
  ])();
/** Run `fn` once per seed; a failure names the seed that replays it. */
const seeded = (name: string, fn: (seed: number) => void) => {
  for (let i = 0; i < RUNS; i++) {
    const seed = SEED0 + i;
    try {
      fn(seed);
    } catch (e) {
      throw new Error(`${name} failed. Replay with SIM_SEED=${seed} SIM_RUNS=1. ${(e as Error).stack}`);
    }
  }
};

// ---------------------------------------------------------------------------------------------------------
// The server, in a room.
// ---------------------------------------------------------------------------------------------------------
const KS = ['join', 'leave', 'switch', 'start'] as const;
const KITCHEN = { x: 9.4, z: 9.6 };
const SIDES = ['red', 'blue'] as const;
const opp = (t: Team): Team => (t === 'red' ? 'blue' : 'red');
const DISHES = RECIPES.map((x) => x.name);
/** The recipe arithmetic, written again here: 1 point for two ingredients, 2 for three, 3 for four or more, 1 for a dish nobody knows. */
const worth = (dish: string) => {
  const n = RECIPES.find((x) => x.name === dish)?.items.length;
  return n === undefined ? 1 : n >= 4 ? 3 : n === 3 ? 2 : 1;
};
const stats = { sims: 0, contests: 0, fullTime: 0, draws: 0, forfeits: 0, calledOff: 0, serves: 0, bonuses: 0, ignored: 0, swaps: 0, steps: 0, pureContests: 0, pureFullTime: 0, pureForfeits: 0, pureServes: 0, pureBonuses: 0, pureIgnored: 0 };

/** What a result must say, given the score the test kept and who is still there (in joining order). */
function judgeResult(res: CookResult, score: Record<Team, number>, players: { name: string; pts: number }[], forfeitTo: Team | null, why: string) {
  must(res.red === score.red && res.blue === score.blue, `${why}: result ${res.red}-${res.blue}, the test counted ${score.red}-${score.blue}`);
  must(res.forfeit === !!forfeitTo, `${why}: forfeit is ${res.forfeit}`);
  must(res.winner === (forfeitTo ?? (score.red > score.blue ? 'red' : score.blue > score.red ? 'blue' : 'draw')), `${why}: "${res.winner}" won ${score.red}-${score.blue}`);
  const best = Math.max(0, ...players.map((p) => p.pts));
  if (best === 0) must(res.top === null, `${why}: a top cook with nothing served`);
  else must(res.top !== null && res.top.pts === best && res.top.name === players.find((p) => p.pts === best)!.name, `${why}: top cook ${JSON.stringify(res.top)}, best was ${best}`);
  must(!/undefined|NaN/.test(resultText(res)), `${why}: broken result line`);
}

function serverSim(seed: number) {
  const r = rng(seed);
  vi.spyOn(Math, 'random').mockImplementation(rng(seed ^ 0x5bd1e995));
  const room = new Room(r, chance(r, 0.1));
  const game = create(room.io);
  const crowd = chance(r, 0.08) ? 22 + int(r, 4) : 2 + int(r, 7);
  const all = Array.from({ length: crowd }, (_, i) => newBody(room, i, KITCHEN, 5));
  room.here = all.filter(() => chance(r, 0.9));
  const chaos = pick(r, [0, 0, 0.01, 0.01, 0.15]);
  /** How often a dish goes over the counter, per tick. */
  const serveRate = pick(r, [0, 0.002, 0.01, 0.01, 0.05, 0.3]);

  type Snap = { phase: CookoffView['phase']; left: number; ids: string[]; team: Map<string, Team>; names: Map<string, string>; order: CookoffView['order']; last: CookResult | null; feedLen: number };
  let prev: Snap = { phase: 'lobby', left: 0, ids: [], team: new Map(), names: new Map(), order: { red: null, blue: null }, last: null, feedLen: 0 };
  /** The score and each cook's points, kept by the test. */
  let score: Record<Team, number> = { red: 0, blue: 0 };
  let pts = new Map<string, number>();
  let served: { id: string; dish: unknown } | null = null;
  const size = (s: Snap, t: Team) => [...s.team.values()].filter((x) => x === t).length;

  const check = (what: string, dt = 0) => {
    const v = room.probe<CookoffView>(game);
    const cur: Snap = v
      ? { phase: v.phase, left: v.left, ids: v.players.map((p) => p.id), team: new Map(v.players.map((p) => [p.id, p.team])), names: new Map(v.players.map((p) => [p.id, p.name])), order: v.order, last: v.last, feedLen: v.feed.length }
      : { phase: 'lobby', left: 0, ids: [], team: new Map(), names: new Map(), order: { red: null, blue: null }, last: prev.last, feedLen: 0 };
    const msgs = room.take();
    const said = msgs.filter((m) => m.k === 'notice').map((m) => (m as { text: string }).text);
    must(!msgs.some((m) => m.k === 'put' || m.k === 'nudge' || m.k === 'score'), 'the cook-off moved someone or set the football score');
    must(new Set(cur.ids).size === cur.ids.length && cur.ids.length <= COOKOFF_MAX, 'bad list of cooks');
    const live = cur.phase !== 'lobby';
    const wasLive = prev.phase !== 'lobby';
    const [nr, nb] = [size(cur, 'red'), size(cur, 'blue')];

    // A serve counts only for a contestant while the clock is running, and is worth what the recipe says.
    let gained = 0;
    if (served) {
      const cook = served.id;
      const team = prev.team.get(cook);
      const dish = served.dish;
      const ok = prev.phase === 'play' && prev.left > 0 && team !== undefined && typeof dish === 'string' && dish !== '';
      if (!ok) {
        stats.ignored++;
        must(msgs.length === 0, `a serve that does not count (${what}) sent ${msgs.length} messages`);
      } else {
        stats.serves++;
        const o = prev.order[team];
        const bonus = !!o && o.dish === dish && o.left > 0;
        gained = worth(dish) * (bonus ? 2 : 1);
        score[team] += gained;
        pts.set(cook, (pts.get(cook) ?? 0) + gained);
        const f = v!.feed[v!.feed.length - 1];
        must(f && f.name === prev.names.get(cook) && f.team === team && f.dish === dish && f.pts === gained && f.bonus === bonus, `the feed reads ${JSON.stringify(f)}, expected ${gained} for ${dish}`);
        must(v!.feed.length === Math.min(FEED_LEN, prev.feedLen + 1), 'the feed is the wrong length');
        if (bonus) {
          // The doubled order is used up: a new one, and never the same dish.
          stats.bonuses++;
          must(v!.order[team] !== null && v!.order[team]!.dish !== dish && v!.order[team]!.left === ORDER_MS, 'a filled order was not swapped for a new one');
        } else must(JSON.stringify(v!.order[team]) === JSON.stringify(prev.order[team]), 'an order changed without being filled');
        must(JSON.stringify(v!.order[opp(team)]) === JSON.stringify(prev.order[opp(team)]), "the other side's order changed");
      }
    }

    if (!wasLive && live) {
      stats.contests++;
      score = { red: 0, blue: 0 };
      pts = new Map();
      must(what === 'action start' && cur.phase === 'countdown' && cur.left === COUNTDOWN_MS, `a contest began by ${what}`);
      must(cur.ids.length >= COOKOFF_MIN && Math.abs(nr - nb) <= 1, `a contest began with ${nr} against ${nb}`);
      must(v!.feed.length === 0 && v!.last === null && said.some((t) => /started a cook-off/.test(t)), 'a contest began with leftovers or without a word');
    }
    // Someone who leaves takes their own tally with them (the side keeps the points); back again, they start from nothing.
    for (const id of prev.ids) if (!cur.ids.includes(id)) pts.delete(id);
    if (v && (live || wasLive)) {
      must(v.score.red === score.red && v.score.blue === score.blue, `score ${v.score.red}-${v.score.blue}, the test counted ${score.red}-${score.blue} (${what})`);
      for (const p of v.players) must(p.pts === (pts.get(p.id) ?? 0), `${p.id} has ${p.pts} points, the test counted ${pts.get(p.id) ?? 0}`);
    }
    if (live) {
      must(nr >= 1 && nb >= 1, `a contest with ${nr} against ${nb}`);
      must(cur.left <= (cur.phase === 'play' ? ROUND_MS : COUNTDOWN_MS), `left is ${cur.left}`);
      must(v!.last === null, 'an old result during a contest');
      for (const t of SIDES) {
        const o = cur.order[t];
        must(cur.phase === 'play' ? o !== null : o === null, `${t}'s order is ${JSON.stringify(o)} in the ${cur.phase}`);
        if (o) must(DISHES.includes(o.dish) && o.pts === 2 * worth(o.dish) && o.left <= ORDER_MS, `a bad order: ${JSON.stringify(o)}`);
      }
      if (wasLive) {
        for (const id of cur.ids) must(!prev.team.has(id) || prev.team.get(id) === cur.team.get(id), `${id} changed sides during a contest`);
        if (cur.ids.length > prev.ids.length) must(Math.abs(nr - nb) <= Math.max(1, Math.abs(size(prev, 'red') - size(prev, 'blue'))), 'a latecomer joined the bigger side');
        if (prev.phase === 'countdown' && cur.phase === 'play') must(what === 'tick' && dt >= prev.left && cur.left === ROUND_MS && SIDES.every((t) => cur.order[t]!.left === ORDER_MS), 'the round began wrongly');
        else if (cur.phase === prev.phase) must(cur.left === prev.left - dt && cur.left > 0, `the clock went from ${prev.left} to ${cur.left} in ${dt} ms`);
        else must(false, 'the contest went back to the countdown');
        // A standing order is swapped only when its time is up, and never for the same dish.
        if (prev.phase === 'play' && !served)
          for (const t of SIDES) {
            const [a, b] = [prev.order[t]!, cur.order[t]!];
            if (a.left - dt > 0) must(b.dish === a.dish && b.left === a.left - dt, `${t}'s order changed early`);
            else (stats.swaps++, must(what === 'tick' && b.dish !== a.dish && b.left === ORDER_MS, `${t}'s stale order was not swapped`));
          }
      }
    } else {
      must(cur.left === 0 && cur.order.red === null && cur.order.blue === null, 'a clock or an order in the lobby');
      if (wasLive) {
        const gone = prev.ids.filter((id) => !cur.ids.includes(id));
        if (what === 'tick') {
          // Full time.
          must(prev.phase === 'play' && dt >= prev.left && cur.last !== null && cur.last !== prev.last, 'a contest stopped on a tick without a result');
          judgeResult(cur.last, score, v!.players, null, what);
          cur.last.winner === 'draw' ? stats.draws++ : stats.fullTime++;
          must(said.includes(resultText(cur.last)), 'the result was not announced');
        } else {
          // Somebody left and their side was empty.
          must(gone.length === 1 && size(prev, prev.team.get(gone[0])!) === 1, `a contest stopped by ${what} with both sides there`);
          if (prev.phase === 'play' && cur.ids.length) {
            stats.forfeits++;
            must(cur.last !== null && cur.last !== prev.last, 'a forfeit without a result');
            judgeResult(cur.last, score, v!.players, opp(prev.team.get(gone[0])!), what);
            must(said.includes(resultText(cur.last)), 'the forfeit was not announced');
          } else {
            stats.calledOff++;
            must(cur.last === prev.last && said.length === 0, 'a result for a contest that never got going');
          }
        }
      } else must(cur.last === prev.last, 'a result appeared in the lobby');
    }
    served = null;
    prev = cur;
  };

  const serve = (id: string, dish: unknown) => {
    served = { id, dish };
    game.onEvent?.({ kind: 'serve', id, name: room.body(id)?.name ?? '', dish } as RoomEvent, room.now);
    check('serve');
  };
  /** A dish over the counter: usually a cook's own order or another real dish, sometimes something odd. */
  const anyServe = () => {
    const id = chance(r, 0.85) && room.here.length ? pick(r, room.here).id : pick(r, ['', 'ghost', 'probe', 'claude']);
    const team = prev.team.get(id);
    const wanted = team && prev.order[team]?.dish;
    const dish: unknown = wanted && chance(r, 0.4) ? wanted : chance(r, 0.85) ? pick(r, DISHES) : pick(r, ['Mystery Plate', 'Mud Pie', '', ' ', 'burger', null, undefined, NaN, 7, {}, ['Burger']]);
    serve(id, dish);
  };
  const tick = (dt: number) => {
    room.now += dt;
    room.move(dt, KITCHEN);
    const before = room.casts;
    game.tick?.(room.now);
    must(room.casts - before <= 1, 'more than one broadcast in a tick');
    check('tick', dt);
    if (chance(r, serveRate)) anyServe();
  };

  if (chance(r, 0.9)) {
    for (const b of room.here)
      if (chance(r, 0.8)) {
        game.onAction({ ...b }, { k: 'join' }, room.now);
        check('action join');
      }
    if (room.here.length) game.onAction({ ...pick(r, room.here) }, { k: 'start' }, room.now);
    check('action start');
  }
  const steps = 300 + int(r, 2400);
  for (let i = 0; i < steps; i++) {
    stats.steps++;
    if (!chance(r, chaos)) {
      tick(chance(r, 0.002) ? pick(r, [1000, 5000, 44_900, 45_000, 200_000]) : 100);
      continue;
    }
    const op = int(r, 10);
    const who = room.here.length ? pick(r, room.here) : null;
    if (op < 4 && who) {
      const a = chance(r, 0.25) ? junk(r, KS) : { k: pick(r, ['join', 'join', 'start', 'start', 'switch', 'leave'] as const) };
      game.onAction({ ...who }, a, room.now);
      check(`action ${String(a.k)}`);
    } else if (op === 4 && who) {
      who.seat = who.seat ? null : `seat${int(r, 3)}`;
      check('sit');
    } else if (op === 5 && who) {
      // Leaving the room: one person, or a whole side one after another.
      const side = pick(r, SIDES);
      const gone = chance(r, 0.1) ? room.here.filter((b) => prev.team.get(b.id) === side) : [who];
      for (const b of gone) {
        room.here = room.here.filter((x) => x !== b);
        game.onLeave(b.id, room.now);
        check('leave room');
      }
    } else if (op === 6) {
      const back = all.filter((b) => !room.here.includes(b));
      if (back.length) {
        const b = pick(r, back);
        Object.assign(b, room.spot(KITCHEN, 5), { seat: null });
        room.here.push(b);
        game.onJoin?.({ ...b }, room.now);
        check('join room');
      }
    } else if (op === 7) {
      if (chance(r, 0.7)) anyServe();
      else {
        // Events that are not a dish being served, or not a sensible one, never count (nobody in them is a cook).
        const e = EVENTS(r, all.map((b) => b.name));
        if (e.kind === 'serve') served = { id: e.id, dish: e.dish };
        game.onEvent?.(e, room.now);
        game.onLeave(pick(r, ['', 'nobody', 'probe', '__proto__']), room.now);
        check('event');
      }
    } else if (op === 8 && who) {
      Object.assign(who, room.spot(KITCHEN, 30));
      check('teleport');
    } else if (who) {
      for (const b of [...room.here]) {
        const k = pick(r, KS);
        game.onAction({ ...b }, { k }, room.now);
        check(`action ${k}`);
      }
    }
  }

  // Nobody touches anything any more: it must wind up by itself, without flooding the room.
  const from = room.casts;
  const idle = (dt: number) => {
    room.now += dt;
    game.tick?.(room.now);
    check('tick', dt);
  };
  for (let i = 0; i < 600; i++) idle(100);
  must(room.casts - from <= 4, `${room.casts - from} broadcasts in a quiet minute`);
  for (let i = 0; i < 200 && prev.phase !== 'lobby'; i++) idle(1000);
  must(prev.phase === 'lobby', `still in ${prev.phase} long after the round should be over`);
  const quiet = room.delivered;
  for (let i = 0; i < 40; i++) {
    idle(pick(r, [100, 100, 1000, 60_000]));
    // People still cook after the contest: that is none of its business.
    if (chance(r, 0.3)) anyServe();
  }
  must(room.delivered === quiet, `${room.delivered - quiet} messages from an idle lobby`);
  stats.sims++;
}

// ---------------------------------------------------------------------------------------------------------
// The rules alone.
// ---------------------------------------------------------------------------------------------------------
function rulesSim(seed: number) {
  const r = rng(seed);
  const g: CookoffGame = newCookoff();
  let now = 5_000_000;
  const n = chance(r, 0.1) ? 26 : 2 + int(r, 7);
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  /** A random source that now and then returns its extremes, 1 included. */
  const rnd = () => (chance(r, 0.03) ? pick(r, [0, 0.5, 0.999999, 1]) : r());
  let score: Record<Team, number> = { red: 0, blue: 0 };
  let pts = new Map<string, number>();

  const check = (what: string) => {
    const [nr, nb] = [teamSize(g, 'red'), teamSize(g, 'blue')];
    must(new Set(g.players.map((p) => p.id)).size === g.players.length && g.players.length <= COOKOFF_MAX, `${what}: bad list of cooks`);
    if (g.phase === 'lobby') must(g.until === 0 && g.order.red === null && g.order.blue === null, `${what}: a clock or an order in the lobby`);
    else {
      must(nr >= 1 && nb >= 1, `${what}: a contest with ${nr} against ${nb}`);
      must(g.last === null, `${what}: an old result during a contest`);
      for (const t of SIDES) must(g.phase === 'play' ? g.order[t] !== null && DISHES.includes(g.order[t]!.dish) : g.order[t] === null, `${what}: ${t}'s order is ${JSON.stringify(g.order[t])} in the ${g.phase}`);
      must(g.score.red === score.red && g.score.blue === score.blue, `${what}: score ${g.score.red}-${g.score.blue}, the test counted ${score.red}-${score.blue}`);
      for (const p of g.players) must(p.pts === (pts.get(p.id) ?? 0), `${what}: ${p.id} has ${p.pts}, the test counted ${pts.get(p.id) ?? 0}`);
    }
    must(g.feed.length <= FEED_LEN, `${what}: the feed is ${g.feed.length} long`);
    scan(cookView(g, now), [], 'view');
    scan(cookView(g, now + pick(r, [1, 1e7])), [], 'later view');
  };

  const steps = 100 + int(r, 1500);
  for (let i = 0; i < steps; i++) {
    const op = int(r, 60);
    const who = chance(r, 0.1) ? 'stranger' : pick(r, ids);
    const was = { phase: g.phase, until: g.until, teams: new Map(g.players.map((p) => [p.id, p.team])), order: { red: g.order.red && { ...g.order.red }, blue: g.order.blue && { ...g.order.blue } }, last: g.last };
    const sizeWas = (t: Team) => [...was.teams.values()].filter((x) => x === t).length;
    if (op === 0) {
      const ok = cookJoin(g, { id: who, name: `N${who}` }, rnd);
      must(ok === (!was.teams.has(who) && was.teams.size < COOKOFF_MAX), 'join: wrong answer');
      if (ok && sizeWas('red') !== sizeWas('blue')) must(g.players[g.players.length - 1].team === (sizeWas('red') < sizeWas('blue') ? 'red' : 'blue'), 'join: dealt to the bigger side');
    } else if (op === 1) {
      const ok = cookStart(g, who, now);
      must(ok === (was.phase === 'lobby' && was.teams.has(who) && was.teams.size >= COOKOFF_MIN), 'start: wrong answer');
      if (ok) {
        stats.pureContests++;
        score = { red: 0, blue: 0 };
        pts = new Map();
        must(Math.abs(teamSize(g, 'red') - teamSize(g, 'blue')) <= 1 && g.until === now + COUNTDOWN_MS && g.feed.length === 0, 'start: lopsided or with leftovers');
      }
    } else if (op === 2) {
      const ok = cookSwitch(g, who);
      must(!ok || (was.phase === 'lobby' && Math.abs(teamSize(g, 'red') - teamSize(g, 'blue')) <= 1), 'a switch that should have been refused');
    } else if (op === 3 && chance(r, 0.15)) {
      const side = pick(r, SIDES);
      const gone = chance(r, 0.25) ? g.players.filter((p) => p.team === side).map((p) => p.id) : [who];
      for (const id of gone) {
        const phase = g.phase;
        const team = g.players.find((p) => p.id === id)?.team;
        const lastOne = !!team && teamSize(g, team) === 1;
        const out = cookLeave(g, id);
        must((out !== null) === !!team, 'leave: wrong answer');
        // They take their own tally with them (the side keeps the points); back again, they start from nothing.
        pts.delete(id);
        if (out?.ended) {
          stats.pureForfeits++;
          must(phase === 'play' && lastOne && g.players.length > 0 && g.phase === 'lobby', 'leave: a forfeit that should not be');
          judgeResult(out.ended, score, g.players, opp(team!), 'leave');
        } else if (phase !== 'lobby' && lastOne) must(g.phase === 'lobby' && g.last === null, 'leave: an empty side but the contest goes on');
        else must(g.phase === phase, 'leave: the contest stopped for nothing');
        check('leave');
      }
    } else if (op < 14) {
      // A dish is served: by anyone, of anything, at any moment (also between the clock running out and the tick).
      if (chance(r, 0.1)) now += pick(r, [1, 50, 99]);
      const team = was.teams.get(who);
      const wanted = team && g.order[team]?.dish;
      const dish = wanted && chance(r, 0.4) ? wanted : chance(r, 0.85) ? pick(r, DISHES) : pick(r, ['Mystery Plate', '', 'burger', null, undefined, NaN, 7, {}]);
      const o = team ? g.order[team] : null;
      const ok = !!team && g.phase === 'play' && now < g.until && typeof dish === 'string' && dish !== '';
      const bonus = ok && !!o && o.dish === dish && now < o.until;
      const s = cookServe(g, who, dish as string, now, rnd);
      must((s !== null) === ok, `serve of ${String(dish)} by ${who} in the ${g.phase} was ${JSON.stringify(s)}`);
      if (s) {
        stats.pureServes++;
        const gained = worth(dish as string) * (bonus ? 2 : 1);
        must(dishPoints(dish as string) === worth(dish as string), 'the recipe arithmetic disagrees');
        must(s.pts === gained && s.bonus === bonus && s.team === team && g.feed[g.feed.length - 1] === s, `serve: ${JSON.stringify(s)}, expected ${gained}`);
        score[team!] += gained;
        pts.set(who, (pts.get(who) ?? 0) + gained);
        if (bonus) {
          stats.pureBonuses++;
          must(g.order[team!]!.dish !== dish && g.order[team!]!.until === now + ORDER_MS, 'a filled order was not swapped');
          // The same dish again straight away is worth single points: the double applies once.
          const again = cookServe(g, who, dish as string, now, rnd)!;
          must(again && !again.bonus && again.pts === worth(dish as string), 'the double was given twice');
          score[team!] += again.pts;
          pts.set(who, pts.get(who)! + again.pts);
        }
      } else stats.pureIgnored++;
    } else {
      now += chance(r, 0.03) ? pick(r, [0, 1, 2999, 3000, 44_900, 45_000, 60_000, ROUND_MS, 1e7]) : 100;
      const t = cookTick(g, now, rnd);
      if (was.phase === 'lobby') must(!t.changed && !t.ended && !t.go, 'tick: something happened in the lobby');
      else if (was.phase === 'countdown') must(!!t.go === now >= was.until && !t.ended && (!t.go || (g.phase === 'play' && g.until === now + ROUND_MS)), 'tick: the countdown ended wrongly');
      else if (now >= was.until) {
        stats.pureFullTime++;
        must(t.ended && g.phase === 'lobby' && g.last === t.ended, 'tick: time is up but the round goes on');
        judgeResult(t.ended, score, g.players, null, 'tick');
      } else {
        must(!t.ended && g.phase === 'play', 'tick: the round ended early');
        for (const side of SIDES) {
          const [a, b] = [was.order[side]!, g.order[side]!];
          if (now < a.until) must(b.dish === a.dish && b.until === a.until, `tick: ${side}'s order changed early`);
          else must(t.changed && b.dish !== a.dish && b.until === now + ORDER_MS, `tick: ${side}'s stale order was not swapped`);
        }
      }
    }
    check(`op ${op}`);
  }
  // However it was left, enough time always ends it.
  for (let i = 0; i < 2 && g.phase !== 'lobby'; i++) cookTick(g, (now += ROUND_MS), rnd);
  must(g.phase === 'lobby', `stuck in ${g.phase}`);
}

afterAll(() => {
  vi.restoreAllMocks();
  console.log(`cookoff sim: ${JSON.stringify(stats)}`);
});

test(`cookoff server: ${RUNS} seeded sessions in a simulated room`, { timeout: 3_600_000 }, () => {
  seeded('cookoff server sim', serverSim);
  expect(stats.sims).toBe(RUNS);
  if (RUNS >= 200) {
    for (const k of ['fullTime', 'draws', 'forfeits', 'calledOff', 'bonuses', 'ignored', 'swaps'] as const) expect(stats[k], k).toBeGreaterThan(0);
    expect(stats.fullTime + stats.draws).toBeGreaterThan(RUNS / 4);
  }
});

test(`cookoff rules: ${RUNS} seeded sessions`, { timeout: 3_600_000 }, () => {
  seeded('cookoff rules sim', rulesSim);
  if (RUNS >= 200) expect(stats.pureFullTime).toBeGreaterThan(RUNS / 4);
});
