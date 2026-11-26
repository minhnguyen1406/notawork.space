// Sumo ring, played thousands of times by a seeded random crowd that also cheats and misbehaves.
// Two sims: the real server factory behind a recording GameIO in a small simulated room, and the pure
// rules (and the pushing arithmetic) fed raw, also garbage, positions. Invariants are checked after every step.
//
//   SIM_RUNS=10000 npx vitest run tests/sim/sumo.sim.test.ts            more games
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/sumo.sim.test.ts  replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import { BOUNDS } from '../../shared/layout';
import { GAME_ZONES } from '../../shared/minigames';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO, RoomEvent, ServerGame } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/sumo';
import { COUNTDOWN_MS, PUSH_CAP, RESULT_MS, ROUND_MS, SUMO_BLANKS, SUMO_MAX, SUMO_MIN, SUMO_REACH, SUMO_WINS, type Mover, type SumoEvent, type SumoView, newSumo, sumoJoin, sumoLeave, sumoOutside, sumoPlaces, sumoPush, sumoPushes, sumoStart, sumoTick, sumoView } from '../../shared/minigames/sumo';

/** Read without Node's types, which this project does not load. */
const ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(ENV.SIM_RUNS) || 2000;
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
const RING = GAME_ZONES.sumo;
const fromCentre = (p: { x: number; z: number }) => Math.hypot(p.x - RING.x, p.z - RING.z);
const stats = { sims: 0, matches: 0, champions: 0, calledOff: 0, idleOff: 0, rounds: 0, timeouts: 0, nudges: 0, puts: 0, steps: 0, pureMatches: 0, pureChampions: 0, pureRounds: 0, pureTimeouts: 0, pureIdleOff: 0, pushes: 0 };

