// Liar's dice, played thousands of times by a seeded random crowd that also misbehaves.
// Two layers are driven with the same actions and the same random numbers: the rules (a "shadow" state the
// test can see into) and the real server factory behind a recording GameIO. After every step the shadow is
// checked against the game's invariants, restated here rather than asked of the rules, and everything the
// server sent is checked against the shadow: what, and to whom.
//
//   SIM_RUNS=20000 npx vitest run tests/sim/dice.sim.test.ts --silent=false     more sessions, with the counts
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/dice.sim.test.ts          replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/dice';
import { DICE_MAX, DICE_MIN, DICE_START, REVEAL_MS, TURN_MS, diceBid, diceJoin, diceLeave, diceLiar, diceStart, diceTick, diceView, newDice } from '../../shared/minigames/dice';

// Read without Node's types, which this project does not install.
const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(ENV.SIM_RUNS) || 8000;
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
const stats = { sessions: 0, steps: 0, games: 0, wins: 0, noWinner: 0, rounds: 0, bids: 0, calls: 0, trueBids: 0, bidderGone: 0, autoBids: 0, autoCalls: 0, leavesMidGame: 0, lateWindows: 0, refused: 0 };
type Check = (changed: boolean) => void;
/** A short, safe description of any value at all, for messages. */
const show = (v: unknown) => {
  try {
    return String(json(v)).slice(0, 30);
  } catch {
    return typeof v;
  }
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

  const room = makeRoom();
  const server = create(room.io);
  const g = newDice();
  let now = T0 + int(r, 1e9);
  // My own bookkeeping, kept apart from the rules' so the two can be compared.
  /** Who should open the next round. */
  let starter: string | null = null;
  /** The bid standing in this round. */
  let lastBid: { n: number; face: number } | null = null;
  /** Set while the clock has run up to 100 ms past a deadline and the server has not ticked yet. */
  let late = false;

  const seatOf = (id: string) => g.players.findIndex((p) => p.id === id);
  const alive = () => g.players.filter((p) => p.count > 0);
  const total = () => {
    let s = 0;
    for (const p of g.players) s += p.count;
    return s;
  };
  /** The first player holding dice at or after seat `i`, going round. */
  const fromSeat = (i: number): string | null => {
    const n = g.players.length;
    for (let k = 0; k < n; k++) {
      const p = g.players[(i + k) % n];
      if (p.count > 0) return p.id;
    }
    return null;
  };

  /** What the server should send after a change: the public view to all, then each player still in gets their own dice. */
  const want = (changed: boolean): Sent[] => {
    if (!changed) return [];
    const v = diceView(g, now);
    const out: Sent[] = [{ to: null, v }];
    if (g.phase === 'bid') for (const p of g.players) if (p.count > 0) out.push({ to: p.id, v: { ...v, mine: p.dice } });
    return out;
  };
  /** Run one thing on the server and check everything it said because of it. */
  const mirror = (what: string, changed: boolean, was: string, call: () => void) => {
    const mark = room.out.length;
    const notes = room.notices.length;
    call();
    const got = room.out.slice(mark);
    const should = want(changed);
    must(json(got) === json(JSON.parse(json(should))), () => `${what}: the server sent ${json(got)} but should have sent ${json(should)}`);
    const over = was !== 'lobby' && g.phase === 'lobby';
    const notice = over && g.winner ? [`${g.winner.name} won at liar's dice`] : [];
    must(json(room.notices.slice(notes)) === json(notice), () => `${what}: notices ${json(room.notices.slice(notes))}, expected ${json(notice)}`);
    // Secrecy, checked on the wire and not only by comparing with the rules' own view.
    for (const m of got) {
      if (m.to === null) {
        must(!('mine' in m.v), 'a broadcast carries someone\'s dice');
        if (m.v.phase !== 'reveal') must(m.v.reveal === null && !json(m.v).includes('"dice"'), `dice in a broadcast during ${m.v.phase}`);
      } else if (m.v.mine?.length) {
        const p = g.players.find((x) => x.id === m.to);
        must(m.v.phase === 'bid' && p && json(p.dice) === json(m.v.mine), `${m.to} was sent dice that are not theirs`);
        must(m.v.reveal === null && !json(m.v).includes('"dice"'), 'a private view shows other hands');
      }
    }
  };

  /** A game has just ended: back in the lobby, everything cleared, and the right winner. */
  const ended = (winner: string | null) => {
    must(g.phase === 'lobby' && g.turn === null && g.bid === null && g.reveal === null, `game over but state is ${json([g.phase, g.turn, g.bid])}`);
    must((g.winner?.id ?? null) === winner, `winner is ${g.winner?.id}, should be ${winner}`);
    must(g.players.every((p) => p.count === 0 && p.dice.length === 0), 'dice left on the table after the game');
    stats.games++;
    if (winner) stats.wins++;
    else stats.noWinner++;
    lastBid = null;
    starter = null;
  };

  // Each `pre...` looks at the state before a move, and returns a check to run after it.
  const preBid = (id: string, n: unknown, face: unknown): Check => {
    const tot = total();
    const seat = seatOf(id);
    const legal =
      typeof n === 'number' && typeof face === 'number' && Number.isInteger(n) && Number.isInteger(face) && face >= 1 && face <= 6 && n >= 1 && n <= tot &&
      (!lastBid || n > lastBid.n || (n === lastBid.n && face > lastBid.face));
    const ok = g.phase === 'bid' && g.turn === id && legal;
    return (changed) => {
      must(changed === ok, `bid ${show(n)} x ${show(face)} over ${json(lastBid)} with ${tot} dice was ${changed ? 'accepted' : 'refused'}`);
      if (!changed) return;
      must(g.bid && g.bid.n === n && g.bid.face === face && g.bid.by === id && g.bid.name === g.players[seat].name, `bid stored as ${json(g.bid)}`);
      lastBid = { n: n as number, face: face as number };
      must(total() === tot, 'bidding changed the number of dice');
      must(g.phase === 'bid' && g.turn === fromSeat(seat + 1) && g.turn !== id, `after ${id} bid the turn is ${g.turn}`);
      must(g.until === now + TURN_MS, 'bidding did not restart the clock');
      stats.bids++;
    };
  };

  const preLiar = (id: string): Check => {
    if (!(g.phase === 'bid' && g.turn === id && g.bid)) return (changed) => must(!changed, 'a call was accepted out of turn or with no bid');
    const bid = g.bid;
    const caller = g.players[seatOf(id)];
    let count = 0;
    for (const p of g.players) for (const d of p.dice) if (d === bid.face) count++;
    const truth = count >= bid.n;
    const loser = truth ? caller : g.players.find((p) => p.id === bid.by) ?? null;
    const tot = total();
    const counts = new Map(g.players.map((p) => [p.id, p.count]));
    const hands = json(g.players.filter((p) => p.count > 0).map((p) => ({ id: p.id, name: p.name, dice: p.dice })));
    return (changed) => {
      must(changed, 'a legal call was refused');
      const rv = g.reveal;
      must(rv && g.phase === 'reveal' && g.turn === null && g.until === now + REVEAL_MS, 'a call did not open the reveal');
      must(rv.count === count && rv.truth === truth && rv.caller.id === id, `reveal says ${json([rv.count, rv.truth, rv.caller.id])}, should be ${json([count, truth, id])}`);
      must((rv.loser?.id ?? null) === (loser?.id ?? null), `loser is ${rv.loser?.id}, should be ${loser?.id}`);
      must(json(rv.hands) === hands, 'the reveal does not show the true hands');
      must(json({ n: rv.bid.n, face: rv.bid.face }) === json(lastBid), 'the reveal shows a different bid');
      must(total() === tot - (loser ? 1 : 0), `dice on the table went from ${tot} to ${total()}`);
      for (const p of g.players) must(p.count === counts.get(p.id)! - (p === loser ? 1 : 0), `${p.id} has ${p.count} dice after the call`);
      const from = loser ?? caller;
      starter = from.count > 0 ? from.id : fromSeat(seatOf(from.id) + 1);
      must(starter !== null && g.starter === starter, `next opener is ${g.starter}, should be ${starter}`);
      stats.calls++;
      if (truth) stats.trueBids++;
      if (!loser) stats.bidderGone++;
    };
  };

  const preLeave = (id: string): Check => {
    const seat = seatOf(id);
    if (seat < 0) return (changed) => must(!changed, 'someone not in the game left it');
    const was = g.phase;
    const tot = total();
    const held = g.players[seat].count;
    const turn = g.turn;
    const until = g.until;
    const rest = g.players.filter((p) => p.count > 0 && p.id !== id);
    const kept = json([g.bid, g.reveal, g.round]);
    return (changed) => {
      must(changed && seatOf(id) < 0, 'leaving did not remove the player');
      if (was === 'lobby') return must(g.phase === 'lobby', 'leaving the lobby started something');
      stats.leavesMidGame++;
      // Bidding cannot go on with one player holding dice: they win at once.
      if (was === 'bid' && rest.length < DICE_MIN) return ended(rest[0]?.id ?? null);
      must(g.phase === was && total() === tot - held, `dice went from ${tot} to ${total()} when ${held} left`);
      must(json([g.bid, g.reveal, g.round]) === kept, 'leaving changed the bid, the reveal or the round');
      if (starter === id) starter = fromSeat(seat);
      must(g.starter === starter, `next opener is ${g.starter}, should be ${starter}`);
      if (was === 'bid' && turn === id) must(g.turn === fromSeat(seat) && g.until === now + TURN_MS, `turn went to ${g.turn} after ${id} left on their turn`);
      else must(g.turn === turn && g.until === until, 'someone else leaving moved the turn or the clock');
    };
  };

  const preTick = (): Check => {
    if (g.phase === 'lobby' || now < g.until) return (changed) => must(!changed, 'the clock changed the game before the deadline');
    if (g.phase === 'reveal') {
      const still = alive();
      const round = g.round;
      const tot = total();
      return (changed) => {
        must(changed, 'the reveal did not end at its deadline');
        if (still.length < DICE_MIN) return ended(still[0]?.id ?? null);
        must(g.phase === 'bid' && g.round === round + 1 && g.bid === null && g.reveal === null && g.until === now + TURN_MS, 'the reveal did not give way to a fresh round');
        must(total() === tot, 'a new round changed the number of dice');
        must(g.turn === starter, `${g.turn} opens the round, should be ${starter}`);
        lastBid = null;
        stats.rounds++;
      };
    }
    // An idle turn: the lowest bid if there is none, otherwise a call.
    must(g.turn, 'bidding with nobody on turn');
    if (g.bid) stats.autoCalls++;
    else stats.autoBids++;
    return g.bid ? preLiar(g.turn) : preBid(g.turn, 1, 1);
  };

  const check = () => {
    must(serverDraws === shadowDraws, `server drew ${serverDraws} random numbers, the rules ${shadowDraws}`);
    must(new Set(g.players.map((p) => p.id)).size === g.players.length && g.players.length <= DICE_MAX, 'a player is in twice, or too many are in');
    for (const p of g.players) {
      must(room.here(p.id), `${p.id} is in the game but not in the room`);
      must(Number.isInteger(p.count) && p.count >= 0 && p.count <= DICE_START, `${p.id} has ${p.count} dice`);
    }
    if (g.phase === 'lobby') must(g.turn === null && g.bid === null && total() === 0 && g.players.every((p) => !p.dice.length), 'the lobby has a game half left in it');
    else must(g.starter === starter, `next opener is ${g.starter}, should be ${starter}`);
    if (g.phase === 'bid') {
      must(alive().length >= DICE_MIN, 'bidding with fewer than two players holding dice');
      const on = g.players.find((p) => p.id === g.turn);
      must(on && on.count > 0, `the turn belongs to ${g.turn}, who has no dice`);
      for (const p of g.players) must(p.dice.length === p.count && p.dice.every((d) => Number.isInteger(d) && d >= 1 && d <= 6), `${p.id} holds ${json(p.dice)} with a count of ${p.count}`);
      must(json(g.bid && { n: g.bid.n, face: g.bid.face }) === json(lastBid) && g.reveal === null, `standing bid ${json(g.bid)}, expected ${json(lastBid)}`);
      // Never stuck: the player on turn always has a move (open with one 1, or call), and the clock makes it for them.
      must((late ? g.until > now - 101 : g.until > now) && g.until <= now + TURN_MS, `turn deadline is ${g.until - now} ms away`);
      const later = structuredClone(g);
      must(diceTick(later, g.until, rng(1)) && (later.phase === 'reveal' || later.turn !== g.turn), 'the turn deadline does not move the game on');
    }
    if (g.phase === 'reveal') {
      must(g.turn === null && g.reveal !== null, 'reveal with a turn or without hands');
      must((late ? g.until > now - 101 : g.until > now) && g.until <= now + REVEAL_MS, `reveal deadline is ${g.until - now} ms away`);
      const later = structuredClone(g);
      must(diceTick(later, g.until, rng(1)) && later.phase !== 'reveal', 'the reveal deadline does not move the game on');
    }
    const v = diceView(g, now);
    scan(v, [], 'view');
    must(v.total === total() && v.left >= 0 && v.left <= TURN_MS && (v.left === 0 || v.phase !== 'lobby'), `view total ${v.total}, left ${v.left}`);
    must((v.reveal !== null) === (g.phase === 'reveal'), 'the view shows hands outside the reveal, or hides them in it');
  };

  const act = (p: PlayerInfo, action: Record<string, unknown>) => {
    const was = g.phase;
    const before = json(g);
    const member = seatOf(p.id) >= 0;
    let changed = false;
    if (action.k === 'join') {
      changed = diceJoin(g, p);
      must(changed === (was === 'lobby' && !member && g.players.length - (changed ? 1 : 0) < DICE_MAX), `join was ${changed ? 'accepted' : 'refused'}`);
      if (changed) must(g.players.at(-1)!.id === p.id && g.players.at(-1)!.count === 0, 'a joiner was not seated last with no dice');
    } else if (action.k === 'leave') {
      const post = preLeave(p.id);
      changed = diceLeave(g, p.id, now);
      post(changed);
    } else if (action.k === 'start') {
      const ok = was === 'lobby' && member && g.players.length >= DICE_MIN;
      changed = diceStart(g, p.id, now, rnd);
      must(changed === ok, `start was ${changed ? 'accepted' : 'refused'}`);
      if (changed) {
        starter = g.players[0].id;
        lastBid = null;
        stats.rounds++;
        must(g.phase === 'bid' && g.round === 1 && g.turn === starter && g.winner === null && g.until === now + TURN_MS, 'a new game did not open with the first player');
        must(g.players.every((x) => x.count === DICE_START), 'not everyone started with five dice');
      }
    } else if (action.k === 'bid') {
      const post = preBid(p.id, action.n, action.face);
      changed = diceBid(g, p.id, action.n, action.face, now);
      post(changed);
    } else if (action.k === 'liar') {
      const post = preLiar(p.id);
      changed = diceLiar(g, p.id, now);
      post(changed);
    }
    if (!changed) {
      stats.refused++;
      must(json(g) === before, 'a refused action changed the state');
    }
    mirror('action', changed, was, () => server.onAction({ ...p }, action, now));
  };

  const tick = () => {
    const was = g.phase;
    const post = preTick();
    const changed = diceTick(g, now, rnd);
    post(changed);
    mirror('tick', changed, was, () => server.tick!(now));
  };

  const leaveRoom = (id: string) => {
    room.exit(id);
    const was = g.phase;
    const post = preLeave(id);
    const changed = diceLeave(g, id, now);
    post(changed);
    mirror('leaving the room', changed, was, () => server.onLeave(id, now));
  };

  /** Someone who matters right now (on turn, the last bidder, the next opener), or else anyone. */
  const someone = (anyone: PlayerInfo) => {
    const id = pick(r, [g.turn, g.turn, g.bid?.by, g.starter, null, null]);
    return room.people.find((p) => p.id === id) ?? anyone;
  };

  const steps = 60 + int(r, chance(r, 0.2) ? 900 : 300);
  for (let i = 0; i < steps; i++) {
    const anyone = room.people.length ? pick(r, room.people) : null;
    const onTurn = room.people.find((p) => p.id === g.turn) ?? null;
    const wasLate = late;
    const roll = r();
    if (!anyone || roll < 0.04) {
      if (room.people.length >= 11) continue;
      const p = room.enter();
      trail.push(`${p.id} enters the room`);
      const mark = room.out.length;
      server.onJoin!({ ...p }, now);
      // A newcomer hears about a game only if somebody is in it, privately, and never gets dice.
      const should = g.players.length ? [{ to: p.id, v: diceView(g, now) }] : [];
      must(json(room.out.slice(mark)) === json(JSON.parse(json(should))), () => `entering: the server sent ${json(room.out.slice(mark))}`);
      must(g.phase === 'reveal' || !json(room.out.slice(mark)).includes('"dice"'), 'a newcomer was sent dice');
    } else if (roll < 0.065) {
      const p = someone(anyone);
      trail.push(`${p.id} leaves the room (${p.id === g.turn ? 'on turn' : p.id === g.bid?.by ? 'last bidder' : 'other'})`);
      leaveRoom(p.id);
    } else if (roll < 0.15) {
      trail.push(`${anyone.id} joins`);
      act(anyone, { k: 'join' });
      if (chance(r, 0.2)) {
        trail.push(`${anyone.id} joins again`);
        act(anyone, { k: 'join' });
      }
    } else if (roll < 0.175) {
      const p = someone(anyone);
      trail.push(`${p.id} leaves the game`);
      act(p, { k: 'leave' });
      if (chance(r, 0.5)) {
        trail.push(`${p.id} tries to come straight back`);
        act(p, { k: 'join' });
      }
    } else if (roll < 0.25) {
      trail.push(`${anyone.id} starts`);
      act(anyone, { k: 'start' });
    } else if (roll < 0.66) {
      // Sensible play by whoever is on turn: raise a little, sometimes jump, sometimes call.
      if (!onTurn) continue;
      const tot = total();
      if (g.bid && chance(r, 0.25 + (0.6 * g.bid.n) / tot)) {
        trail.push(`${onTurn.id} calls liar on ${g.bid.n}x${g.bid.face}`);
        act(onTurn, { k: 'liar' });
      } else {
        const from = g.bid ?? { n: 1, face: 0 };
        const raise = chance(r, 0.5) ? (from.face < 6 ? { n: from.n, face: from.face + 1 + int(r, 6 - from.face) } : { n: from.n + 1, face: 1 + int(r, 6) }) : { n: from.n + 1 + int(r, 2), face: 1 + int(r, 6) };
        trail.push(`${onTurn.id} bids ${raise.n}x${raise.face}`);
        act(onTurn, { k: 'bid', ...raise });
      }
    } else if (roll < 0.72) {
      // Out of turn, or from someone who is not even playing.
      const action = chance(r, 0.5) ? { k: 'liar' } : { k: 'bid', n: 1 + int(r, 8), face: 1 + int(r, 6) };
      trail.push(`${anyone.id} tries ${json(action)}${anyone.id === g.turn ? ' (on turn)' : ''}`);
      act(anyone, action);
    } else if (roll < 0.8) {
      // Bids that are nearly right or plain rubbish, mostly from the player on turn so they get past the turn check.
      const p = onTurn && chance(r, 0.8) ? onTurn : anyone;
      const tot = total();
      const near = [0, -1, tot, tot + 1, 7, g.bid?.n ?? 1, (g.bid?.n ?? 1) - 1, g.bid?.face ?? 1, 1.5, 6, 1];
      const n = chance(r, 0.6) ? pick(r, near) : garbage(r);
      const face = chance(r, 0.6) ? pick(r, near) : garbage(r);
      trail.push(`${p.id} bids ${show(n)} x ${show(face)}`);
      act(p, { k: 'bid', n, face });
    } else if (roll < 0.85) {
      const k = chance(r, 0.6) ? pick(r, ['join', 'leave', 'start', 'bid', 'liar', 'spin', 'toString', '__proto__']) : garbage(r);
      const action = chance(r, 0.2) ? (Object.assign(Object.create({ k: 'bid', n: 1, face: 1 }), { face: garbage(r) }) as Record<string, unknown>) : { k, n: garbage(r), face: garbage(r) };
      trail.push(`${anyone.id} sends junk k=${typeof action.k === 'string' ? action.k : typeof action.k}`);
      act(anyone, action);
    } else if (roll < 0.89 && g.phase !== 'lobby' && !late) {
      // The server ticks every 100 ms, so whatever comes next can arrive just after a deadline that has not been acted on yet.
      now = Math.max(now, g.until + int(r, 101));
      late = true;
      stats.lateWindows++;
      trail.push('time runs just past the deadline, no tick yet');
    } else {
      const toDeadline = g.until - now;
      const dt = Math.max(0, pick(r, [0, 1, 100, 100, 3000, toDeadline - 1, toDeadline, toDeadline, toDeadline + 1, TURN_MS * 3, 86_400_000]));
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

  // Left alone, any game plays itself out on the clock and comes back to the lobby.
  late = false;
  tick();
  for (let k = 0; g.phase !== 'lobby'; k++) {
    must(k < 300, 'the game did not end after 300 deadlines with nobody playing');
    now = g.until + pick(r, [0, 1, 5000]);
    trail.push('deadline passes with nobody playing');
    tick();
    check();
  }
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

test(`dice: ${RUNS} seeded sessions of random and hostile play`, () => {
  simulate('dice', session);
  console.log(`dice sim: ${json(stats)}`);
  expect(stats.sessions).toBe(RUNS);
  // The run is only worth something if the interesting things really happened.
  if (RUNS >= 200) {
    expect(stats.games).toBeGreaterThan(RUNS);
    for (const k of ['wins', 'noWinner', 'trueBids', 'bidderGone', 'autoBids', 'autoCalls', 'leavesMidGame'] as const) expect(stats[k], k).toBeGreaterThan(0);
    expect(stats.calls).toBeGreaterThan(stats.trueBids);
  }
}, 3_600_000);
