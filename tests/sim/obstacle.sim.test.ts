// Obstacle dash, run thousands of times by a seeded random crowd that also cheats and misbehaves.
// Two sims: the real server factory behind a recording GameIO in a small simulated room, and the pure
// rules (and the barrier arithmetic) fed raw, also garbage, values. Invariants are checked after every step.
//
//   SIM_RUNS=10000 npx vitest run tests/sim/obstacle.sim.test.ts            more sessions
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/obstacle.sim.test.ts  replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import { BOUNDS } from '../../shared/layout';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO, RoomEvent, ServerGame } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/obstacle';
import {
  BARRIERS, BOARD_SIZE, BODY, COUNTDOWN_MS, FALSE_START, FINISH_SLACK, FINISH_X, LANE, MAX_RUN_MS, MID_Z, MIN_RUN_MS, START_X,
  type ObstacleEnd, type ObstacleView, barrierAt, barrierHit, fmtTime, inLane, newObstacle, obstacleFinish, obstacleStart, obstacleStop, obstacleTick, obstacleView,
} from '../../shared/minigames/obstacle';

/** Read without Node's types, which this project does not load. */
const ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(ENV.SIM_RUNS) || 2500;
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
const KS = ['run', 'finish', 'stop'] as const;
const END = { x: FINISH_X + 0.4, z: MID_Z };
const stats = { sims: 0, runs: 0, finishes: 0, records: 0, tooFast: 0, falseStarts: 0, timeouts: 0, left: 0, stopped: 0, refused: 0, steps: 0, pureRuns: 0, pureFinishes: 0, pureTooFast: 0, pureFalseStarts: 0, pureTimeouts: 0, pureLeft: 0, barrierChecks: 0 };
type Board = { name: string; ms: number }[];
type Where = { x: number; z: number; seat?: string | null } | null | undefined;
const atEastEnd = (p: Where) => !!p && p.x >= FINISH_X - FINISH_SLACK && inLane(p.x, p.z);

/** The board's own rule, written again here: one best time per name, fastest first, five at most. */
const record = (board: Board, name: string, ms: number): Board => {
  const old = board.find((b) => b.name === name);
  return old && old.ms <= ms ? board : [...board.filter((b) => b !== old), { name, ms }].sort((a, b) => a.ms - b.ms).slice(0, BOARD_SIZE);
};
function judgeBoard(best: Board, why: string) {
  must(best.length <= BOARD_SIZE && new Set(best.map((b) => b.name)).size === best.length, `${why}: the board has ${best.length} entries or a name twice`);
  best.forEach((b, i) => {
    must(Number.isInteger(b.ms) && b.ms >= MIN_RUN_MS && b.ms <= MAX_RUN_MS, `${why}: a time of ${b.ms} on the board`);
    must(i === 0 || best[i - 1].ms <= b.ms, `${why}: the board is not in order`);
  });
}
/**
 * How a run ended, against what the test itself knows: when its clock started, where the runner really
 * is, and how. `first` is whether the false-start check was still to come.
 */
function judgeEnd(end: ObstacleEnd, run: { go: number; first: boolean }, pos: Where, now: number, how: string) {
  const t = now - run.go;
  if (end.why === 'finish' || end.why === 'too-fast') {
    // Only at the east end, only once the clock is running, and timed by the server's clock alone.
    must(t >= 0 && atEastEnd(pos), `${end.why} at ${pos?.x},${pos?.z}, ${t} ms after go`);
    must(how !== 'tick' || (pos!.x >= FINISH_X && !pos!.seat), `the referee finished someone at x=${pos?.x}`);
    if (end.why === 'finish') must(end.ms === Math.round(t) && end.ms >= MIN_RUN_MS && end.ms <= MAX_RUN_MS + 1000, `a time of ${end.ms} for ${t} ms`);
    else must(Math.round(t) < MIN_RUN_MS, `"too fast" after ${t} ms`);
  } else if (end.why === 'stop') must(how === 'action stop', `"stop" by ${how}`);
  else {
    must(how === 'tick', `"${end.why}" by ${how}`);
    if (end.why === 'false-start') must(t >= 0 && run.first && pos && pos.x > START_X + FALSE_START, `false start at x=${pos?.x}, ${t} ms after go`);
    else if (end.why === 'timeout') must(t > MAX_RUN_MS, `timeout after ${t} ms`);
    else must(!pos || (t >= 0 && (!!pos.seat || !inLane(pos.x, pos.z))), `"left" at ${pos?.x},${pos?.z}, ${t} ms after go`);
  }
}
/** A run the referee looked at and let carry on must really be under way. */
function judgeStill(run: { go: number }, pos: Where, now: number) {
  if (now < run.go) return must(pos, 'a run goes on for someone who has gone');
  must(pos && !pos.seat && inLane(pos.x, pos.z), `a run goes on at ${pos?.x},${pos?.z} (seat ${pos?.seat})`);
  must(now - run.go <= MAX_RUN_MS, `a run goes on ${now - run.go} ms after go`);
  must(pos.x < FINISH_X, `a run goes on past the finish line, at x=${pos.x}`);
}

