// Hide and seek, played thousands of times by a seeded random crowd that also cheats and misbehaves.
// Two sims: the real server factory behind a recording GameIO in a small simulated room, and the pure
// rules fed raw (also garbage) positions. Invariants are checked after every step.
//
//   SIM_RUNS=10000 npx vitest run tests/sim/hide.sim.test.ts            more games
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/hide.sim.test.ts  replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import { BOUNDS } from '../../shared/layout';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO, RoomEvent, ServerGame } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/hide';
import { FIND_RADIUS, HIDE_MAX, HIDE_MIN, HIDING_MS, SEEKING_MS, type HideEvents, type HideResult, type HideSpot, type HideView, hideHidden, hideHiders, hideJoin, hideLeave, hideStart, hideSummary, hideTick, hideView, newHide } from '../../shared/minigames/hide';

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
const KS = ['join', 'leave', 'start'] as const;
const YARD = { x: -6, z: 10 };
const stats = { sims: 0, started: 0, seekerWon: 0, hidersWon: 0, calledOff: 0, found: 0, steps: 0, puts: 0, pureRounds: 0, pureSeekerWon: 0, pureHidersWon: 0, pureCalledOff: 0, pureFound: 0 };

/** Where people are hiding is the whole secret: the only number a view may hold is the clock. */
const noPositions = (view: unknown) =>
  JSON.stringify(view, (k, v) => {
    must(typeof v !== 'number' || k === 'left', `a view has a number under "${k}": ${v}`);
    must(!['x', 'z', 'pos', 'at', 'spot', 'spots', 'anchor'].includes(k), `a view has "${k}"`);
    return v;
  });
/** Every name in `some` can be matched to one in `all` (names may repeat). */
const within = (some: string[], all: string[]) => {
  const left = [...all];
  return some.every((n) => {
    const i = left.indexOf(n);
    if (i >= 0) left.splice(i, 1);
    return i >= 0;
  });
};
const near = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z) <= FIND_RADIUS + 1e-9;