function serverSim(seed: number) {
  const r = rng(seed);
  vi.spyOn(Math, 'random').mockImplementation(rng(seed ^ 0x5bd1e995));
  const room = new Room(r, chance(r, 0.15));
  const game = create(room.io);
  const crowd = chance(r, 0.1) ? 10 + int(r, 4) : 2 + int(r, 6);
  const spread = pick(r, [0.5, 2, 4, 8]);
  const all = Array.from({ length: crowd }, (_, i) => newBody(room, i, RING, spread));
  // Wrestlers mostly head for each other or the middle; a wandering crowd would just walk out.
  for (const b of all) if (chance(r, 0.6)) b.style = pick(r, [0, 2, 2, 4, 4]);
  room.here = all.filter(() => chance(r, 0.9));
  const chaos = pick(r, [0, 0, 0.01, 0.01, 0.15]);
  /** Some crowds all sit down and stay there: the match must not go round for ever. */
  if (chance(r, 0.06)) for (const b of all) b.seat = 'bench';

  let prev = { phase: 'lobby' as SumoView['phase'], ids: [] as string[], alive: [] as string[], wins: new Map<string, number>(), round: 0, end: 0 };
  let champion: SumoView['champion'] = null;

  const check = (what: string, at: Map<string, Body> | null) => {
    const v = room.probe<SumoView>(game);
    const cur = { phase: v?.phase ?? 'lobby', ids: v?.players.map((p) => p.id) ?? [], alive: [...(v?.alive ?? [])], wins: new Map(v?.players.map((p) => [p.id, p.wins])), round: v?.round ?? prev.round, end: room.now + (v?.left ?? 0) };
    const msgs = room.take();
    const nudged = new Set<string>();
    for (const m of msgs) {
      if (m.k === 'put') {
        stats.puts++;
        must(prev.ids.includes(m.id) || cur.ids.includes(m.id), `put for ${m.id}, who is not wrestling`);
        const d = fromCentre(m);
        // Either a starting place inside the ring or a spot just outside it.
        must(d <= RING.r + 1.2 + 1e-6, `put ${d.toFixed(2)} m from the ring's centre`);
        must(inRoof(m.x, m.z), 'put off the roof');
        must(!room.body(m.id)?.seat, `${m.id} was moved while sitting down`);
      } else if (m.k === 'nudge') {
        stats.nudges++;
        must(what === 'tick' && cur.phase === 'bout' && cur.alive.includes(m.id), `nudge for ${m.id} (${what}, ${cur.phase})`);
        must(Math.hypot(m.dx, m.dz) <= PUSH_CAP + 1e-9, `a push of ${Math.hypot(m.dx, m.dz)} m`);
        must(!nudged.has(m.id), `${m.id} was pushed twice in a tick`);
        nudged.add(m.id);
      }
      must(m.k !== 'score', 'sumo set the football score');
    }
    must(new Set(cur.ids).size === cur.ids.length && cur.ids.length <= SUMO_MAX, 'bad player list');
    must(new Set(cur.alive).size === cur.alive.length && cur.alive.every((id) => cur.ids.includes(id)), 'someone in the ring who is not in the match');
    if (cur.phase === 'lobby') must(cur.alive.length === 0 && (v?.left ?? 0) === 0, 'a round left over in the lobby');
    else {
      must(cur.ids.length >= SUMO_MIN, `${cur.phase} with ${cur.ids.length} wrestlers`);
      must(v!.left <= (cur.phase === 'bout' ? ROUND_MS : cur.phase === 'countdown' ? COUNTDOWN_MS : RESULT_MS), `left is ${v!.left} in ${cur.phase}`);
      for (const [id, w] of cur.wins) must(w < SUMO_WINS, `${id} has ${w} wins and the match goes on`);
      must(v!.champion === null, 'a champion during a match');
    }
    if (cur.phase === 'countdown' || cur.phase === 'bout') must(cur.alive.length >= 2, `${cur.phase} with ${cur.alive.length} in the ring`);
    if (cur.phase === 'result') must(cur.alive.length === 0, 'someone in the ring between rounds');
    // Nobody outside the ring, sitting down or gone is still "in" after the referee has looked.
    if (what === 'tick' && cur.phase === 'bout' && at) {
      for (const id of cur.alive) {
        const p = at.get(id);
        must(p && !p.seat, `${id} is in the round but sitting or gone`);
        if (prev.phase === 'bout') must(fromCentre(p) <= RING.r, `${id} is in the round ${fromCentre(p)} m from the centre`);
      }
    }
    if (prev.phase !== 'lobby') for (const id of cur.ids) must(prev.ids.includes(id), `${id} got in during the ${prev.phase}`);
    if (prev.phase === 'lobby' && cur.phase !== 'lobby') {
      stats.matches++;
      must(what === 'action start' && cur.phase === 'countdown' && cur.round === 1, `a match began by ${what} in ${cur.phase} round ${cur.round}`);
    }
    if (cur.phase !== 'lobby' && prev.phase !== 'lobby') {
      must(cur.round === prev.round || (cur.round === prev.round + 1 && prev.phase === 'result' && cur.phase === 'countdown' && what === 'tick'), `round ${prev.round} (${prev.phase}) became round ${cur.round} (${cur.phase})`);
      // Every phase has a time limit, and a tick past it moves on.
      if (what === 'tick' && cur.round === prev.round && cur.phase === prev.phase) must(room.now < prev.end, `${cur.phase} outlasted its clock`);
      if (prev.phase === 'countdown' && cur.phase === 'bout') must(what === 'tick' && room.now >= prev.end, 'the bout began early');
      for (const [id, w] of cur.wins) must(w === prev.wins.get(id) || (w === prev.wins.get(id)! + 1 && cur.phase === 'result'), `${id}'s wins went from ${prev.wins.get(id)} to ${w}`);
      if (prev.phase !== 'result' && cur.phase === 'result') {
        stats.rounds++;
        if (prev.phase === 'bout' && what === 'tick' && room.now >= prev.end) stats.timeouts++;
        must([...cur.wins].filter(([id, w]) => w !== prev.wins.get(id)).length <= 1, 'two winners of one round');
      }
    }
    if (prev.phase !== 'lobby' && cur.phase === 'lobby') {
      const said = msgs.filter((m) => m.k === 'notice').map((m) => (m as { text: string }).text);
      if (v?.champion && v.champion !== champion) {
        // The match ends exactly when someone reaches the stated number of wins.
        stats.champions++;
        stats.rounds++;
        must(cur.wins.get(v.champion.id) === SUMO_WINS && prev.wins.get(v.champion.id) === SUMO_WINS - 1, `champion with ${cur.wins.get(v.champion.id)} wins`);
        must(said.some((t) => /won the sumo match/.test(t)), 'the champion was not announced');
      } else {
        stats.calledOff++;
        must(said.some((t) => /called off/.test(t)), 'a match stopped without a word');
        if (cur.ids.length >= SUMO_MIN) {
          stats.idleOff++;
          must(said.some((t) => /nobody is wrestling/.test(t)), 'called off with enough wrestlers and no reason given');
        }
      }
    }
    champion = v?.champion ?? (v ? null : champion);
    prev = cur;
  };

  const tick = (dt: number) => {
    room.now += dt;
    room.move(dt, RING);
    const at = new Map(room.here.map((b) => [b.id, { ...b }]));
    const before = room.casts;
    game.tick?.(room.now);
    must(room.casts - before <= 1, 'more than one broadcast in a tick');
    check('tick', at);
  };

  if (chance(r, 0.9)) {
    for (const b of room.here)
      if (chance(r, 0.8)) {
        game.onAction({ ...b }, { k: 'join' }, room.now);
        check('action join', null);
      }
    if (room.here.length) game.onAction({ ...pick(r, room.here) }, { k: 'start' }, room.now);
    check('action start', null);
  }
  const steps = 200 + int(r, 1500);
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
      // Leaving the room: anyone, or one of the last wrestlers standing. Now and then the room "forgets" to say so.
      const gone = chance(r, 0.05) ? [...room.here] : [chance(r, 0.4) && prev.alive.length ? (room.body(pick(r, prev.alive)) ?? who) : who];
      for (const b of gone) {
        room.here = room.here.filter((x) => x !== b);
        if (!chance(r, 0.1)) game.onLeave(b.id, room.now);
        check('leave room', null);
      }
    } else if (op === 6) {
      const back = all.filter((b) => !room.here.includes(b));
      if (back.length) {
        const b = pick(r, back);
        Object.assign(b, room.spot(RING, spread), { seat: null });
        room.here.push(b);
        game.onJoin?.({ ...b }, room.now);
        check('join room', null);
      }
    } else if (op === 7) {
      game.onEvent?.(EVENTS(r, all.map((b) => b.name)), room.now);
      game.onLeave(pick(r, ['', 'nobody', 'probe', '__proto__']), room.now);
      check('event', null);
    } else if (op === 8 && who) {
      // A cheat's browser says it is somewhere else; sometimes exactly where another wrestler is.
      const on = pick(r, room.here);
      Object.assign(who, chance(r, 0.4) ? { x: on.x, z: on.z } : room.spot(RING, 20));
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
  const sent = room.delivered;
  for (let i = 0; i < 600; i++) tick(100);
  must(room.casts - from <= 60, `${room.casts - from} broadcasts in a quiet minute`);
  // At the very most: every wrestler shoved on every tick, the views above, and a few puts.
  must(room.delivered - sent <= 60 * room.here.length + 600 * SUMO_MAX + 200, `${room.delivered - sent} messages in a quiet minute`);
  // A match is at most two wins each short of the title plus the empty rounds between: bounded, if long.
  for (let i = 0; i < 2400 && prev.phase !== 'lobby'; i++) tick(1000);
  must(prev.phase === 'lobby', `still in ${prev.phase} (round ${prev.round}) forty minutes after everyone stopped`);
  const quiet = room.delivered;
  for (let i = 0; i < 40; i++) tick(pick(r, [100, 100, 1000, 60_000]));
  must(room.delivered === quiet, `${room.delivered - quiet} messages from an idle lobby`);
  stats.sims++;
}

