// Truth or dare, played thousands of times by a seeded random crowd that also misbehaves.
// Two layers are driven with the same actions and the same random numbers: the rules (a "shadow" state the
// test can see into) and the real server factory behind a recording GameIO. After every step the shadow is
// checked against the game's invariants and the server's messages are checked against the shadow.
//
//   SIM_RUNS=20000 npx vitest run tests/sim/dare.sim.test.ts     more sessions
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/dare.sim.test.ts     replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/dare';
import { CHOOSE_MS, DARES, DARE_MIN, TRUTHS, dareChoose, dareJoin, dareLeave, dareSpin, dareTick, dareView, newDare } from '../../shared/minigames/dare';

// Read without Node's types, which this project does not install.
const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(ENV.SIM_RUNS) || 20000;
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
const json = (v: unknown) => JSON.stringify(v);

/** Values no honest browser sends. Made fresh each time, so one game changing one cannot affect the next. */
const GARBAGE: (() => unknown)[] = [
  () => undefined, () => null, () => NaN, () => Infinity, () => -Infinity, () => -1, () => -0, () => 0.5, () => 1e308, () => 2 ** 53, () => -(2 ** 31), () => 3.0000001,
  () => '', () => '0', () => '1', () => ' ', () => 'x'.repeat(200_000), () => '__proto__', () => 'constructor', () => 'toString',
  () => true, () => false, () => [], () => [1], () => [[]], () => [NaN, 'a', null], () => new Array(5), () => ({}), () => ({ length: 2, 0: 1, 1: 2 }),
  () => Object.create(null), () => Object.create({ k: 'join', kind: 'truth', n: 1 }), () => ({ toString: () => 'truth', valueOf: () => 1 }),
  () => JSON.parse('{"__proto__":{"k":"join"},"constructor":{"prototype":1},"length":3}'), () => new Date(0), () => new Map([[1, 2]]),
];
const garbage = (r: Rnd) => pick(r, GARBAGE)();

/**
 * Fails on anything a browser could not sensibly show: NaN and infinities, `undefined` in a list, text built
 * from them, and negative numbers anywhere except under the keys named in `signed`.
 */
function scan(v: unknown, signed: readonly string[], path: string, key = ''): void {
  if (typeof v === 'number') {
    must(Number.isFinite(v), `${path} is ${v}`);
    must(v >= 0 || signed.includes(key), `${path} is negative: ${v}`);
  } else if (typeof v === 'string') must(!/undefined|NaN|Infinity|\[object /.test(v), `${path} has broken text: ${v.slice(0, 80)}`);
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) {
    must(v[i] !== undefined, `${path}[${i}] is undefined`);
    scan(v[i], signed, `${path}[${i}]`, key);
  } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, signed, `${path}.${k}`, k);
  else must(v === null || v === undefined || typeof v === 'boolean', `${path} is a ${typeof v}`);
}

interface Sent {
  /** Who it went to; null for a broadcast. */
  to: string | null;
  /** The message as a browser would get it: through JSON. */
  v: any;
}
const NAMES = ['Ann', 'Bao', 'Chi', 'Dung', 'Em', 'Giang', 'Ann', 'Bao']; // repeats on purpose: names are not unique

/** A fake room: a changing list of people, and a GameIO that records and checks everything the game sends. */
function makeRoom(signed: readonly string[] = []) {
  const people: PlayerInfo[] = [];
  const out: Sent[] = [];
  const notices: string[] = [];
  let made = 0;
  const here = (id: string) => people.some((p) => p.id === id);
  const record = (to: string | null, v: unknown) => {
    scan(v, signed, to === null ? 'broadcast' : `send(${to})`);
    out.push({ to, v: JSON.parse(json(v)) });
  };
  const never = (what: string) => () => {
    throw new Error(`the game called io.${what}, which it has no reason to`);
  };
  const io: GameIO = {
    players: () => people.map((p) => ({ ...p })),
    send: (id, v) => record(id, v),
    broadcast: (v) => record(null, v),
    notice: (text) => {
      scan(text, [], 'notice');
      must(typeof text === 'string' && text.trim().length > 0, 'empty notice');
      notices.push(text);
    },
    emote: (id, k) => must(here(id) && typeof k === 'string' && k.length > 0, `emote for ${id}, who is not in the room`),
    put: never('put'),
    nudge: never('nudge'),
    resetBall: never('resetBall'),
    setScore: never('setScore'),
  };
  /** Someone new walks in. Ids are never reused, as on the real server. */
  const enter = (): PlayerInfo => {
    made++;
    const p: PlayerInfo = { id: `p${made}`, name: NAMES[made % NAMES.length], color: '#fff', look: 'a', x: made, z: -made, ry: 0, seat: null };
    people.push(p);
    return p;
  };
  const exit = (id: string) => people.splice(people.findIndex((p) => p.id === id), 1);
  return { people, out, notices, io, enter, exit, here };
}