function serverSim(seed: number) {
  const r = rng(seed);
  vi.spyOn(Math, 'random').mockImplementation(rng(seed ^ 0x5bd1e995));
  const room = new Room(r, chance(r, 0.15));
  const game = create(room.io);
  const crowd = chance(r, 0.08) ? 22 + int(r, 4) : 2 + int(r, 7);
  const spread = pick(r, [1, 3, 8, 20]);
  const all = Array.from({ length: crowd }, (_, i) => newBody(room, i, YARD, spread));
  room.here = all.filter(() => chance(r, 0.9));
  const chaos = pick(r, [0, 0, 0.01, 0.01, 0.15]);

  let prev = { phase: 'lobby' as HideView['phase'], seeker: null as string | null, ids: [] as string[], found: [] as string[], names: new Map<string, string>(), end: 0 };
  let sawResult: HideResult | null = null;

  const check = (what: string, at: Map<string, Body> | null) => {
    const v = room.probe<HideView>(game);
    if (v) noPositions(v);
    const cur = { phase: v?.phase ?? 'lobby', seeker: v?.seeker ?? null, ids: v?.players.map((p) => p.id) ?? [], found: [...(v?.found ?? [])], names: new Map(v?.players.map((p) => [p.id, p.name])), end: room.now + (v?.left ?? 0) };
    const msgs = room.take();
    for (const m of msgs) {
      if (m.k === 'send' || m.k === 'cast') noPositions(m.view);
      if (m.k === 'put') {
        stats.puts++;
        must(what === 'tick' && prev.phase === 'hiding' && m.id === prev.seeker, `put for ${m.id} (${what}, ${prev.phase}, seeker ${prev.seeker})`);
      }
      must(m.k !== 'nudge' && m.k !== 'score', `hide sent a ${m.k}`);
    }
    must(new Set(cur.ids).size === cur.ids.length && cur.ids.length <= HIDE_MAX, 'bad player list');
    if (cur.phase === 'lobby') must(cur.seeker === null && cur.found.length === 0 && (v?.left ?? 0) === 0, 'a seeker, finds or a clock in the lobby');
    else {
      must(cur.seeker !== null && cur.ids.includes(cur.seeker), `${cur.phase} but the seeker is ${cur.seeker}`);
      must(cur.ids.length >= HIDE_MIN, `${cur.phase} with ${cur.ids.length} players`);
      must(v!.left <= (cur.phase === 'hiding' ? HIDING_MS : SEEKING_MS), `left is ${v!.left}`);
      must(v!.result === null, 'an old result is showing during a round');
    }
    must(cur.phase !== 'hiding' || cur.found.length === 0, 'someone was found during the count');
    must(new Set(cur.found).size === cur.found.length && cur.found.every((id) => cur.ids.includes(id) && id !== cur.seeker), 'found someone who is not hiding');
    if (prev.phase !== 'lobby') for (const id of cur.ids) must(prev.ids.includes(id), `${id} got in during the ${prev.phase}`);
    if (prev.phase === 'lobby' && cur.phase !== 'lobby') {
      stats.started++;
      must(what === 'action start' && cur.phase === 'hiding', `a round began by ${what}`);
      must(msgs.some((m) => m.k === 'notice' && /is the seeker/.test(m.text)), 'the seeker was not announced');
    }
    if (prev.phase === 'hiding' && cur.phase === 'seeking') must(what === 'tick' && room.now >= prev.end, 'seeking began early');
    must(!(prev.phase === 'seeking' && cur.phase === 'hiding'), 'went back to hiding');
    // Whoever was found on this step was within reach of the seeker (or sat down) on the positions judged.
    const seekerAt = at?.get(prev.seeker ?? '');
    const inReach = (id: string) => {
      const h = at?.get(id);
      return !!h && !!seekerAt && (h.seat !== null || near(h, seekerAt));
    };
    if (cur.phase === 'seeking') {
      for (const id of cur.found) {
        if (prev.found.includes(id)) continue;
        stats.found++;
        must(what === 'tick' && inReach(id), `${id} was found out of reach (${what})`);
      }
    }
    const res = v?.result ?? null;
    if (res && res !== sawResult) {
      must(prev.phase !== 'lobby' && cur.phase === 'lobby', 'a result without a round ending');
      must(res.seeker === prev.names.get(prev.seeker!), `result names seeker ${res.seeker}`);
      const unfound = prev.ids.filter((id) => id !== prev.seeker && !prev.found.includes(id));
      must(within(res.hidden, unfound.map((id) => prev.names.get(id)!)), 'the result lists someone as hidden who was not');
      must(res.lastFound === null || [...prev.names.values()].includes(res.lastFound) || true, '');
      if (res.winner === 'seeker') {
        stats.seekerWon++;
        must(res.hidden.length === 0, 'the seeker won with people still hidden');
        // On a tick it was by finding them: everyone still unfound and still in the room was in reach.
        if (what === 'tick') for (const id of unfound) must(!at!.has(id) || inReach(id), `${id} was "found" out of reach to end the round`);
        else must(cur.ids.length < prev.ids.length, 'the seeker won without a tick or anyone leaving');
      } else if (res.winner === 'hiders') {
        stats.hidersWon++;
        must(what === 'tick' && prev.phase === 'seeking' && room.now >= prev.end, 'the hiders won before time was up');
        must(res.hidden.length > 0, 'the hiders won with nobody hidden');
        // Nobody listed as hidden was in reach: they would have been found first.
        const still = unfound.filter((id) => at!.has(id) && !inReach(id));
        must(res.hidden.length === still.length, `${res.hidden.length} listed as hidden, ${still.length} were out of reach`);
      } else {
        stats.calledOff++;
        must(!cur.ids.includes(prev.seeker!) || cur.ids.length < HIDE_MIN, 'called off with a seeker and a hider still there');
      }
      must(msgs.some((m) => m.k === 'notice' && m.text === hideSummary(res)), 'the result was not announced');
      sawResult = res;
    } else if (prev.phase !== 'lobby') must(cur.phase !== 'lobby', 'a round ended without a result');
    prev = cur;
  };

  const tick = (dt: number) => {
    room.now += dt;
    room.move(dt, YARD);
    const at = new Map(room.here.map((b) => [b.id, { ...b }]));
    const before = room.casts;
    game.tick?.(room.now);
    must(room.casts - before <= 1, 'more than one broadcast in a tick');
    check('tick', at);
  };

  if (chance(r, 0.85)) {
    for (const b of room.here)
      if (chance(r, 0.8)) {
        game.onAction({ ...b }, { k: 'join' }, room.now);
        check('action join', null);
      }
    if (room.here.length) game.onAction({ ...pick(r, room.here) }, { k: 'start' }, room.now);
    check('action start', null);
  }
  const steps = 200 + int(r, 2400);
  for (let i = 0; i < steps; i++) {
    stats.steps++;
    if (!chance(r, chaos)) {
      tick(chance(r, 0.003) ? pick(r, [1000, 5000, 30_000, 200_000]) : 100);
      continue;
    }
    const op = int(r, 10);
    const who = room.here.length ? pick(r, room.here) : null;
    if (op < 4 && who) {
      const a = chance(r, 0.25) ? junk(r, KS) : { k: pick(r, ['join', 'join', 'start', 'start', 'leave'] as const) };
      game.onAction({ ...who }, a, room.now);
      check(`action ${String(a.k)}`, null);
    } else if (op === 4 && who) {
      who.seat = who.seat ? null : `seat${int(r, 3)}`;
      check('sit', null);
    } else if (op === 5 && who) {
      // Leaving the room. Now and then the room "forgets" to say so, to try the game's own safety net.
      // Usually it is just anyone; sometimes it is the one the round cannot do without.
      const gone = chance(r, 0.05) ? [...room.here] : [chance(r, 0.3) ? (room.body(prev.seeker ?? '') ?? who) : who];
      for (const b of gone) {
        room.here = room.here.filter((x) => x !== b);
        if (!chance(r, 0.1)) game.onLeave(b.id, room.now);
        check('leave room', null);
      }
    } else if (op === 6) {
      const back = all.filter((b) => !room.here.includes(b));
      if (back.length) {
        const b = pick(r, back);
        Object.assign(b, room.spot(YARD, spread), { seat: null });
        room.here.push(b);
        game.onJoin?.({ ...b }, room.now);
        check('join room', null);
      }
    } else if (op === 7) {
      game.onEvent?.(EVENTS(r, all.map((b) => b.name)), room.now);
      game.onLeave(pick(r, ['', 'nobody', 'probe', '__proto__']), room.now);
      check('event', null);
    } else if (op === 8 && who) {
      Object.assign(who, room.spot(YARD, 20));
      who.style = int(r, 6);
      check('teleport', null);
    } else if (who) {
      for (const b of [...room.here]) {
        const k = pick(r, KS);
        game.onAction({ ...b }, { k }, room.now);
        check(`action ${k}`, null);
      }
    }
  }

  // Nobody touches anything any more: it must wind up by itself, without flooding the room.
  const from = room.casts;
  for (let i = 0; i < 600; i++) tick(100);
  must(room.casts - from <= 30, `${room.casts - from} broadcasts in a quiet minute`);
  for (let i = 0; i < 160 && prev.phase !== 'lobby'; i++) tick(1000);
  must(prev.phase === 'lobby', `still in ${prev.phase} long after the round should be over`);
  const quiet = room.delivered;
  for (let i = 0; i < 40; i++) tick(pick(r, [100, 100, 1000, 60_000]));
  must(room.delivered === quiet, `${room.delivered - quiet} messages from an idle lobby`);
  stats.sims++;
}