// ---------------------------------------------------------------------------------------------------------
// The rules alone, with positions the real room would never pass on.
// ---------------------------------------------------------------------------------------------------------
const finite = (v: { dx: number; dz: number }) => Number.isFinite(v.dx) && Number.isFinite(v.dz);

function pushSim(r: Rnd) {
  const num = (scale: number) => (chance(r, 0.08) ? pick(r, BAD_NUMBERS) : (r() - 0.5) * scale);
  const mover = (near?: Mover): Mover => {
    const x = near && chance(r, 0.5) ? near.x + (chance(r, 0.3) ? 0 : num(2)) : num(6);
    const z = near && chance(r, 0.5) ? near.z + (chance(r, 0.3) ? 0 : num(2)) : num(6);
    return chance(r, 0.3) ? { x, z, px: x, pz: z } : { x, z, px: x + num(pick(r, [0.5, 2, 1e6])), pz: z + num(pick(r, [0.5, 2, 1e6])) };
  };
  const a = mover();
  const b = mover(a);
  const p = sumoPush(a, b);
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  must((p !== null) === d < SUMO_REACH, `apart by ${d} but push is ${JSON.stringify(p)}`);
  if (p) {
    stats.pushes++;
    must(finite(p.a) && finite(p.b), `push ${JSON.stringify(p)} for ${JSON.stringify([a, b])}`);
    must(Math.hypot(p.a.dx, p.a.dz) <= PUSH_CAP + 1e-9 && Math.hypot(p.b.dx, p.b.dz) <= PUSH_CAP + 1e-9, 'a push over the cap');
    // Each is moved away from the other, never towards.
    const [nx, nz] = d < 1e-6 ? [1, 0] : [b.x - a.x, b.z - a.z];
    must(p.a.dx * nx + p.a.dz * nz <= 1e-12 && p.b.dx * nx + p.b.dz * nz >= -1e-12, 'pulled together');
    must(Math.hypot(p.a.dx, p.a.dz) + Math.hypot(p.b.dx, p.b.dz) > 0, 'touching but nobody moves');
  }
  const crowd: Record<string, Mover> = { a, b };
  for (let i = 0; i < int(r, 7); i++) crowd[`c${i}`] = mover(pick(r, Object.values(crowd)));
  for (const [id, v] of Object.entries(sumoPushes(crowd))) {
    must(id in crowd && finite(v), `crowd push ${JSON.stringify(v)}`);
    must(Math.hypot(v.dx, v.dz) <= PUSH_CAP + 1e-9, 'a crowd push over the cap');
  }
  const n = int(r, 10);
  const ring = chance(r, 0.5) ? RING : { x: (r() - 0.5) * 40, z: (r() - 0.5) * 40, r: 1 + r() * 6 };
  {
    const places = sumoPlaces(n, ring);
    must(places.length === n && places.every((s) => Math.hypot(s.x - ring.x, s.z - ring.z) <= ring.r), 'a starting place outside the ring');
    const o = sumoOutside(num(30), num(30), ring);
    must(Math.abs(Math.hypot(o.x - ring.x, o.z - ring.z) - (ring.r + 1.2)) < 1e-6, `"outside" is at ${o.x},${o.z}`);
  }
}

