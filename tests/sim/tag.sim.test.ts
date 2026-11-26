// Tag, played thousands of times by a seeded random crowd that also cheats and misbehaves.
// Two sims: the real server factory behind a recording GameIO in a small simulated room, and the pure
// rules fed raw (also garbage) positions. Invariants are checked after every step.
//
//   SIM_RUNS=10000 npx vitest run tests/sim/tag.sim.test.ts            more games
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/tag.sim.test.ts  replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import { BOUNDS } from '../../shared/layout';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO, RoomEvent, ServerGame } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/tag';
import { COUNTDOWN_MS, GAME_MS, ROOT_MS, SAFE_MS, TAG_MAX, TAG_MIN, TAG_REACH, type TagPlayer, type TagSpot, type TagView, newTag, tagJoin, tagLeave, tagStart, tagTick, tagView } from '../../shared/minigames/tag';

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
const YARD = { x: -6, z: 10 };
const stats = { sims: 0, started: 0, finished: 0, stopped: 0, tags: 0, steps: 0, puts: 0, pureGames: 0, pureFinished: 0, pureTags: 0 };

function serverSim(seed: number) {
  const r = rng(seed);
  vi.spyOn(Math, 'random').mockImplementation(rng(seed ^ 0x5bd1e995));
  const room = new Room(r, chance(r, 0.15));
  const game = create(room.io);
  const crowd = chance(r, 0.08) ? 22 + int(r, 4) : 2 + int(r, 7);
  const spread = pick(r, [1, 3, 6, 12]);
  const all = Array.from({ length: crowd }, (_, i) => newBody(room, i, YARD, spread));
  room.here = all.filter(() => chance(r, 0.9));
  /** How often people do something other than move: calm, lively or chaotic. */
  const chaos = pick(r, [0, 0, 0.01, 0.01, 0.15]);

  // What the test knows about the game from outside.
  let prev: { phase: TagView['phase']; it: string | null; ids: string[]; names: Map<string, string> } = { phase: 'lobby', it: null, ids: [], names: new Map() };
  let rootedUntil = 0;
  let safe: { id: string; until: number } | null = null;
  let lostSomeone = false;
  let sawResult: unknown = null;

  /** Check everything that can be seen from outside after one step. `at` are the positions the step was judged on. */
  const check = (what: string, at: Map<string, Body> | null) => {
    const v = room.probe<TagView>(game);
    const cur = { phase: v?.phase ?? 'lobby', it: v?.it ?? null, ids: v?.players.map((p) => p.id) ?? [], names: new Map(v?.players.map((p) => [p.id, p.name])) };
    const msgs = room.take();
    for (const m of msgs) {
      if (m.k === 'put') {
        stats.puts++;
        must(prev.ids.includes(m.id), `put for ${m.id}, who is not playing`);
        must(what === 'tick', `put outside a tick (${what})`);
      }
      must(m.k !== 'nudge' && m.k !== 'score', `tag sent a ${m.k}`);
    }
    must(new Set(cur.ids).size === cur.ids.length, 'someone is in the game twice');
    must(cur.ids.length <= TAG_MAX, `${cur.ids.length} players`);
    if (cur.phase === 'play') must(cur.it !== null && cur.ids.includes(cur.it), `playing but "it" is ${cur.it}`);
    else must(cur.it === null, `"it" is ${cur.it} in the ${cur.phase}`);
    if (cur.phase !== 'lobby') must(cur.ids.length >= TAG_MIN, `${cur.phase} with ${cur.ids.length} players`);
    if (v) {
      must(v.left <= (v.phase === 'play' ? GAME_MS : v.phase === 'countdown' ? COUNTDOWN_MS : 0), `left is ${v.left} in ${v.phase}`);
      must(v.root === null || (v.phase === 'play' && v.root === v.it), `rooted ${v.root} but "it" is ${v.it}`);
      must(v.rootLeft <= ROOT_MS && (v.root !== null) === v.rootLeft > 0, `rootLeft ${v.rootLeft} for ${v.root}`);
      must(v.safe === null || (v.phase === 'play' && v.safe !== v.it), `safe ${v.safe} is "it"`);
      const sum = v.players.reduce((n, p) => n + p.itMs, 0);
      must(sum <= (v.phase === 'play' ? GAME_MS - v.left : v.phase === 'countdown' ? 0 : GAME_MS) + 1e-6, `"it" time ${sum} is more than has been played`);
    }
    // Joining is only possible in the lobby.
    if (prev.phase !== 'lobby') for (const id of cur.ids) must(prev.ids.includes(id), `${id} got in during the ${prev.phase}`);
    if (prev.phase !== 'lobby' && cur.ids.length < prev.ids.length) lostSomeone = true;
    if (prev.phase === 'lobby' && cur.phase === 'countdown') {
      stats.started++;
      lostSomeone = false;
    }
    if (prev.phase === 'countdown' && cur.phase === 'play') [rootedUntil, safe] = [0, null];
    if (prev.phase === 'play' && cur.phase === 'play' && prev.it !== cur.it) {
      if (cur.ids.includes(prev.it!) && at) {
        // A tag. Both were playing, within reach on the positions judged, and the windows held.
        stats.tags++;
        must(what === 'tick', `"it" passed on outside a tick (${what})`);
        const a = at.get(prev.it!);
        const b = at.get(cur.it!);
        must(a && b && !a.seat && !b.seat, 'a tag involving someone seated or gone');
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        must(d <= TAG_REACH + 1e-9, `a tag from ${d.toFixed(3)} m away`);
        must(room.now >= rootedUntil, 'a rooted "it" made a tag');
        must(!(safe && safe.id === cur.it && room.now < safe.until), 'the last tagger was tagged straight back');
        rootedUntil = room.now + ROOT_MS;
        safe = { id: prev.it!, until: room.now + SAFE_MS };
      } else [rootedUntil, safe] = [0, null]; // "it" left: a fresh start (and maybe a tag by the new "it" in the same tick)
    }
    if (v?.results && v.results !== sawResult && prev.phase !== 'lobby' && cur.phase === 'lobby') {
      // The final whistle (straight from the countdown if the clock jumped).
      stats.finished++;
      const res = v.results;
      for (let i = 1; i < res.length; i++) must(res[i - 1].itMs <= res[i].itMs, 'the ranking is not in order');
      const least = Math.min(...res.map((p) => p.itMs));
      must(JSON.stringify([...v.winners].sort()) === JSON.stringify(res.filter((p) => p.itMs === least).map((p) => p.id).sort()), 'the winners are not those with the least time');
      const total = res.reduce((n, p) => n + p.itMs, 0);
      must(lostSomeone ? total <= GAME_MS : total === GAME_MS, `times add up to ${total}, not ${GAME_MS} (${lostSomeone ? 'someone left' : 'nobody left'})`);
      must(msgs.some((m) => m.k === 'notice' && /won at tag|share the win/.test(m.text)), 'no result was announced');
    } else if (prev.phase !== 'lobby' && cur.phase === 'lobby') {
      stats.stopped++;
      must(cur.ids.length < TAG_MIN, 'a game stopped with enough players left');
    }
    sawResult = v?.results ?? sawResult;
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

  // Usually get a game going first, so most sims spend their time in play.
  if (chance(r, 0.85)) {
    for (const b of room.here) if (chance(r, 0.8)) game.onAction({ ...b }, { k: 'join' }, room.now);
    check('join', null);
    if (room.here.length) game.onAction({ ...pick(r, room.here) }, { k: 'start' }, room.now);
    check('start', null);
  }
  const steps = 200 + int(r, 1600);
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
      // Usually just anyone; sometimes "it"; sometimes the whole room walks out.
      const gone = chance(r, 0.05) ? [...room.here] : [chance(r, 0.3) ? (room.body(prev.it ?? '') ?? who) : who];
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
      // Everyone presses everything at once.
      for (const b of [...room.here]) {
        game.onAction({ ...b }, { k: pick(r, KS) }, room.now);
        check('mash', null);
      }
    }
  }

  // Nobody touches anything any more: it must wind up by itself, without flooding the room.
  const from = room.casts;
  for (let i = 0; i < 600; i++) tick(100);
  must(room.casts - from <= 60, `${room.casts - from} broadcasts in a quiet minute`);
  for (let i = 0; i < 70 && prev.phase !== 'lobby'; i++) tick(1000);
  must(prev.phase === 'lobby', `still in ${prev.phase} long after the game should be over`);
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
  const g = newTag();
  let now = 5_000_000;
  const n = chance(r, 0.1) ? 24 : 2 + int(r, 6);
  const raw = chance(r, 0.3);
  const coord = () => (raw && chance(r, 0.15) ? pick(r, BAD_NUMBERS) : (r() - 0.5) * pick(r, [2, 6, 20]));
  const spots: TagSpot[] = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, x: coord(), z: coord(), seat: null }));
  let present = spots.filter(() => chance(r, 0.9));
  /** Time as "it" taken away by people who left during this game. */
  let gone = 0;
  let playFrom = 0;
  let rootedUntil = 0;
  let safe: { id: string; until: number } | null = null;

  const check = (what: string) => {
    const ids = g.players.map((p) => p.id);
    must(new Set(ids).size === ids.length && ids.length <= TAG_MAX, `${what}: bad player list`);
    if (g.phase === 'play') must(g.it !== null && ids.includes(g.it), `${what}: playing but "it" is ${g.it}`);
    else must(g.it === null && g.root === null && g.safe === null, `${what}: "it", root or safe left over in the ${g.phase}`);
    if (g.phase !== 'lobby') must(ids.length >= TAG_MIN, `${what}: ${g.phase} with ${ids.length}`);
    if (g.phase === 'play') {
      const sum = g.players.reduce((s, p) => s + p.itMs, 0) + gone;
      must(sum === Math.min(now, g.until) - playFrom, `${what}: "it" times add up to ${sum}, but ${Math.min(now, g.until) - playFrom} ms have been played`);
      must(!g.root || g.root.id === g.it, `${what}: ${g.root?.id} is rooted but not "it"`);
      must(!g.root || (Number.isFinite(g.root.x) && Number.isFinite(g.root.z)), `${what}: rooted at ${g.root?.x},${g.root?.z}`);
      must(!g.safe || g.safe.id !== g.it, `${what}: "it" is safe`);
    }
    scan(tagView(g, now), [], 'view');
    scan(tagView(g, now + pick(r, [0, 1, 1e7])), [], 'later view');
  };
  /** Run one rules call and account for whoever it removed. */
  const run = (what: string, fn: () => ReturnType<typeof tagTick>) => {
    const before = [...g.players];
    const wasPlay = g.phase === 'play';
    const wasIt = g.it;
    const wasPhase = g.phase;
    const ev = fn();
    for (const p of before) if (!g.players.includes(p) && wasPlay) gone += p.itMs;
    for (const e of ev) {
      if (e.k === 'go') {
        playFrom = g.until - GAME_MS;
        [gone, rootedUntil, safe] = [0, 0, null];
        must(wasPhase === 'countdown' && g.players.some((p) => p.id === e.it), 'go: "it" is not playing');
      } else if (e.k === 'it') [rootedUntil, safe] = [0, null];
      else if (e.k === 'tag') {
        stats.pureTags++;
        const a = present.find((s) => s.id === e.from);
        const b = present.find((s) => s.id === e.to);
        must(a && b && a.seat === null && b.seat === null, 'tag: someone seated or gone');
        must(before.some((p) => p.id === e.from) && g.players.some((p) => p.id === e.to) && g.players.some((p) => p.id === e.from), 'tag: not both playing');
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        must(d <= TAG_REACH, `tag from ${d} m`);
        must(now >= rootedUntil, 'tag by a rooted "it"');
        must(!(safe && safe.id === e.to && now < safe.until), 'tagged straight back');
        must(g.it === e.to, 'tag: "it" did not pass on');
        rootedUntil = now + ROOT_MS;
        safe = { id: e.from, until: now + SAFE_MS };
      } else if (e.k === 'end') {
        stats.pureFinished++;
        const res = e.results;
        for (let i = 1; i < res.length; i++) must(res[i - 1].itMs <= res[i].itMs, 'end: not in order');
        must(res.reduce((s: number, p: TagPlayer) => s + p.itMs, 0) + gone === GAME_MS, 'end: times do not add up to the length of the game');
        must(e.winners.length > 0 && e.winners.every((id) => res.find((p) => p.id === id)!.itMs === res[0].itMs), 'end: a winner without the least time');
        must(res.filter((p) => p.itMs === res[0].itMs).length === e.winners.length, 'end: someone with the least time is not a winner');
        must(g.phase === 'lobby' && g.results === res, 'end: not back in the lobby');
      } else if (e.k === 'stop') must(g.phase === 'lobby' && g.players.length < TAG_MIN, 'stop: with enough players');
    }
    void wasIt;
    check(what);
  };

  const steps = 100 + int(r, 900);
  for (let i = 0; i < steps; i++) {
    const op = int(r, 40);
    const who = pick(r, spots);
    if (op === 0) {
      const ok = tagJoin(g, { id: who.id, name: who.id });
      must(!ok || g.players.filter((p) => p.id === who.id).length === 1, 'joined twice');
      check('join');
    } else if (op === 1) {
      const was = g.phase;
      const ok = tagStart(g, chance(r, 0.2) ? 'stranger' : who.id, now);
      must(!ok || (was === 'lobby' && g.players.length >= TAG_MIN && g.players.every((p) => p.itMs === 0)), 'a start that should have been refused');
      if (ok) stats.pureGames++;
      check('start');
    } else if (op === 2 && chance(r, 0.3)) run('leave', () => tagLeave(g, chance(r, 0.2) ? 'stranger' : who.id, now, r));
    else if (op === 3 && chance(r, 0.3)) {
      who.seat = who.seat ? null : 'sofa';
    } else if (op === 4 && chance(r, 0.2)) {
      present = present.includes(who) ? present.filter((s) => s !== who) : [...present, who];
    } else if (op === 5) {
      if (g.phase === 'lobby') for (const s of spots) tagJoin(g, { id: s.id, name: s.id });
      check('all join');
    } else {
      now += chance(r, 0.01) ? pick(r, [0, 1, 999, 2999, 3000, 60_000, GAME_MS, 1e7]) : 100;
      for (const s of present) {
        if (s.seat) continue;
        if (chance(r, 0.02)) [s.x, s.z] = [coord(), coord()];
        else if (Number.isFinite(s.x) && Number.isFinite(s.z)) [s.x, s.z] = [s.x + (r() - 0.5) * 1.7, s.z + (r() - 0.5) * 1.7];
      }
      run('tick', () => tagTick(g, now, present, r));
    }
  }
  // However it was left, enough time always ends it.
  now += COUNTDOWN_MS;
  run('wind up 1', () => tagTick(g, now, present, r));
  now += GAME_MS;
  run('wind up 2', () => tagTick(g, now, present, r));
  must(g.phase === 'lobby', `stuck in ${g.phase}`);
}

afterAll(() => {
  vi.restoreAllMocks();
  console.log(`tag sim: ${JSON.stringify(stats)}`);
});

test(`tag server: ${RUNS} seeded sessions in a simulated room`, { timeout: 3_600_000 }, () => {
  seeded('tag server sim', serverSim);
  expect(stats.sims).toBe(RUNS);
  if (RUNS >= 200) {
    expect(stats.finished).toBeGreaterThan(RUNS / 10);
    expect(stats.tags).toBeGreaterThan(RUNS);
  }
});

test(`tag rules: ${RUNS} seeded sessions with raw positions`, { timeout: 3_600_000 }, () => {
  seeded('tag rules sim', rulesSim);
  if (RUNS >= 200) expect(stats.pureFinished).toBeGreaterThan(RUNS / 20);
});
