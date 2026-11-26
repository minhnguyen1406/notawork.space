// Football match, played thousands of times by a seeded random crowd that also cheats and misbehaves.
// Two sims: the real server factory behind a recording GameIO in a small simulated room (which keeps the
// room's own scoreboard, as the real room does), and the pure rules. Invariants are checked after every step.
//
//   SIM_RUNS=10000 npx vitest run tests/sim/cup.sim.test.ts            more games
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/cup.sim.test.ts  replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import { BOUNDS, PITCH } from '../../shared/layout';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO, RoomEvent, ServerGame } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/cup';
import { CUP_MIN, EXTRA_MS, MATCH_MS, PAUSE_MS, type CupGame, type CupResult, type CupView, type Side, cupGoal, cupJoin, cupKickoff, cupLeave, cupShuffle, cupSpots, cupSummary, cupSwitch, cupTeam, cupTick, cupView, newCup, other } from '../../shared/minigames/cup';

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
const KS = ['join', 'leave', 'switch', 'shuffle', 'kickoff'] as const;
const SPOT = { x: PITCH.cx, z: PITCH.cz };
const SIDES = ['red', 'blue'] as const;
const ix = (s: Side) => (s === 'red' ? 0 : 1);
const onPitch = (x: number, z: number) => x >= PITCH.x1 && x <= PITCH.x2 && z >= PITCH.z1 && z <= PITCH.z2;
const stats = { sims: 0, matches: 0, fullTime: 0, draws: 0, golden: 0, forfeits: 0, emptied: 0, goals: 0, ignoredGoals: 0, extras: 0, steps: 0, pureMatches: 0, pureFinals: 0, pureDraws: 0, pureGolden: 0, pureForfeits: 0, pureGoals: 0, pureIgnored: 0 };

/** What a finished match's result must say, whoever worked it out. */
function judgeResult(res: CupResult, score: readonly number[], why: string) {
  must(res.score[0] === score[0] && res.score[1] === score[1], `${why}: the result says ${res.score}, the goals say ${score}`);
  if (!res.forfeit) {
    must(res.winner === (score[0] > score[1] ? 'red' : score[1] > score[0] ? 'blue' : null), `${why}: ${res.winner} "won" ${score}`);
    must(res.winner !== null || res.winners.length === 0, `${why}: a draw with winners`);
  } else must(res.winner !== null, `${why}: a forfeit nobody won`);
  must(res.top.length === 0 ? res.topGoals === 0 : res.topGoals >= 1 && res.topGoals <= score[0] + score[1], `${why}: top scorer with ${res.topGoals}`);
  must(!/undefined|NaN/.test(cupSummary(res)), `${why}: broken summary`);
}

