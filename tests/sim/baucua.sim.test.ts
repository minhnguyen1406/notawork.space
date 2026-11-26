// Bầu cua, played thousands of times by a seeded random crowd that also misbehaves.
// Two layers are driven with the same actions and the same random numbers: the rules (a "shadow" state the
// test can see into) and the real server factory behind a recording GameIO. The test keeps its own ledger of
// everyone's chips and stakes, worked out from the stated rules and not by calling them, and after every step
// compares it with the shadow; everything the server sent is compared with the shadow too.
//
//   SIM_RUNS=20000 npx vitest run tests/sim/baucua.sim.test.ts --silent=false     more sessions, with the counts
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/baucua.sim.test.ts          replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/baucua';
import { BAUCUA_MAX, BET_MS, MAX_CHIPS, SHOW_MS, START_CHIPS, baucuaBet, baucuaClear, baucuaGone, baucuaJoin, baucuaLeave, baucuaTick, baucuaView, chipsOf, newBauCua } from '../../shared/minigames/baucua';

// Read without Node's types, which this project does not install.
const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(ENV.SIM_RUNS) || 4000;
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
const stats = { sessions: 0, steps: 0, rolls: 0, settled: 0, won: 0, lost: 0, even: 0, bets: 0, clears: 0, topUps: 0, skips: 0, refunds: 0, tableFull: 0, brokeBets: 0, lateWindows: 0, refused: 0 };
/** A short, safe description of any value at all, for messages. */
const show = (v: unknown) => {
  try {
    return String(json(v)).slice(0, 30);
  } catch {
    return typeof v;
  }
};
const sum = (xs: readonly number[]) => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};