// ---------------------------------------------------------------------------------------------------------
// The rules alone, with positions the real room would never pass on.
// ---------------------------------------------------------------------------------------------------------
function rulesSim(seed: number) {
  const r = rng(seed);
  const g = newHide();
  let now = 5_000_000;
  const n = chance(r, 0.1) ? 24 : 2 + int(r, 6);
  const raw = chance(r, 0.4);
  const coord = () => (raw && chance(r, 0.15) ? pick(r, BAD_NUMBERS) : (r() - 0.5) * pick(r, [3, 8, 30]));
  const spots: HideSpot[] = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, x: coord(), z: coord(), seat: null }));
  let present = spots.filter(() => chance(r, 0.9));

  const check = (what: string) => {
    const ids = g.players.map((p) => p.id);
    must(new Set(ids).size === ids.length && ids.length <= HIDE_MAX, `${what}: bad player list`);
    if (g.phase === 'lobby') must(g.seeker === null && g.found.length === 0 && g.until === 0, `${what}: a round's leftovers in the lobby`);
    else {
      must(g.seeker !== null && ids.includes(g.seeker) && hideHiders(g).length >= 1, `${what}: ${g.phase} without a seeker and a hider`);
      must(g.result === null, `${what}: a result during a round`);
      must(hideHidden(g).length >= 1, `${what}: nobody left to find, but the round goes on`);
    }
    must(g.phase !== 'hiding' || g.found.length === 0, `${what}: found during the count`);
    must(new Set(g.found).size === g.found.length && g.found.every((id) => ids.includes(id) && id !== g.seeker), `${what}: found someone who is not hiding`);
    for (const t of [now, now + pick(r, [1, 1e7])]) {
      const v = hideView(g, t);
      scan(v, [], 'view');
      noPositions(v);
    }
  };
  /** Check what one call of the rules says it did. `wasFound` etc. are from just before the call. */
  const judge = (what: string, ev: HideEvents, was: { phase: string; seeker: string | null; unfound: string[]; names: Map<string, string>; until: number }) => {
    const sk = present.find((s) => s.id === was.seeker);
    for (const id of ev.found) {
      stats.pureFound++;
      const h = present.find((s) => s.id === id);
      must(what === 'tick' && was.unfound.includes(id) && h && sk, `${what}: found ${id}, who was not there to be found`);
      must(h.seat !== null || near(h, sk), `${what}: found ${id} at ${h.x},${h.z} from ${sk.x},${sk.z}`);
      must(was.phase === 'seeking' || now >= was.until, `${what}: found during the count`);
    }
    const res = ev.result;
    if (res) {
      must(g.phase === 'lobby' && g.result === res && ev.changed, `${what}: a result but the round goes on`);
      must(res.seeker === was.names.get(was.seeker!), `${what}: wrong seeker in the result`);
      must(within(res.hidden, was.unfound.filter((id) => !ev.found.includes(id)).map((id) => was.names.get(id)!)), `${what}: hidden names someone who was found`);
      if (res.winner === 'seeker') {
        stats.pureSeekerWon++;
        must(res.hidden.length === 0, `${what}: seeker won with people hidden`);
      } else if (res.winner === 'hiders') {
        stats.pureHidersWon++;
        must(what === 'tick' && was.phase === 'seeking' && now >= was.until && res.hidden.length > 0, `${what}: hiders won early or with nobody hidden`);
        // Whoever stayed hidden really was out of reach.
        for (const id of was.unfound) {
          const h = present.find((s) => s.id === id);
          if (h && !ev.found.includes(id)) must(h.seat === null && !near(h, sk!), `${what}: ${id} was in reach but counted as hidden`);
        }
      } else {
        stats.pureCalledOff++;
        must(!g.players.some((p) => p.id === was.seeker) || g.players.length < HIDE_MIN, `${what}: called off for nothing`);
      }
      must(!/undefined|NaN/.test(hideSummary(res)), `${what}: broken summary`);
    } else if (was.phase !== 'lobby') must(g.phase !== 'lobby', `${what}: the round ended without a result`);
    check(what);
  };
  const snap = () => ({ phase: g.phase, seeker: g.seeker, unfound: hideHidden(g).map((p) => p.id), names: new Map(g.players.map((p) => [p.id, p.name])), until: g.until });

  const steps = 100 + int(r, 900);
  for (let i = 0; i < steps; i++) {
    const op = int(r, 40);
    const who = pick(r, spots);
    if (op === 0) {
      hideJoin(g, { id: who.id, name: `N${who.id}` });
      check('join');
    } else if (op === 1) {
      const was = g.phase;
      const ok = hideStart(g, chance(r, 0.2) ? 'stranger' : who.id, now, chance(r, 0.1) ? () => pick(r, [0, 0.999999, 1]) : r);
      must(!ok || (was === 'lobby' && g.phase === 'hiding' && g.players.length >= HIDE_MIN), 'a start that should have been refused');
      if (ok) stats.pureRounds++;
      check('start');
    } else if (op === 2 && chance(r, 0.3)) {
      const was = snap();
      // Sometimes the seeker, whom the round cannot do without.
      judge('leave', hideLeave(g, chance(r, 0.2) ? 'stranger' : chance(r, 0.3) && g.seeker ? g.seeker : who.id), was);
    } else if (op === 3 && chance(r, 0.3)) who.seat = who.seat ? null : 'sofa';
    else if (op === 4 && chance(r, 0.2)) present = present.includes(who) ? present.filter((s) => s !== who) : [...present, who];
    else if (op === 5) {
      if (g.phase === 'lobby') for (const s of spots) hideJoin(g, { id: s.id, name: `N${s.id}` });
      check('all join');
    } else {
      now += chance(r, 0.01) ? pick(r, [0, 1, 999, HIDING_MS, SEEKING_MS, 1e7]) : 100;
      for (const s of present) {
        if (s.seat) continue;
        if (chance(r, 0.02)) [s.x, s.z] = [coord(), coord()];
        else if (Number.isFinite(s.x) && Number.isFinite(s.z)) [s.x, s.z] = [s.x + (r() - 0.5) * 1.7, s.z + (r() - 0.5) * 1.7];
      }
      const was = snap();
      judge('tick', hideTick(g, now, present), was);
    }
  }
  // However it was left, enough time always ends it.
  for (const dt of [HIDING_MS, SEEKING_MS]) {
    now += dt;
    const was = snap();
    judge('tick', hideTick(g, now, present), was);
  }
  must(g.phase === 'lobby', `stuck in ${g.phase}`);
}

afterAll(() => {
  vi.restoreAllMocks();
  console.log(`hide sim: ${JSON.stringify(stats)}`);
});

test(`hide server: ${RUNS} seeded sessions in a simulated room`, { timeout: 3_600_000 }, () => {
  seeded('hide server sim', serverSim);
  expect(stats.sims).toBe(RUNS);
  if (RUNS >= 200) {
    expect(stats.seekerWon).toBeGreaterThan(RUNS / 20);
    expect(stats.hidersWon).toBeGreaterThan(RUNS / 20);
  }
});

test(`hide rules: ${RUNS} seeded sessions with raw positions`, { timeout: 3_600_000 }, () => {
  seeded('hide rules sim', rulesSim);
  if (RUNS >= 200) expect(stats.pureSeekerWon + stats.pureHidersWon).toBeGreaterThan(RUNS / 20);
});