function serverSim(seed: number) {
  const r = rng(seed);
  vi.spyOn(Math, 'random').mockImplementation(rng(seed ^ 0x5bd1e995));
  const room = new Room(r, chance(r, 0.1));
  const game = create(room.io);
  const crowd = chance(r, 0.08) ? 16 + int(r, 10) : 2 + int(r, 7);
  const all = Array.from({ length: crowd }, (_, i) => newBody(room, i, SPOT, 12));
  room.here = all.filter(() => chance(r, 0.9));
  const chaos = pick(r, [0, 0, 0.01, 0.01, 0.15]);
  /** How many goals a minute go in: none, a normal match, or a ball that will not stay out. */
  const goalRate = pick(r, [0, 0.0005, 0.002, 0.002, 0.01, 0.05]);

  type Snap = { phase: CupView['phase']; extra: boolean; score: number[]; clock: number; pause: number; ids: string[]; team: Map<string, Side>; names: Map<string, string>; result: CupResult | null };
  let prev: Snap = { phase: 'lobby', extra: false, score: [0, 0], clock: 0, pause: 0, ids: [], team: new Map(), names: new Map(), result: null };
  /** The goals this test saw accepted, counted by itself. */
  let goals = [0, 0];
  /** The last goal sent, if this step was one. */
  let shot: { side: Side; by: string } | null = null;
  const size = (s: Snap, side: Side) => [...s.team.values()].filter((t) => t === side).length;

  const check = (what: string, dt = 0) => {
    const v = room.probe<CupView>(game);
    const cur: Snap = v
      ? { phase: v.phase, extra: v.extra, score: [...v.score], clock: v.clock, pause: v.pause, ids: v.players.map((p) => p.id), team: new Map(v.players.map((p) => [p.id, p.team])), names: new Map(v.players.map((p) => [p.id, p.name])), result: v.result }
      : { phase: 'lobby', extra: false, score: prev.score, clock: 0, pause: 0, ids: [], team: new Map(), names: new Map(), result: prev.result };
    const msgs = room.take();
    const said = msgs.filter((m) => m.k === 'notice').map((m) => (m as { text: string }).text);
    const puts = msgs.filter((m) => m.k === 'put') as { id: string; x: number; z: number }[];
    for (const p of puts) {
      must(cur.ids.includes(p.id), `put for ${p.id}, who is not playing`);
      must(onPitch(p.x, p.z), `kick-off place off the pitch: ${p.x},${p.z}`);
      must(cur.team.get(p.id) === 'red' ? p.x < PITCH.cx : p.x > PITCH.cx, `${p.id} lined up in the wrong half`);
    }
    must(!msgs.some((m) => m.k === 'nudge'), 'cup sent a nudge');
    must(new Set(cur.ids).size === cur.ids.length, 'someone is playing twice');
    const [nr, nb] = [size(cur, 'red'), size(cur, 'blue')];
    const live = cur.phase !== 'lobby';
    const wasLive = prev.phase !== 'lobby';
    /** Everyone playing who is on their feet: the ones a line-up moves. */
    const standing = cur.ids.filter((id) => room.body(id) && !room.body(id)!.seat).length;
    for (const p of puts) must(!room.body(p.id)?.seat, `${p.id} was moved while sitting down`);

    if (!live) {
      must(Math.abs(nr - nb) <= 1, `the lobby has ${nr} against ${nb}`);
      must(cur.clock === 0 && cur.pause === 0 && !cur.extra, 'a clock running in the lobby');
    } else {
      must(nr >= 1 && nb >= 1, `a match with ${nr} against ${nb}`);
      must(cur.result === null, 'an old result during a match');
      must(cur.clock <= (cur.extra ? EXTRA_MS : MATCH_MS) && cur.pause <= PAUSE_MS, `clock ${cur.clock}, pause ${cur.pause}`);
      must(cur.phase === 'kickoff' || cur.pause === 0, 'a pause during play');
      // The room's scoreboard and the game's own count never drift apart during a match.
      must(room.score[0] === cur.score[0] && room.score[1] === cur.score[1], `the scoreboard says ${room.score}, the game ${cur.score}`);
      // A latecomer goes to the short side, so a lopsided match never gets worse by someone joining.
      if (wasLive && cur.ids.length > prev.ids.length) must(Math.abs(nr - nb) <= Math.max(1, Math.abs(size(prev, 'red') - size(prev, 'blue'))), 'a latecomer joined the bigger side');
      if (wasLive) for (const id of cur.ids) must(!prev.team.has(id) || prev.team.get(id) === cur.team.get(id), `${id} changed sides during a match`);
    }

    // The score is exactly the goals accepted in open play.
    const counted = shot !== null && prev.phase === 'play';
    if (shot) (counted ? stats.goals++ : stats.ignoredGoals++, void 0);
    if (!wasLive && live) {
      stats.matches++;
      goals = [0, 0];
      must(what === 'action kickoff' && cur.phase === 'kickoff', `a match began by ${what}`);
      must(Math.abs(nr - nb) <= 1 && cur.ids.length >= CUP_MIN, `kick-off with ${nr} against ${nb}`);
      must(cur.clock === MATCH_MS && cur.pause === PAUSE_MS && !cur.extra, 'a match began with the wrong clock');
      must(puts.length === standing && said.some((t) => /called a football match/.test(t)), 'no line-up or no announcement at kick-off');
    } else if (counted) goals[ix(shot!.side)]++;
    if (live || wasLive) must(cur.score[0] === goals[0] && cur.score[1] === goals[1], `score ${cur.score} but ${goals} goals were accepted (${what})`);
    if (counted && v) {
      const name = shot!.by || 'Someone';
      const kicker = prev.ids.find((id) => prev.names.get(id) === name);
      must(v.last && v.last.by === name && v.last.side === shot!.side && v.last.own === (!!kicker && prev.team.get(kicker) !== shot!.side), `last goal reads ${JSON.stringify(v.last)}`);
      for (const side of SIDES) must(v.scorers.filter((s) => s.team === side).reduce((n, s) => n + s.goals, 0) <= cur.score[ix(side)], 'more goals credited than scored');
    }

    // The clock: it runs down only in play, stops for every kick-off, and starts again where it stopped.
    if (wasLive && live) {
      const ran = Math.max(0, prev.clock - dt);
      if (prev.phase === 'kickoff' && cur.phase === 'kickoff') must(cur.clock === prev.clock && cur.pause === prev.pause - dt && !counted, 'the clock moved during a pause, or a goal counted in one');
      else if (prev.phase === 'kickoff') must(what === 'tick' && dt >= prev.pause && cur.clock === prev.clock, `play restarted with ${cur.clock} on the clock, not ${prev.clock}`);
      else if (cur.phase === 'kickoff') must(counted && !prev.extra && cur.clock === ran && cur.pause === PAUSE_MS && puts.length === standing, 'a pause that did not follow a goal, or lost time');
      else if (cur.extra && !prev.extra) {
        stats.extras++;
        must(what === 'tick' && ran === 0 && cur.score[0] === cur.score[1] && cur.clock === EXTRA_MS && said.some((t) => /next goal wins/.test(t)), 'extra time began wrongly');
      } else must(cur.clock === ran && ran > 0 && !counted, `the clock went from ${prev.clock} to ${cur.clock} in ${dt} ms of play`);
      must(cur.extra || !prev.extra, 'extra time was taken back');
    }

    // The end.
    if (wasLive && !live) {
      const res = cur.result;
      if (cur.ids.length === 0) {
        stats.emptied++;
        must(/leave/.test(what), 'everyone vanished without leaving');
      } else {
        must(res !== null && res !== prev.result, 'a match ended without a result');
        judgeResult(res, goals, what);
        must(said.includes(cupSummary(res)), 'the result was not announced');
        if (res.forfeit) {
          stats.forfeits++;
          must(/leave/.test(what) && size(prev, other(res.winner!)) === 1 && !cur.ids.some((id) => prev.team.get(id) === other(res.winner!)), 'a forfeit with the losers still there');
        } else if (prev.extra && counted) {
          stats.golden++;
          must(res.winner === shot!.side, 'the golden goal did not win it');
        } else {
          must(what === 'tick' && prev.phase === 'play' && prev.clock - dt <= 0, `full time by ${what} with ${prev.clock - dt} ms left`);
          must(res.winner !== null || prev.extra, 'a draw without extra time');
          res.winner ? stats.fullTime++ : stats.draws++;
        }
        const winners = prev.ids.filter((id) => cur.ids.includes(id) && prev.team.get(id) === res.winner);
        must(JSON.stringify([...res.winners].sort()) === JSON.stringify(winners.sort()), 'the winners listed are not the winning side');
      }
    } else if (!live) must(cur.result === prev.result || cur.ids.length === 0 || prev.ids.length === 0, 'a result appeared in the lobby');
    shot = null;
    prev = cur;
  };

  const goal = (now: number) => {
    const side = pick(r, SIDES);
    const by = chance(r, 0.8) && room.here.length ? pick(r, room.here).name : pick(r, ['', 'Nobody', 'P999']);
    // The real room adds every goal to its own scoreboard before it tells the games.
    room.score[ix(side)]++;
    shot = { side, by };
    game.onEvent?.({ kind: 'goal', side, by }, now);
    check('goal');
  };
  const tick = (dt: number) => {
    room.now += dt;
    room.move(dt, SPOT);
    const before = room.casts;
    game.tick?.(room.now);
    must(room.casts - before <= 1, 'more than one broadcast in a tick');
    check('tick', dt);
    if (chance(r, goalRate)) goal(room.now);
  };

  if (chance(r, 0.9)) {
    for (const b of room.here)
      if (chance(r, 0.8)) {
        game.onAction({ ...b }, { k: 'join' }, room.now);
        check('action join');
      }
    if (room.here.length) game.onAction({ ...pick(r, room.here) }, { k: 'kickoff' }, room.now);
    check('action kickoff');
  }
  const steps = 300 + int(r, 3200);
  for (let i = 0; i < steps; i++) {
    stats.steps++;
    if (!chance(r, chaos)) {
      tick(chance(r, 0.002) ? pick(r, [1000, 5000, 30_000, 300_000]) : 100);
      continue;
    }
    const op = int(r, 10);
    const who = room.here.length ? pick(r, room.here) : null;
    if (op < 4 && who) {
      const a = chance(r, 0.25) ? junk(r, KS) : { k: pick(r, ['join', 'join', 'kickoff', 'kickoff', 'switch', 'shuffle', 'leave'] as const) };
      game.onAction({ ...who }, a, room.now);
      check(`action ${String(a.k)}`);
    } else if (op === 4 && who) {
      who.seat = who.seat ? null : `seat${int(r, 3)}`;
      check('sit');
    } else if (op === 5 && who) {
      // Leaving the room: one person, or a whole side at once.
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
        Object.assign(b, room.spot(SPOT, 12), { seat: null });
        room.here.push(b);
        game.onJoin?.({ ...b }, room.now);
        check('join room');
      }
    } else if (op === 7) {
      // Goals at any moment (lobby, pause, play, after the end), and events that are not goals at all.
      if (chance(r, 0.6)) goal(room.now);
      else {
        const e = EVENTS(r, all.map((b) => b.name));
        // Only a well-formed goal moves the room's scoreboard.
        if (e.kind === 'goal' && (e.side === 'red' || e.side === 'blue')) {
          room.score[ix(e.side)]++;
          shot = { side: e.side, by: typeof e.by === 'string' ? e.by : '' };
        }
        game.onEvent?.(e, room.now);
        game.onLeave(pick(r, ['', 'nobody', 'probe', '__proto__']), room.now);
        check('event');
      }
    } else if (op === 8 && who) {
      Object.assign(who, room.spot(SPOT, 30));
      check('teleport');
    } else if (who) {
      for (const b of [...room.here]) {
        const k = pick(r, KS);
        game.onAction({ ...b }, { k }, room.now);
        check(`action ${k}`);
      }
    }
  }

  // Nobody touches anything any more (and the ball stays out): it must wind up by itself.
  const from = room.casts;
  for (let i = 0; i < 600; i++) {
    room.now += 100;
    game.tick?.(room.now);
    check('tick', 100);
  }
  must(room.casts - from <= 6, `${room.casts - from} broadcasts in a quiet minute`);
  for (let i = 0; i < 320 && prev.phase !== 'lobby'; i++) {
    room.now += 1000;
    game.tick?.(room.now);
    check('tick', 1000);
  }
  must(prev.phase === 'lobby', `still in ${prev.phase} long after full time`);
  const quiet = room.delivered;
  for (let i = 0; i < 40; i++) {
    room.now += pick(r, [100, 100, 1000, 60_000]);
    game.tick?.(room.now);
    // A goal on the practice pitch after the match is none of the game's business.
    if (chance(r, 0.2)) game.onEvent?.({ kind: 'goal', side: pick(r, SIDES), by: 'P0' }, room.now);
  }
  must(room.delivered === quiet, `${room.delivered - quiet} messages from an idle lobby`);
  stats.sims++;
}