function serverSim(seed: number) {
  const r = rng(seed);
  vi.spyOn(Math, 'random').mockImplementation(rng(seed ^ 0x5bd1e995));
  const room = new Room(r, chance(r, 0.15), ['t']);
  const game = create(room.io);
  const crowd = 1 + int(r, 7);
  const all = Array.from({ length: crowd }, (_, i) => newBody(room, i, END, 6));
  // Two people may share a name: the board is kept by name.
  if (crowd > 2 && chance(r, 0.3)) all[1].name = all[0].name;
  room.here = all.filter(() => chance(r, 0.9));
  const chaos = pick(r, [0.005, 0.02, 0.02, 0.15]);
  /** How keen people are to run again. */
  const keen = pick(r, [0.002, 0.01, 0.05]);

  /** Runs the server agreed to start, as the test understands them. */
  const runs = new Map<string, { go: number; name: string; first: boolean; speed: number }>();
  let board: Board = [];

  const check = (what: string, actor: string | null) => {
    const msgs = room.take();
    let records = 0;
    for (const m of msgs) {
      must(m.k !== 'nudge' && m.k !== 'score', `obstacle sent a ${m.k}`);
      if (m.k === 'put') must(what === 'action run' && m.id === actor && m.x === START_X && m.z === MID_Z, `put ${m.id} to ${m.x},${m.z} (${what})`);
      if (m.k !== 'send') continue;
      const v = m.view as ObstacleView;
      if (v.start) {
        must(what === 'action run' && m.id === actor && v.start.t === -COUNTDOWN_MS, `a start for ${m.id} (${what})`);
        const b = room.body(m.id)!;
        must(!b.seat && !runs.has(m.id), `a run began for ${m.id}, who is seated or already running`);
        stats.runs++;
        runs.set(m.id, { go: room.now + COUNTDOWN_MS, name: b.name, first: true, speed: pick(r, [2, 4, 6, 8.5, 8.5, 20]) });
      }
      if (v.end) {
        const run = runs.get(m.id);
        must(run, `a run ended for ${m.id}, who was not running`);
        judgeEnd(v.end, run, room.body(m.id), room.now, what);
        runs.delete(m.id);
        const end = v.end;
        if (end.why === 'finish') {
          stats.finishes++;
          const next = record(board, run.name, end.ms);
          const rank = next === board ? 0 : next.findIndex((b) => b.name === run.name && b.ms === end.ms) + 1;
          must(end.rank === rank && end.record === (rank === 1), `rank ${end.rank} (record ${end.record}), expected ${rank}`);
          must(!end.record || msgs.some((x) => x.k === 'notice' && x.text.includes(fmtTime(end.ms))), 'a record was not announced with its time');
          if (end.record) records++;
          board = next;
        } else {
          stats[({ 'too-fast': 'tooFast', 'false-start': 'falseStarts', timeout: 'timeouts', left: 'left', stop: 'stopped' } as const)[end.why]]++;
        }
      }
    }
    // Only a new best of all is announced (several runs can end on one tick).
    must(msgs.filter((m) => m.k === 'notice').length === records, `${records} records but ${msgs.filter((m) => m.k === 'notice').length} announcements`);
    stats.records += records;
    // The public view is exactly the board and who is running; a board only ever changes by a finish.
    const v = room.probe<ObstacleView>(game);
    must(JSON.stringify(v?.best ?? []) === JSON.stringify(board), `the board reads ${JSON.stringify(v?.best)}, expected ${JSON.stringify(board)}`);
    must(JSON.stringify([...(v?.runners ?? [])].sort()) === JSON.stringify([...runs.keys()].sort()), `runners ${v?.runners}, expected ${[...runs.keys()]}`);
    must(v === undefined || (!('start' in v) && !('end' in v)), 'a newcomer was sent someone else\'s start or end');
    judgeBoard(board, what);
    for (const m of msgs) if (m.k === 'cast') must(!('start' in (m.view as object)) && !('end' in (m.view as object)), 'a start or end was broadcast');
    if (what === 'tick')
      for (const [id, run] of runs) {
        judgeStill(run, room.body(id), room.now);
        if (room.now >= run.go) run.first = false;
      }
  };

  const act = (b: Body, a: Record<string, unknown>) => {
    const had = runs.has(b.id);
    game.onAction({ ...b }, a, room.now);
    check(`action ${String(a.k)}`, b.id);
    if (a.k === 'run' && !had && !runs.has(b.id)) {
      stats.refused++;
      must(!!b.seat, 'a run was refused to someone standing who was not running');
    }
    if (a.k === 'run' && !had && !b.seat) must(runs.has(b.id), 'a run did not start');
    if (a.k === 'stop' && had) must(!runs.has(b.id), 'stop did not stop the run');
  };
  const tick = (dt: number) => {
    room.now += dt;
    const held = new Map(room.here.filter((b) => b.obeys && runs.has(b.id)).map((b) => [b, { x: b.x, z: b.z }]));
    room.move(dt, END);
    // An honest runner waits for "go" and then runs east down the lane; a cheat does whatever the crowd does.
    for (const [b, at] of held) {
      const run = runs.get(b.id)!;
      const t = Math.min(dt, room.now - run.go);
      [b.x, b.z] = [at.x, at.z];
      if (b.seat || !Number.isFinite(b.x)) continue;
      if (t <= 0) {
        if (chance(r, 0.004)) b.x += 1.5 + r(); // jumps the gun
        continue;
      }
      b.x = Math.min(BOUNDS.x2, b.x + run.speed * t * 0.001 * (0.8 + 0.2 * r()));
      b.z = Math.max(LANE.z1, Math.min(LANE.z2, b.z + (r() - 0.5) * 0.4));
      if (chance(r, 0.003)) b.z += pick(r, [-4, 4]); // falls off the side
    }
    game.tick?.(room.now);
    check('tick', null);
    for (const b of room.here) {
      if (runs.has(b.id) && b.obeys && atEastEnd(b) && chance(r, 0.6)) act(b, { k: 'finish' });
      else if (!runs.has(b.id) && chance(r, keen)) act(b, { k: 'run' });
    }
  };

  const steps = 300 + int(r, 1500);
  for (let i = 0; i < steps; i++) {
    stats.steps++;
    if (!chance(r, chaos)) {
      tick(chance(r, 0.003) ? pick(r, [1000, 5000, 30_000, 200_000]) : 100);
      continue;
    }
    const op = int(r, 10);
    const who = room.here.length ? pick(r, room.here) : null;
    if (op < 4 && who) act(who, chance(r, 0.25) ? junk(r, KS) : { k: pick(r, KS) });
    else if (op === 4 && who) {
      who.seat = who.seat ? null : `seat${int(r, 3)}`;
      check('sit', null);
    } else if (op === 5 && who) {
      room.here = room.here.filter((b) => b !== who);
      if (!chance(r, 0.1)) {
        game.onLeave(who.id, room.now);
        // The room said so: the run is gone at once, and nobody is told how it "ended".
        runs.delete(who.id);
      }
      check('leave room', null);
    } else if (op === 6) {
      const back = all.filter((b) => !room.here.includes(b) && !runs.has(b.id));
      if (back.length) {
        const b = pick(r, back);
        Object.assign(b, room.spot(END, 6), { seat: null });
        room.here.push(b);
        game.onJoin?.({ ...b }, room.now);
        check('join room', null);
      }
    } else if (op === 7) {
      game.onEvent?.(EVENTS(r, all.map((b) => b.name)), room.now);
      game.onLeave(pick(r, ['', 'nobody', 'probe', '__proto__']), room.now);
      check('event', null);
    } else if (op === 8 && who) {
      // A cheat's browser says it is at the finish line (or anywhere else) and claims the time.
      Object.assign(who, chance(r, 0.6) ? { x: FINISH_X + r(), z: MID_Z + (r() - 0.5) * 4 } : room.spot(END, 20));
      check('teleport', null);
      if (chance(r, 0.7)) act(who, { k: 'finish', ms: 1, time: -5, x: FINISH_X, done: true });
    } else if (who) for (const b of [...room.here]) act(b, { k: pick(r, KS) });
  }

  // Nobody starts anything any more: every run still going must end by itself, without flooding the room.
  const from = room.casts;
  const going = runs.size;
  const idle = (dt: number) => {
    room.now += dt;
    room.move(dt, END);
    game.tick?.(room.now);
    check('tick', null);
  };
  for (let i = 0; i < 600; i++) idle(100);
  must(room.casts - from <= going, `${room.casts - from} broadcasts in a quiet minute with ${going} runs going`);
  for (let i = 0; i < 40 && runs.size; i++) idle(1000);
  must(runs.size === 0, `${runs.size} runs still going long after the limit`);
  const quiet = room.delivered;
  for (let i = 0; i < 40; i++) idle(pick(r, [100, 100, 1000, 60_000]));
  must(room.delivered === quiet, `${room.delivered - quiet} messages with nobody running`);
  stats.sims++;
}