function rulesSim(seed: number) {
  const r = rng(seed);
  for (let i = 0; i < 40; i++) pushSim(r);
  const g = newSumo();
  const ring = chance(r, 0.5) ? RING : { x: 0, z: 0, r: 4 };
  let now = 5_000_000;
  const n = chance(r, 0.1) ? 12 : 2 + int(r, 5);
  const raw = chance(r, 0.3);
  const coord = (c: number) => (raw && chance(r, 0.1) ? pick(r, BAD_NUMBERS) : c + (r() - 0.5) * pick(r, [2, 6, 12]));
  type Spot = { id: string; x: number; z: number; seat: string | null };
  const spots: Spot[] = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, x: coord(ring.x), z: coord(ring.z), seat: null }));
  let present = spots.filter(() => chance(r, 0.9));
  if (chance(r, 0.08)) for (const s of spots) s.seat = 'bench';
  const where = (id: string) => present.find((s) => s.id === id) ?? null;
  const far = (id: string) => {
    const p = where(id);
    const d = p ? Math.hypot(p.x - ring.x, p.z - ring.z) : Infinity;
    return Number.isNaN(d) ? Infinity : d;
  };

  const check = (what: string) => {
    const ids = g.players.map((p) => p.id);
    must(new Set(ids).size === ids.length && ids.length <= SUMO_MAX, `${what}: bad player list`);
    must(new Set(g.alive).size === g.alive.length && g.alive.every((id) => ids.includes(id)), `${what}: in the ring but not in the match`);
    must(Object.keys(g.wins).every((id) => ids.includes(id)), `${what}: wins kept for someone who left`);
    if (g.phase === 'lobby') must(g.alive.length === 0 && g.until === 0, `${what}: a round left over in the lobby`);
    else {
      must(ids.length >= SUMO_MIN, `${what}: ${g.phase} with ${ids.length}`);
      must(Object.values(g.wins).every((w) => w < SUMO_WINS), `${what}: the match goes on after ${SUMO_WINS} wins`);
      must(g.blanks < SUMO_BLANKS, `${what}: the match goes on after ${g.blanks} empty rounds`);
    }
    if (g.phase === 'countdown' || g.phase === 'bout') must(g.alive.length >= 2, `${what}: ${g.phase} with ${g.alive.length} in the ring`);
    if (g.phase === 'result') must(g.alive.length === 0, `${what}: someone in the ring between rounds`);
    scan(sumoView(g, now), [], 'view');
    scan(sumoView(g, now + pick(r, [1, 1e7])), [], 'later view');
  };
  const judge = (what: string, ev: SumoEvent[], was: { phase: string; alive: string[]; until: number; wins: Record<string, number>; round: number }) => {
    const wonBy = ev.filter((e) => e.k === 'round');
    must(wonBy.length <= 1 && ev.filter((e) => e.k === 'match' || e.k === 'abandon').length <= 1, `${what}: a round or match ended twice`);
    for (const e of ev) {
      if (e.k === 'out') must(what === 'tick' && was.alive.includes(e.id) && !g.alive.includes(e.id), `${what}: ${e.id} out but was not in`);
      else if (e.k === 'go') must(was.phase === 'countdown' && now >= was.until && g.phase === 'bout', `${what}: go at the wrong time`);
      else if (e.k === 'place') must(g.phase === 'countdown' && g.round === was.round + 1 && g.alive.length === g.players.length, `${what}: bad new round`);
      else if (e.k === 'round') {
        stats.pureRounds++;
        must(was.phase === 'countdown' || was.phase === 'bout', `${what}: a round ended in the ${was.phase}`);
        must(e.id === null || (g.players.some((p) => p.id === e.id) && was.alive.includes(e.id)), `${what}: round won by ${e.id}, who was not in it`);
        must(e.id === null || g.wins[e.id] === (was.wins[e.id] ?? 0) + 1, `${what}: the winner's wins did not go up by one`);
        if (e.timeout) {
          stats.pureTimeouts++;
          // On the clock, the one nearest the centre takes it.
          must(what === 'tick' && was.phase === 'bout' && now >= was.until && e.id !== null, `${what}: a timeout before time`);
          for (const id of was.alive) if (!ev.some((x) => x.k === 'out' && x.id === id)) must(far(e.id) <= far(id), `${what}: ${e.id} won on time but ${id} was nearer the centre`);
        } else if (what === 'tick') {
          const outs = ev.filter((x) => x.k === 'out').length;
          must(outs > 0 && was.alive.length - outs <= 1, `${what}: a round ended with ${was.alive.length - outs} still in`);
        }
      } else if (e.k === 'match') {
        stats.pureChampions++;
        must(g.phase === 'lobby' && g.wins[e.id] === SUMO_WINS && g.champion?.id === e.id, `${what}: bad match end`);
      } else if (e.k === 'abandon') {
        if (e.idle) stats.pureIdleOff++;
        must(g.phase === 'lobby' && (e.idle ? g.blanks >= SUMO_BLANKS : g.players.length < SUMO_MIN), `${what}: bad abandon`);
      }
    }
    // Nobody outside the ring, sitting down or gone is still "in" after the referee has looked.
    if (what === 'tick' && was.phase === 'bout' && g.phase === 'bout') for (const id of g.alive) must(where(id) && !where(id)!.seat && far(id) <= ring.r, `${what}: ${id} still in from ${far(id)} m`);
    if (what === 'tick' && was.phase !== 'lobby' && now >= was.until) must(g.phase !== was.phase || g.round !== was.round, `${what}: ${was.phase} outlasted its clock`);
    if (was.phase !== 'lobby' && g.phase === 'lobby') must(ev.some((e) => e.k === 'match' || e.k === 'abandon'), `${what}: a match ended without an event`);
    check(what);
  };
  const snap = () => ({ phase: g.phase, alive: [...g.alive], until: g.until, wins: { ...g.wins }, round: g.round });

  const steps = 100 + int(r, 900);
  for (let i = 0; i < steps; i++) {
    const op = int(r, 40);
    const who = pick(r, spots);
    if (op === 0) {
      sumoJoin(g, { id: who.id, name: `N${who.id}` });
      check('join');
    } else if (op === 1) {
      const was = snap();
      const ev = sumoStart(g, chance(r, 0.2) ? 'stranger' : who.id, now);
      must(!ev.length || (was.phase === 'lobby' && g.round === 1 && Object.keys(g.wins).length === 0), 'a start that should have been refused');
      if (ev.length) stats.pureMatches++;
      check('start');
    } else if (op === 2 && chance(r, 0.3)) {
      const was = snap();
      // Sometimes one of the last two in the ring.
      const id = chance(r, 0.2) ? 'stranger' : chance(r, 0.4) && g.alive.length ? pick(r, g.alive) : who.id;
      const had = g.players.some((p) => p.id === id);
      const ev = sumoLeave(g, id, now);
      must((ev !== null) === had && !g.players.some((p) => p.id === id), 'leave: wrong answer');
      judge('leave', ev ?? [], was);
    } else if (op === 3 && chance(r, 0.3)) who.seat = who.seat ? null : 'sofa';
    else if (op === 4 && chance(r, 0.2)) present = present.includes(who) ? present.filter((s) => s !== who) : [...present, who];
    else if (op === 5) {
      if (g.phase === 'lobby') for (const s of spots) sumoJoin(g, { id: s.id, name: `N${s.id}` });
      check('all join');
    } else {
      now += chance(r, 0.01) ? pick(r, [0, 1, 2999, 3000, ROUND_MS, 1e7]) : 100;
      for (const s of present) {
        if (s.seat) continue;
        if (chance(r, 0.01)) [s.x, s.z] = [coord(ring.x), coord(ring.z)];
        else if (Number.isFinite(s.x) && Number.isFinite(s.z)) {
          // Drift towards the middle a little more than away, so bouts last.
          s.x += (r() - 0.5) * 0.8 + (ring.x - s.x) * 0.02;
          s.z += (r() - 0.5) * 0.8 + (ring.z - s.z) * 0.02;
        }
      }
      const was = snap();
      judge('tick', sumoTick(g, now, where, ring), was);
    }
  }
  // However it was left, enough time always ends it: no match can need more than this many phases.
  const most = (SUMO_MAX * (SUMO_WINS - 1) + 1) * SUMO_BLANKS * 3 + 3;
  for (let i = 0; i < most && g.phase !== 'lobby'; i++) {
    now += ROUND_MS;
    const was = snap();
    judge('tick', sumoTick(g, now, where, ring), was);
  }
  must(g.phase === 'lobby', `stuck in ${g.phase}, round ${g.round}`);
}

afterAll(() => {
  vi.restoreAllMocks();
  console.log(`sumo sim: ${JSON.stringify(stats)}`);
});

test(`sumo server: ${RUNS} seeded sessions in a simulated room`, { timeout: 3_600_000 }, () => {
  seeded('sumo server sim', serverSim);
  expect(stats.sims).toBe(RUNS);
  if (RUNS >= 200) {
    expect(stats.champions).toBeGreaterThan(RUNS / 10);
    expect(stats.nudges).toBeGreaterThan(RUNS);
    expect(stats.idleOff).toBeGreaterThan(0);
  }
});

test(`sumo rules: ${RUNS} seeded sessions with raw positions`, { timeout: 3_600_000 }, () => {
  seeded('sumo rules sim', rulesSim);
  if (RUNS >= 200) expect(stats.pureChampions).toBeGreaterThan(RUNS / 20);
});