// ---------------------------------------------------------------------------------------------------------
// The rules alone.
// ---------------------------------------------------------------------------------------------------------
function rulesSim(seed: number) {
  const r = rng(seed);
  const g: CupGame = newCup();
  let now = 5_000_000;
  const n = chance(r, 0.1) ? 30 : 2 + int(r, 7);
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  let goals = [0, 0];
  /** Playing time used in normal time, added up by the test. */
  let played = 0;

  const check = (what: string) => {
    const [nr, nb] = [cupTeam(g, 'red').length, cupTeam(g, 'blue').length];
    must(new Set(g.players.map((p) => p.id)).size === g.players.length, `${what}: someone twice`);
    if (g.phase === 'lobby') {
      must(Math.abs(nr - nb) <= 1, `${what}: the lobby has ${nr} against ${nb}`);
      must(g.until === 0 && g.remaining === 0 && !g.extra, `${what}: clocks left over in the lobby`);
    } else {
      must(nr >= 1 && nb >= 1, `${what}: a match with ${nr} against ${nb}`);
      must(g.result === null, `${what}: a result during a match`);
      must(g.score[0] === goals[0] && g.score[1] === goals[1], `${what}: score ${g.score}, goals accepted ${goals}`);
      must(g.remaining >= 0 && g.remaining <= MATCH_MS, `${what}: ${g.remaining} ms remaining`);
      must(!g.extra || g.phase === 'play', `${what}: a pause in extra time`);
      // In a pause, the time played and the time left make exactly one match.
      if (g.phase === 'kickoff') must(played + g.remaining === MATCH_MS, `${what}: played ${played} + left ${g.remaining} is not a match`);
      const spots = cupSpots(g);
      must(spots.length === g.players.length && new Set(spots.map((s) => `${s.x},${s.z}`)).size === spots.length, `${what}: two players share a kick-off place`);
      for (const s of spots) {
        must(onPitch(s.x, s.z), `${what}: a kick-off place off the pitch`);
        must(g.players.find((p) => p.id === s.id)!.team === 'red' ? s.x < PITCH.cx : s.x > PITCH.cx, `${what}: a kick-off place in the wrong half`);
      }
    }
    for (const side of SIDES) must(g.scorers.filter((s) => s.team === side).reduce((k, s) => k + s.goals, 0) <= g.score[ix(side)], `${what}: more goals credited than scored`);
    scan(cupView(g, now), [], 'view');
    scan(cupView(g, now + pick(r, [1, 1e7])), [], 'later view');
  };
  const ended = (what: string, res: CupResult | null) => {
    stats.pureFinals++;
    must(g.phase === 'lobby', `${what}: final but still ${g.phase}`);
    if (!g.players.length && !res) return;
    must(res, `${what}: no result`);
    judgeResult(res, goals, what);
    if (res.forfeit) stats.pureForfeits++;
    else if (!res.winner) stats.pureDraws++;
  };

  const steps = 100 + int(r, 1500);
  for (let i = 0; i < steps; i++) {
    const op = int(r, 60);
    const who = chance(r, 0.1) ? 'stranger' : pick(r, ids);
    const was = { phase: g.phase, extra: g.extra, until: g.until, teams: new Map(g.players.map((p) => [p.id, p.team])) };
    if (op === 0) {
      const ok = cupJoin(g, { id: who, name: `N${who}` });
      must(ok === !was.teams.has(who), 'join: wrong answer');
    } else if (op === 1) {
      const ok = cupKickoff(g, who, now);
      must(!ok || (was.phase === 'lobby' && was.teams.has(who) && g.players.length >= CUP_MIN && g.remaining === MATCH_MS), 'a kick-off that should have been refused');
      if (ok) {
        stats.pureMatches++;
        goals = [0, 0];
        played = 0;
      }
    } else if (op === 2) {
      const ok = cupSwitch(g, who);
      must(!ok || (was.phase === 'lobby' && g.players.find((p) => p.id === who)!.team !== was.teams.get(who)), 'a switch that should have been refused');
    } else if (op === 3) {
      const ok = cupShuffle(g, who, chance(r, 0.1) ? () => pick(r, [0, 0.999999, 1]) : r);
      must(!ok || (was.phase === 'lobby' && was.teams.has(who)), 'a shuffle that should have been refused');
    } else if (op === 4 && chance(r, 0.1)) {
      // One leaves, or a whole side does.
      const side = pick(r, SIDES);
      const gone = chance(r, 0.25) ? cupTeam(g, side).map((p) => p.id) : [who];
      for (const id of gone) {
        const live = g.phase !== 'lobby';
        const out = cupLeave(g, id);
        must((out !== null) === was.teams.has(id) || gone.length > 1, 'leave: wrong answer');
        must(out !== 'final' || live, 'leave: a final in the lobby');
        if (out === 'final') ended('leave', g.result);
        check('leave');
      }
    } else if (op < 9) {
      // The ball goes in: at any time, for any side, kicked by anyone or by nothing sensible.
      const side: unknown = chance(r, 0.85) ? pick(r, SIDES) : pick(r, ['green', '', null, 0, undefined, {}, 'RED']);
      const by: unknown = chance(r, 0.8) ? `N${pick(r, ids)}` : pick(r, ['', null, 7, undefined, {}, 'Nobody']);
      const out = cupGoal(g, side, by, now);
      const ok = was.phase === 'play' && (side === 'red' || side === 'blue');
      must((out !== null) === ok, `goal for ${String(side)} in the ${was.phase} was ${out}`);
      if (ok) {
        stats.pureGoals++;
        goals[ix(side as Side)]++;
        must(out === (was.extra ? 'final' : 'goal'), `a goal in ${was.extra ? 'extra' : 'normal'} time was ${out}`);
        must(typeof g.last?.by === 'string' && g.last.by.length > 0 && g.last.side === side, 'the last goal reads wrongly');
        if (out === 'final') {
          stats.pureGolden++;
          must(g.result?.winner === side, 'the golden goal did not win it');
          ended('goal', g.result);
        } else must(g.phase === 'kickoff' && g.until === now + PAUSE_MS, 'no pause after a goal');
      } else stats.pureIgnored++;
    } else {
      const dt = chance(r, 0.04) ? pick(r, [0, 1, 2999, 3000, 20_000, 60_000, 60_000, MATCH_MS, 1e7]) : 100;
      now += dt;
      const out = cupTick(g, now);
      if (was.phase === 'play' && !was.extra) played += dt;
      if (was.phase === 'lobby') must(out === null, 'tick: something happened in the lobby');
      else if (was.phase === 'kickoff') must(out === (now >= was.until ? 'play' : null), `tick in a pause was ${out}`);
      else if (now < was.until) must(out === null, `tick before the whistle was ${out}`);
      else if (!was.extra && goals[0] === goals[1]) must(out === 'extra' && g.extra && g.until === now + EXTRA_MS && played >= MATCH_MS, 'level at full time but no extra time');
      else {
        must(out === 'final' && (was.extra || played >= MATCH_MS), `the whistle went as ${out} after ${played} ms`);
        must(g.result !== null && !g.result.forfeit && (g.result.winner === null) === (goals[0] === goals[1]), 'full time gave the wrong winner');
        ended('tick', g.result);
      }
    }
    check(`op ${op}`);
  }
  // However it was left, enough time always ends it: a pause, a match, extra time.
  for (let i = 0; i < 4 && g.phase !== 'lobby'; i++) cupTick(g, (now += MATCH_MS));
  must(g.phase === 'lobby', `stuck in ${g.phase}`);
}

afterAll(() => {
  vi.restoreAllMocks();
  console.log(`cup sim: ${JSON.stringify(stats)}`);
});

test(`cup server: ${RUNS} seeded sessions in a simulated room`, { timeout: 3_600_000 }, () => {
  seeded('cup server sim', serverSim);
  expect(stats.sims).toBe(RUNS);
  if (RUNS >= 200) {
    for (const k of ['fullTime', 'draws', 'golden', 'forfeits', 'ignoredGoals'] as const) expect(stats[k], k).toBeGreaterThan(0);
    expect(stats.fullTime + stats.draws + stats.golden).toBeGreaterThan(RUNS / 4);
  }
});

test(`cup rules: ${RUNS} seeded sessions`, { timeout: 3_600_000 }, () => {
  seeded('cup rules sim', rulesSim);
  if (RUNS >= 200) expect(stats.pureFinals).toBeGreaterThan(RUNS / 4);
});