function session(seed: number, trail: string[]) {
  const r = rng(seed);
  // The server and the shadow draw from two copies of one stream, so they must stay in step.
  const a = rng(seed ^ 0x5eed);
  const b = rng(seed ^ 0x5eed);
  let serverDraws = 0;
  let shadowDraws = 0;
  serverRandom = () => (serverDraws++, a());
  const rnd = () => (shadowDraws++, b());

  const room = makeRoom(['net']);
  const server = create(room.io);
  const g = newBauCua();
  let now = T0 + int(r, 1e9);
  /** Set while the clock has run up to 100 ms past a deadline and the server has not ticked yet. */
  let late = false;
  /** One session in ten fills the room, to reach the 20-seat limit. */
  const crowd = chance(r, 0.1);

  // The ledger: my own account of the table, kept from the stated rules.
  /** Chips in hand, for everyone who has sat down since entering the room. */
  const hand = new Map<string, number>();
  /** Who is seated, in order, and what each has on the board. */
  const seats: string[] = [];
  const stakes = new Map<string, number[]>();
  /** What each seated player won or lost on the roll now showing. */
  const nets = new Map<string, number | null>();
  let topped: string[] = [];
  const betting = () => g.phase === 'bet' || g.phase === 'wait';
  const topUp = (id: string) => {
    if (hand.get(id) !== 0) return;
    must(sum(stakes.get(id)!) === 0, `${id} would be topped up with a bet down`);
    hand.set(id, START_CHIPS);
    if (!topped.includes(id)) topped.push(id);
    stats.topUps++;
  };
  const newRound = () => {
    topped = [];
    for (const id of seats) {
      stakes.set(id, [0, 0, 0, 0, 0, 0]);
      nets.set(id, null);
      topUp(id);
    }
  };

  /** Everything the server said since `mark` must be exactly this. */
  const said = (mark: number, should: Sent[], what: string) => {
    const got = room.out.slice(mark);
    must(json(got) === json(JSON.parse(json(should))), () => `${what}: the server sent ${json(got)} but should have sent ${json(should)}`);
  };
  /** Bets are placed in the open: every change goes to everyone, and nothing goes to anyone alone. */
  const cast = (changed: boolean): Sent[] => (changed ? [{ to: null, v: baucuaView(g, now) }] : []);

  const check = () => {
    must(serverDraws === shadowDraws, `server drew ${serverDraws} random numbers, the rules ${shadowDraws}`);
    must(json(g.players.map((p) => p.id)) === json(seats) && new Set(seats).size === seats.length && seats.length <= BAUCUA_MAX, `seats are ${json(g.players.map((p) => p.id))}, expected ${json(seats)}`);
    // Chips: the rules' bank is my ledger, to the chip, and holds nobody who has left the room.
    must(g.bank.size === hand.size, `the bank remembers ${g.bank.size} people, the ledger ${hand.size}`);
    for (const [id, chips] of hand) {
      must(room.here(id), `${id} has left the room but still has chips`);
      must(g.bank.get(id) === chips, `${id} has ${g.bank.get(id)} chips, the ledger says ${chips}`);
      must(Number.isInteger(chips) && chips >= 0 && chips <= MAX_CHIPS && chips % 10 === 0, `${id} has ${chips} chips`);
    }
    for (const p of g.players) {
      const mine = stakes.get(p.id)!;
      must(json(p.bets) === json(mine), `${p.id} has ${json(p.bets)} on the board, the ledger says ${json(mine)}`);
      must(mine.length === 6 && mine.every((x) => Number.isInteger(x) && x >= 0 && x % 10 === 0), `${p.id} has stakes ${json(mine)}`);
      must(p.net === nets.get(p.id), `${p.id} shows a net of ${p.net}, should be ${nets.get(p.id)}`);
      // Never stuck for want of chips: while bets are open, anyone with nothing down can afford the smallest chip.
      if (betting() && sum(mine) === 0) must(hand.get(p.id)! >= 10, `${p.id} sits with no chips and no bet while betting is open`);
    }
    must(json([...g.topped].sort()) === json([...topped].sort()), `topped up: ${json(g.topped)}, expected ${json(topped)}`);
    must((g.phase === 'idle') === (seats.length === 0), `phase ${g.phase} with ${seats.length} seated`);
    must((g.dice !== null) === (g.phase === 'show'), `dice ${json(g.dice)} in phase ${g.phase}`);
    if (g.phase === 'idle' || g.phase === 'wait') must(g.until === 0, `a clock is set while ${g.phase}`);
    if (g.phase === 'wait') must(g.players.every((p) => sum(p.bets) === 0), 'waiting for a bet with bets down');
    if (g.phase === 'bet' || g.phase === 'show') {
      // Never stuck: the phase has a deadline ahead of us, and reaching it moves the game on.
      const span = g.phase === 'bet' ? BET_MS : SHOW_MS;
      must((late ? g.until > now - 101 : g.until > now) && g.until <= now + span, `${g.phase} deadline is ${g.until - now} ms away`);
      const later = structuredClone(g);
      must(baucuaTick(later, g.until, rng(1)) !== null && later.phase !== g.phase, `the ${g.phase} deadline does not move the game on`);
    }
    if (g.dice) must(g.dice.length === 3 && g.dice.every((d) => Number.isInteger(d) && d >= 0 && d <= 5), `dice ${json(g.dice)}`);
    const v = baucuaView(g, now);
    scan(v, ['net'], 'view');
    must(v.left >= 0 && v.left <= BET_MS && (v.left === 0 || v.phase === 'bet' || v.phase === 'show'), `left is ${v.left} in ${v.phase}`);
    for (const p of v.players) {
      const chips = hand.get(p.id)!;
      must(p.chips === chips && p.worth === chips + (betting() ? sum(stakes.get(p.id)!) : 0), `${p.id} is shown ${p.chips} chips, worth ${p.worth}`);
    }
  };

  /** What sitting down should do to the ledger. */
  const sat = (id: string, was: string, until: number, round: number) => {
    seats.push(id);
    stakes.set(id, [0, 0, 0, 0, 0, 0]);
    nets.set(id, null);
    if (!hand.has(id)) hand.set(id, START_CHIPS);
    if (was === 'idle') {
      newRound();
      must(g.phase === 'bet' && g.until === now + BET_MS && g.round === round + 1, 'the first to sit did not open a betting round');
    } else {
      // Someone who left broke and came back does not sit a round out.
      topUp(id);
      must(g.phase === was && g.until === until && g.round === round, 'sitting down at a running table changed its clock');
    }
  };
  /** What standing up (or leaving the room) should do to the ledger. */
  const stood = (id: string, was: string, until: number) => {
    const down = sum(stakes.get(id)!);
    // Bets not yet rolled for go back; after the roll they are already settled.
    if (was === 'bet' || was === 'wait') {
      hand.set(id, hand.get(id)! + down);
      if (down) stats.refunds++;
    }
    seats.splice(seats.indexOf(id), 1);
    stakes.delete(id);
    nets.delete(id);
    topped = topped.filter((x) => x !== id);
    if (!seats.length) must(g.phase === 'idle' && g.until === 0 && g.dice === null, 'an empty table is not idle');
    else must(g.phase === was && g.until === until, 'someone standing up changed the clock');
  };

  const act = (p: PlayerInfo, action: Record<string, unknown>) => {
    const was = g.phase;
    const until = g.until;
    const round = g.round;
    const before = json([g, [...g.bank]]);
    const seated = seats.includes(p.id);
    const open = was === 'bet' || was === 'wait';
    let changed = false;
    if (action.k === 'join') {
      const ok = !seated && seats.length < BAUCUA_MAX;
      if (!seated && !ok) stats.tableFull++;
      changed = baucuaJoin(g, p, now);
      must(changed === ok, `join was ${changed ? 'accepted' : 'refused'} with ${seats.length} seated`);
      if (changed) sat(p.id, was, until, round);
    } else if (action.k === 'leave') {
      changed = baucuaLeave(g, p.id);
      must(changed === seated, `leave was ${changed ? 'accepted' : 'refused'}`);
      if (changed) stood(p.id, was, until);
    } else if (action.k === 'bet') {
      const { sym, chip } = action;
      const chips = hand.get(p.id) ?? 0;
      const fine = typeof sym === 'number' && Number.isInteger(sym) && sym >= 0 && sym <= 5 && (chip === 10 || chip === 50 || chip === 100);
      const ok = seated && open && fine && (chip as number) <= chips;
      if (seated && open && fine && !ok) stats.brokeBets++;
      changed = baucuaBet(g, p.id, sym, chip, now);
      must(changed === ok, `bet ${show(chip)} on ${show(sym)} with ${chips} chips in ${was} was ${changed ? 'accepted' : 'refused'}`);
      if (changed) {
        hand.set(p.id, chips - (chip as number));
        stakes.get(p.id)![sym as number] += chip as number;
        stats.bets++;
        // The first bet at a resting table starts a fresh countdown; otherwise the clock is left alone.
        must(g.phase === 'bet' && g.until === (was === 'wait' ? now + BET_MS : until) && g.round === round, 'a bet set the clock wrongly');
      }
    } else if (action.k === 'clear') {
      const down = seated ? sum(stakes.get(p.id)!) : 0;
      const ok = seated && open && down > 0;
      changed = baucuaClear(g, p.id);
      must(changed === ok, `clear was ${changed ? 'accepted' : 'refused'}`);
      if (changed) {
        hand.set(p.id, hand.get(p.id)! + down);
        stakes.set(p.id, [0, 0, 0, 0, 0, 0]);
        stats.clears++;
        must(g.phase === was && g.until === until, 'clearing bets changed the clock');
      }
    }
    if (!changed) {
      stats.refused++;
      must(json([g, [...g.bank]]) === before, 'a refused action changed the state');
    }
    const mark = room.out.length;
    server.onAction({ ...p }, action, now);
    said(mark, cast(changed), 'action');
  };

  const tick = () => {
    const was = g.phase;
    const round = g.round;
    const due = (was === 'bet' || was === 'show') && now >= g.until;
    const anyBets = seats.some((id) => sum(stakes.get(id)!) > 0);
    const what = baucuaTick(g, now, rnd);
    if (!due) must(what === null, `the clock did "${what}" in ${was} before any deadline`);
    else if (was === 'show') {
      must(what === 'round' && g.phase === 'bet' && g.until === now + BET_MS && g.round === round + 1, 'the show did not give way to a new betting round');
      newRound();
    } else if (!anyBets) {
      must(what === 'skip' && g.phase === 'wait' && g.round === round, 'betting closed with no bets but the table did not rest');
      stats.skips++;
    } else {
      must(what === 'roll' && g.phase === 'show' && g.until === now + SHOW_MS && g.round === round, 'betting closed with bets down but the dice were not rolled');
      const dice = g.dice!;
      must(dice.length === 3 && dice.every((d) => Number.isInteger(d) && d >= 0 && d <= 5), `rolled ${json(dice)}`);
      stats.rolls++;
      // The payout, die by die: each die pays one stake on its symbol, and a symbol that showed at all gives its stake back.
      for (const id of seats) {
        const mine = stakes.get(id)!;
        const down = sum(mine);
        let back = 0;
        for (const d of dice) back += mine[d];
        for (const s of new Set(dice)) back += mine[s];
        hand.set(id, Math.min(MAX_CHIPS, hand.get(id)! + back));
        nets.set(id, down ? back - down : null);
        if (!down) continue;
        stats.settled++;
        if (back > down) stats.won++;
        else if (back < down) stats.lost++;
        else stats.even++;
      }
    }
    const mark = room.out.length;
    server.tick!(now);
    said(mark, cast(what !== null), 'tick');
  };

  const leaveRoom = (id: string) => {
    room.exit(id);
    const was = g.phase;
    const until = g.until;
    const seated = seats.includes(id);
    const changed = baucuaGone(g, id);
    must(changed === seated, 'leaving the room changed the table for someone not at it (or did not for someone at it)');
    if (seated) stood(id, was, until);
    // Their chips are forgotten with them.
    hand.delete(id);
    must(!g.bank.has(id), `${id} left the room but the bank still has them`);
    const mark = room.out.length;
    server.onLeave(id, now);
    said(mark, cast(changed), 'leaving the room');
  };

  const steps = 60 + int(r, chance(r, 0.2) ? 700 : 250);
  for (let i = 0; i < steps; i++) {
    const anyone = room.people.length ? pick(r, room.people) : null;
    const sitter = seats.length ? room.people.find((p) => p.id === pick(r, seats))! : null;
    const wasLate = late;
    const roll = r();
    if (!anyone || roll < (crowd ? 0.12 : 0.04)) {
      if (room.people.length >= (crowd ? 26 : 8)) continue;
      const p = room.enter();
      trail.push(`${p.id} enters the room`);
      const mark = room.out.length;
      server.onJoin!({ ...p }, now);
      said(mark, seats.length ? [{ to: p.id, v: baucuaView(g, now) }] : [], 'entering the room');
    } else if (roll < (crowd ? 0.14 : 0.07)) {
      const p = sitter && chance(r, 0.6) ? sitter : anyone;
      trail.push(`${p.id} leaves the room`);
      leaveRoom(p.id);
    } else if (roll < (crowd ? 0.34 : 0.17)) {
      trail.push(`${anyone.id} sits down`);
      act(anyone, { k: 'join' });
      if (chance(r, 0.2)) {
        trail.push(`${anyone.id} sits down again`);
        act(anyone, { k: 'join' });
      }
    } else if (roll < (crowd ? 0.36 : 0.21)) {
      const p = sitter ?? anyone;
      trail.push(`${p.id} stands up`);
      act(p, { k: 'leave' });
      if (chance(r, 0.6)) {
        trail.push(`${p.id} sits straight back down`);
        act(p, { k: 'join' });
      }
    } else if (roll < 0.58) {
      // Sensible play: a chip or a few on a symbol; now and then everything on one symbol, which is how people go broke.
      if (!sitter) continue;
      const sym = int(r, 6);
      const allIn = chance(r, 0.15);
      const n = allIn ? 40 : 1 + int(r, 3);
      trail.push(`${sitter.id} bets ${allIn ? 'everything' : `${n} chips`} on ${sym}`);
      for (let k = 0; k < n; k++) {
        const left = hand.get(sitter.id) ?? 0;
        if (allIn && (left === 0 || !betting())) break;
        act(sitter, { k: 'bet', sym, chip: allIn ? (left >= 100 ? 100 : left >= 50 ? 50 : 10) : pick(r, [10, 50, 100]) });
      }
    } else if (roll < 0.62) {
      const p = sitter ?? anyone;
      trail.push(`${p.id} clears their bets`);
      act(p, { k: 'clear' });
    } else if (roll < 0.72) {
      // Bets that are nearly right or plain rubbish, from people at the table and people who are not.
      const p = sitter && chance(r, 0.7) ? sitter : anyone;
      const chips = hand.get(p.id) ?? 0;
      const sym = chance(r, 0.6) ? pick(r, [0, 5, 6, -1, 2.5, '3', 3]) : garbage(r);
      const chip = chance(r, 0.6) ? pick(r, [10, 50, 100, 0, -10, 5, 20, 1000, chips, chips + 10, '10', 10.5, 1e9]) : garbage(r);
      trail.push(`${p.id} bets ${show(chip)} on ${show(sym)}`);
      act(p, { k: 'bet', sym, chip });
    } else if (roll < 0.76) {
      const k = chance(r, 0.6) ? pick(r, ['join', 'leave', 'bet', 'clear', 'start', 'roll', 'toString', '__proto__']) : garbage(r);
      const action = chance(r, 0.2) ? (Object.assign(Object.create({ k: 'bet', sym: 1, chip: 100 }), { sym: garbage(r) }) as Record<string, unknown>) : { k, sym: garbage(r), chip: garbage(r) };
      trail.push(`${anyone.id} sends junk k=${typeof action.k === 'string' ? action.k : typeof action.k}`);
      act(anyone, action);
    } else if (roll < 0.8 && (g.phase === 'bet' || g.phase === 'show') && !late) {
      // The server ticks every 100 ms, so whatever comes next can arrive just after a deadline that has not been acted on yet.
      now = Math.max(now, g.until + int(r, 101));
      late = true;
      stats.lateWindows++;
      trail.push('time runs just past the deadline, no tick yet');
    } else {
      const toDeadline = g.until - now;
      const dt = Math.max(0, pick(r, [0, 1, 100, 100, 2000, toDeadline - 1, toDeadline, toDeadline, toDeadline + 1, BET_MS * 3, 86_400_000]));
      now += dt;
      trail.push(`time +${dt}`);
      tick();
    }
    if (wasLate) {
      // The late action (if any) has run; now the tick that was due arrives.
      trail.push('the overdue tick');
      tick();
      late = false;
    }
    check();
    stats.steps++;
  }

  // Left alone, the table rolls for any bets down and then rests: it never runs on with nobody betting.
  late = false;
  tick();
  for (let k = 0; g.phase === 'bet' || g.phase === 'show'; k++) {
    must(k < 6, 'the table is still running after six deadlines with nobody betting');
    now = g.until + pick(r, [0, 1, 5000]);
    trail.push('deadline passes with nobody betting');
    tick();
    check();
  }
  // Then the room empties, in any order, and nothing is left behind.
  while (room.people.length) {
    const p = pick(r, room.people);
    trail.push(`${p.id} leaves the room at the end`);
    leaveRoom(p.id);
    check();
  }
  must(g.players.length === 0 && g.phase === 'idle' && g.bank.size === 0, 'an empty room still has a table or chips');
  now += 86_400_000;
  tick();
  stats.sessions++;
}