// ---------------------------------------------------------------------------------------------------------
// The rules alone, with positions and times the real room would never pass on.
// ---------------------------------------------------------------------------------------------------------
/** Every barrier, at any time at all, is a box inside the lane, and both lines are clear of it. */
function barrierSim(r: Rnd) {
  const t = pick(r, [
    () => (r() - 0.5) * 200,
    () => (r() - 0.5) * 1e7,
    () => Math.round((r() - 0.5) * 1e6) / 4,
    () => pick(r, [0, -0, -COUNTDOWN_MS / 1000, MAX_RUN_MS / 1000, 1e15, -1e15, 1e308, -1e308, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE, NaN, Infinity, -Infinity]),
  ])();
  const eps = 1e-9;
  for (const b of BARRIERS) {
    stats.barrierChecks++;
    const c = barrierAt(b, t);
    must(Number.isFinite(c.x) && Number.isFinite(c.z), `barrier at ${c.x},${c.z} for t=${t}`);
    must(c.x - c.hw >= LANE.x1 - eps && c.x + c.hw <= LANE.x2 + eps && c.z - c.hd >= LANE.z1 - eps && c.z + c.hd <= LANE.z2 + eps, `barrier outside the lane at ${c.x},${c.z} for t=${t}`);
  }
  const z = LANE.z1 + r() * (LANE.z2 - LANE.z1);
  must(barrierHit(START_X, z, t) === -1 && barrierHit(FINISH_X, z, t) === -1, `a barrier on a line at t=${t}`);
  const hit = barrierHit(pick(r, [NaN, Infinity, LANE.x1 + r() * 10]), pick(r, [NaN, -Infinity, z]), t, pick(r, [BODY, 0, NaN, 5]));
  must(Number.isInteger(hit) && hit >= -1 && hit < BARRIERS.length, `barrierHit gave ${hit}`);
}