/** The server's Math.random, pointed at a seeded stream for each session. */
let serverRandom: Rnd = () => 0;
const spy = vi.spyOn(Math, 'random').mockImplementation(() => serverRandom());
afterAll(() => spy.mockRestore());

/** Run `session` for RUNS seeds; a failure names the seed that replays it. */
function simulate(name: string, session: (seed: number, trail: string[]) => void) {
  for (let i = 0; i < RUNS; i++) {
    const seed = SEED0 + i;
    const trail: string[] = [];
    // The spy records every call; without this a long run fills the memory.
    spy.mockClear();
    try {
      session(seed, trail);
    } catch (e) {
      const err = e as Error;
      err.message = `[${name} sim] seed=${seed} step=${trail.length}: ${err.message}\n  replay: SIM_SEED=${seed} SIM_RUNS=1 npx vitest run tests/sim/${name}.sim.test.ts\n  last steps:\n    ${trail.slice(-15).join('\n    ')}`;
      throw err;
    }
  }
}
// ---------------------------------------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const stats = { sessions: 0, late: 0, steps: 0, rounds: 0, timeouts: 0, refused: 0, exhausted: 0 };

function session(seed: number, trail: string[]) {
  const r = rng(seed);
  // The server and the shadow draw from two copies of one stream, so they must stay in step.
  const a = rng(seed ^ 0x5eed);
  const b = rng(seed ^ 0x5eed);
  let serverDraws = 0;
  let shadowDraws = 0;
  serverRandom = () => (serverDraws++, a());
  const rnd = () => (shadowDraws++, b());

  const room = makeRoom();
  const server = create(room.io);
  const g = newDare();
  let now = T0 + int(r, 1e9);
  const inGame = (id: string) => g.players.some((p) => p.id === id);
  /** My own record of prompts handed out since each list last ran dry. */
  const seen = { truth: new Set<string>(), dare: new Set<string>() };

  /** The server must have said exactly this since `mark`. */
  const said = (mark: number, want: Sent[], what: string) => {
    const got = room.out.slice(mark);
    must(json(got) === json(JSON.parse(json(want))), () => `${what}: the server sent ${json(got)} but should have sent ${json(want)}`);
  };
  const cast = (changed: boolean): Sent[] => (changed ? [{ to: null, v: dareView(g, now) }] : []);

  const check = () => {
    must(serverDraws === shadowDraws, `server drew ${serverDraws} random numbers, the rules ${shadowDraws}`);
    must(new Set(g.players.map((p) => p.id)).size === g.players.length, 'a player is in the game twice');
    for (const p of g.players) must(room.here(p.id), `${p.id} is in the game but not in the room`);
    if (g.phase === 'lobby') must(g.picked === null && g.kind === null && g.prompt === null, `lobby still shows ${json([g.picked, g.kind, g.prompt])}`);
    else {
      must(g.players.length >= DARE_MIN, `phase ${g.phase} with ${g.players.length} players`);
      must(g.picked !== null && inGame(g.picked), `picked ${g.picked} is not in the game`);
    }
    if (g.phase === 'choose') {
      must(g.kind === null && g.prompt === null, 'a prompt is showing while someone is still choosing');
      // Never stuck: the choice has a deadline ahead of us, and reaching it moves the game on.
      must(g.until > now && g.until <= now + CHOOSE_MS, `choose deadline is ${g.until - now} ms away`);
      const later = structuredClone(g);
      must(dareTick(later, g.until, rng(1)) && later.phase === 'prompt' && later.kind === 'truth', 'the choose deadline does not move the game on');
    }
    if (g.phase === 'prompt') must((g.kind === 'truth' ? TRUTHS : g.kind === 'dare' ? DARES : []).includes(g.prompt!), `prompt ${g.prompt} is not a ${g.kind}`);
    const v = dareView(g, now);
    scan(v, [], 'view');
    must(v.left >= 0 && v.left <= CHOOSE_MS && (v.left === 0 || v.phase === 'choose'), `left is ${v.left} in ${v.phase}`);
  };

  /** Call after anything that may have turned a choice into a prompt. */
  const notePrompt = (was: string) => {
    if (was !== 'choose' || g.phase !== 'prompt') return;
    stats.rounds++;
    const list = g.kind === 'truth' ? TRUTHS : DARES;
    const mine = seen[g.kind!];
    if (mine.size === list.length) {
      mine.clear();
      stats.exhausted++;
    }
    must(!mine.has(g.prompt!), `"${g.prompt}" came up again with ${list.length - mine.size} ${g.kind}s still unused`);
    mine.add(g.prompt!);
  };

  const act = (p: PlayerInfo, action: Record<string, unknown>) => {
    const member = inGame(p.id);
    // What should happen, restated here rather than asked of the rules.
    let want = false;
    if (action.k === 'join') want = !member;
    else if (action.k === 'leave') want = member;
    else if (action.k === 'spin') want = member && g.phase !== 'choose' && g.players.length >= DARE_MIN;
    else if (action.k === 'choose') want = g.phase === 'choose' && g.picked === p.id && (action.kind === 'truth' || action.kind === 'dare');
    const before = json(g);
    const was = g.phase;
    let changed = false;
    if (action.k === 'join') changed = dareJoin(g, p);
    else if (action.k === 'leave') changed = dareLeave(g, p.id);
    else if (action.k === 'spin') changed = dareSpin(g, p.id, now, rnd);
    else if (action.k === 'choose') changed = dareChoose(g, p.id, action.kind, rnd);
    must(changed === want, `rules ${changed ? 'accepted' : 'refused'} it`);
    if (!changed) {
      stats.refused++;
      must(json(g) === before, 'a refused action changed the state');
    }
    notePrompt(was);
    const mark = room.out.length;
    server.onAction({ ...p }, action, now);
    said(mark, cast(changed), 'action');
  };

  const tick = () => {
    const was = g.phase;
    const due = g.phase === 'choose' && now >= g.until;
    const changed = dareTick(g, now, rnd);
    must(changed === due, `tick ${changed ? 'changed' : 'did not change'} the game`);
    if (changed) {
      stats.timeouts++;
      must(g.kind === 'truth', 'a timed-out choice was not truth');
    }
    notePrompt(was);
    const mark = room.out.length;
    server.tick!(now);
    said(mark, cast(changed), 'tick');
  };

  const leaveRoom = (id: string) => {
    room.exit(id);
    const changed = dareLeave(g, id);
    const mark = room.out.length;
    server.onLeave(id, now);
    said(mark, cast(changed), 'leaving the room');
  };

  /** A deadline has passed but the server has not ticked yet: it only ticks every 100 ms, so actions can land in the gap. */
  let owed = false;
  const steps = 40 + int(r, chance(r, 0.15) ? 700 : 160);
  for (let i = 0; i < steps; i++) {
    const anyone = room.people.length ? pick(r, room.people) : null;
    const picked = room.people.find((p) => p.id === g.picked) ?? null;
    const roll = r();
    let what: string;
    if (!anyone || roll < 0.05) {
      if (room.people.length >= 7) continue;
      const p = room.enter();
      what = `${p.id} enters the room`;
      trail.push(what);
      const mark = room.out.length;
      server.onJoin!({ ...p }, now);
      // A newcomer hears about a game only if somebody is in it, and privately.
      said(mark, g.players.length ? [{ to: p.id, v: dareView(g, now) }] : [], 'entering the room');
    } else if (roll < 0.09) {
      // Leaving the room, biased towards the person in the hot seat.
      const p = picked && chance(r, 0.4) ? picked : anyone;
      trail.push(`${p.id} leaves the room`);
      leaveRoom(p.id);
    } else if (roll < 0.24) {
      trail.push(`${anyone.id} joins`);
      act(anyone, { k: 'join' });
      if (chance(r, 0.2)) {
        trail.push(`${anyone.id} joins again`);
        act(anyone, { k: 'join' });
      }
    } else if (roll < 0.29) {
      const p = picked && chance(r, 0.4) ? picked : anyone;
      trail.push(`${p.id} leaves the game`);
      act(p, { k: 'leave' });
      if (chance(r, 0.5)) {
        trail.push(`${p.id} comes straight back`);
        act(p, { k: 'join' });
      }
    } else if (roll < 0.47) {
      trail.push(`${anyone.id} spins`);
      act(anyone, { k: 'spin' });
    } else if (roll < 0.67) {
      // Mostly the right person choosing; sometimes anyone at all.
      const p = picked && chance(r, 0.8) ? picked : anyone;
      const kind = chance(r, 0.9) ? pick(r, ['truth', 'dare']) : garbage(r);
      trail.push(`${p.id} chooses ${typeof kind === 'string' ? kind.slice(0, 20) : typeof kind}`);
      act(p, { k: 'choose', kind });
    } else if (roll < 0.77) {
      // Nonsense: unknown actions, actions with junk in every field, actions that are not plain objects.
      const k = chance(r, 0.5) ? pick(r, ['join', 'leave', 'spin', 'choose', 'start', 'toString', '__proto__']) : garbage(r);
      const action = chance(r, 0.2) ? (Object.assign(Object.create({ k: 'spin', kind: 'dare' }), { kind: garbage(r) }) as Record<string, unknown>) : { k, kind: garbage(r), n: garbage(r) };
      // Only an own or inherited `k` the server would act on counts; the oracle in act() reads it the same way.
      trail.push(`${anyone.id} sends junk k=${typeof action.k === 'string' ? action.k : typeof action.k}`);
      act(anyone, action);
    } else if (g.phase === 'choose' && !owed && roll > 0.96) {
      now = g.until + int(r, 101);
      trail.push('the deadline passes, but the server has not ticked yet');
      owed = true;
      stats.late++;
      stats.steps++;
      continue;
    } else {
      const toDeadline = g.until - now;
      const dt = pick(r, [0, 1, 100, 100, 3000, toDeadline - 1, toDeadline, toDeadline + 1, CHOOSE_MS * 3, 86_400_000]);
      now += Math.max(0, dt);
      trail.push(`time +${Math.max(0, dt)}`);
      tick();
    }
    if (owed) {
      trail.push('the late tick');
      tick();
      owed = false;
    }
    check();
    stats.steps++;
  }

  // Left alone, the game settles: no choice is ever left hanging.
  now += CHOOSE_MS * 10;
  trail.push('everyone goes quiet');
  tick();
  check();
  must(g.phase !== 'choose', 'still waiting for a choice after ten deadlines');
  // Then the room empties, in any order, and the game ends up clean.
  while (room.people.length) {
    const p = pick(r, room.people);
    trail.push(`${p.id} leaves the room at the end`);
    leaveRoom(p.id);
    check();
  }
  must(g.players.length === 0 && g.phase === 'lobby', 'an empty room still has a game going');
  now += 86_400_000;
  tick();
  stats.sessions++;
}

test(`dare: ${RUNS} seeded sessions of random and hostile play`, () => {
  simulate('dare', session);
  console.log(`dare sim: ${json(stats)}`);
  expect(stats.sessions).toBe(RUNS);
  // The run is only worth something if the interesting things really happened.
  if (RUNS >= 100) {
    expect(stats.rounds).toBeGreaterThan(RUNS);
    expect(stats.timeouts).toBeGreaterThan(0);
    expect(stats.exhausted).toBeGreaterThan(0);
  }
}, 3_600_000);