test(`baucua: ${RUNS} seeded sessions of random and hostile play`, () => {
  simulate('baucua', session);
  console.log(`baucua sim: ${json(stats)}`);
  expect(stats.sessions).toBe(RUNS);
  // The run is only worth something if the interesting things really happened.
  if (RUNS >= 200) {
    expect(stats.rolls).toBeGreaterThan(RUNS);
    for (const k of ['won', 'lost', 'even', 'clears', 'topUps', 'skips', 'refunds', 'tableFull', 'brokeBets', 'lateWindows'] as const) expect(stats[k], k).toBeGreaterThan(0);
  }
}, 3_600_000);

test('baucua: the chip ceiling holds through a run of huge wins, and chips stay whole numbers', () => {
  // The crowd above never gets near a billion chips, so the ceiling gets its own seeded run on the rules alone.
  for (let seed = SEED0; seed < SEED0 + 200; seed++) {
    const r = rng(seed);
    const g = newBauCua();
    let now = T0;
    baucuaJoin(g, { id: 'a', name: 'Ann' }, now);
    g.bank.set('a', MAX_CHIPS - 10 * int(r, 200));
    for (let round = 0; round < 30; round++) {
      const before = chipsOf(g, 'a');
      const bets = [0, 0, 0, 0, 0, 0];
      for (let k = 1 + int(r, 30); k > 0; k--) {
        const sym = int(r, 6);
        if (baucuaBet(g, 'a', sym, 100, now)) bets[sym] += 100;
      }
      now += BET_MS;
      must(baucuaTick(g, now, r) === 'roll', `seed=${seed}: no roll`);
      let back = 0;
      for (const d of g.dice!) back += bets[d];
      for (const s of new Set(g.dice!)) back += bets[s];
      const after = chipsOf(g, 'a');
      must(after === Math.min(MAX_CHIPS, before - sum(bets) + back) && Number.isSafeInteger(after) && after >= 0, `seed=${seed} round=${round}: ${before} chips became ${after}`);
      now += SHOW_MS;
      must(baucuaTick(g, now, r) === 'round', `seed=${seed}: no new round`);
    }
  }
});