function rulesSim(seed: number) {
  const r = rng(seed);
  for (let i = 0; i < 30; i++) barrierSim(r);
  const g = newObstacle();
  let now = 5_000_000;
  const n = 1 + int(r, 6);
  const raw = chance(r, 0.4);
  const coord = (c: number, spread: number) => (raw && chance(r, 0.1) ? pick(r, BAD_NUMBERS) : c + (r() - 0.5) * spread);
  type Spot = { id: string; name: string; x: number; z: number; seat: string | null };
  const spots: Spot[] = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: chance(r, 0.2) ? pick(r, ['', 'Ann']) : `N${i}`, x: coord(START_X, 4), z: coord(MID_Z, 4), seat: null }));
  let present = [...spots];
  const where = (id: string) => present.find((s) => s.id === id);
  const mine = new Map<string, { go: number; name: string; first: boolean }>();
  let board: Board = [];

  const ended = (id: string, end: ObstacleEnd, how: string) => {
    const run = mine.get(id);
    must(run, `${how}: a run ended for ${id}, who was not running`);
    judgeEnd(end, run, where(id), now, how);
    mine.delete(id);
    if (end.why === 'finish') {
      stats.pureFinishes++;
      const next = record(board, run.name, end.ms);
      const rank = next === board ? 0 : next.findIndex((b) => b.name === run.name && b.ms === end.ms) + 1;
      must(end.rank === rank && end.record === (rank === 1), `${how}: rank ${end.rank}, expected ${rank}`);
      board = next;
    } else if (end.why === 'too-fast') stats.pureTooFast++;
    else if (end.why === 'false-start') stats.pureFalseStarts++;
    else if (end.why === 'timeout') stats.pureTimeouts++;
    else stats.pureLeft++;
  };
  const check = (what: string) => {
    must(JSON.stringify(g.best) === JSON.stringify(board), `${what}: the board reads ${JSON.stringify(g.best)}, expected ${JSON.stringify(board)}`);
    must(JSON.stringify(g.runs.map((x) => x.id).sort()) === JSON.stringify([...mine.keys()].sort()), `${what}: the runs are ${g.runs.map((x) => x.id)}, expected ${[...mine.keys()]}`);
    judgeBoard(g.best, what);
    scan(obstacleView(g), [], 'view');
  };

  const steps = 100 + int(r, 1200);
  for (let i = 0; i < steps; i++) {
    const op = int(r, 30);
    const who = pick(r, spots);
    if (op < 3) {
      const ok = obstacleStart(g, who, now);
      must(ok === (!who.seat && !mine.has(who.id)), 'start: wrong answer');
      if (ok) {
        stats.pureRuns++;
        mine.set(who.id, { go: now + COUNTDOWN_MS, name: who.name, first: true });
        if (chance(r, 0.8)) [who.x, who.z] = [START_X, MID_Z];
      }
      check('start');
    } else if (op === 3 && chance(r, 0.3)) {
      const id = chance(r, 0.2) ? 'stranger' : who.id;
      must(obstacleStop(g, id) === mine.delete(id), 'stop: wrong answer');
      check('stop');
    } else if (op < 7) {
      // "I crossed the line", from anyone, anywhere, at any time; the position passed in may be nothing.
      const pos = chance(r, 0.1) ? pick(r, [null, undefined]) : where(who.id);
      const end = obstacleFinish(g, who.id, pos, now);
      const run = mine.get(who.id);
      must((end !== null) === (!!run && now >= run.go && atEastEnd(pos)), `finish: got ${JSON.stringify(end)} at ${pos?.x},${pos?.z}`);
      if (end) {
        must(present.includes(who) || !pos, 'finish: for someone who is not there');
        judgeEnd(end, run!, pos, now, 'action finish');
        // judgeEnd above looked at `pos`; ended() looks at where they really are, which is the same or nowhere.
        if (where(who.id)) ended(who.id, end, 'action finish');
        else mine.delete(who.id), (board = g.best.map((b) => ({ ...b })));
      }
      check('finish');
    } else if (op === 7 && chance(r, 0.2)) who.seat = who.seat ? null : 'sofa';
    else if (op === 8 && chance(r, 0.1)) present = present.includes(who) ? present.filter((s) => s !== who) : [...present, who];
    else {
      now += chance(r, 0.01) ? pick(r, [0, 1, 904, 905, 906, COUNTDOWN_MS, MAX_RUN_MS, 1e7]) : 100;
      for (const s of present) {
        if (s.seat) continue;
        const run = mine.get(s.id);
        if (chance(r, 0.01)) [s.x, s.z] = [coord(pick(r, [START_X, FINISH_X]), 3), coord(MID_Z, 8)];
        else if (run && now >= run.go && Number.isFinite(s.x) && Number.isFinite(s.z)) [s.x, s.z] = [s.x + r() * 0.85, s.z + (r() - 0.5) * 0.3];
      }
      const out = obstacleTick(g, where, now);
      must(new Set(out.map((e) => e.id)).size === out.length, 'tick: a run ended twice');
      for (const e of out) ended(e.id, e.end, 'tick');
      for (const [id, run] of mine) {
        judgeStill(run, where(id), now);
        if (now >= run.go) run.first = false;
      }
      check('tick');
    }
  }
  // However it was left, enough time always ends every run.
  now += COUNTDOWN_MS + MAX_RUN_MS + 1;
  for (const e of obstacleTick(g, where, now)) ended(e.id, e.end, 'tick');
  must(g.runs.length === 0, `${g.runs.length} runs stuck`);
  check('wind up');
}

afterAll(() => {
  vi.restoreAllMocks();
  console.log(`obstacle sim: ${JSON.stringify(stats)}`);
});

test(`obstacle server: ${RUNS} seeded sessions in a simulated room`, { timeout: 3_600_000 }, () => {
  seeded('obstacle server sim', serverSim);
  expect(stats.sims).toBe(RUNS);
  if (RUNS >= 200) for (const k of ['finishes', 'records', 'tooFast', 'falseStarts', 'timeouts', 'left', 'stopped', 'refused'] as const) expect(stats[k], k).toBeGreaterThan(0);
  if (RUNS >= 200) expect(stats.finishes).toBeGreaterThan(RUNS);
});

test(`obstacle rules: ${RUNS} seeded sessions with raw positions and times`, { timeout: 3_600_000 }, () => {
  seeded('obstacle rules sim', rulesSim);
  if (RUNS >= 200) expect(stats.pureFinishes).toBeGreaterThan(RUNS / 4);
});
