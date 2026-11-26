// Word clues, played thousands of times by a seeded random crowd that also misbehaves.
// Two layers are driven with the same actions and the same random numbers: the rules (a "shadow" state the
// test can see into) and the real server factory behind a recording GameIO. After every step the shadow is
// checked against the game's invariants and the server's messages are checked against the shadow.
//
//   SIM_RUNS=20000 npx vitest run tests/sim/words.sim.test.ts     more sessions
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/words.sim.test.ts     replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/words';
import {
  CLUE_MAX_LEN, CLUE_MS, GRID, GUESS_MS, IDLE_TURNS, WORDS_MAX, WORD_LIST, newWords, wordsClue, wordsEndTurn, wordsGuess, wordsJoin, wordsLeave, wordsStart,
  wordsSwitch, wordsTick, wordsView, wordsVolunteer, type Kind, type Team,
} from '../../shared/minigames/words';

// Read without Node's types, which this project does not install.
const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
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
    // The spy keeps a record of every call; dropped each session, or a long run exhausts memory.
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
const TEAMS = ['red', 'blue'] as const;
const stats = { sessions: 0, steps: 0, games: 0, won: 0, trap: 0, lastWordForThem: 0, short: 0, idle: 0, clues: 0, guesses: 0, timeouts: 0, refused: 0, promoted: 0, full: 0, late: 0 };

/** Is this a clue the rules should take? Written out again here rather than asked of clueProblem. */
function clueOk(grid: string[], word: unknown): boolean {
  if (typeof word !== 'string') return false;
  const w = word.trim().toLowerCase();
  if (w.length < 1 || w.length > CLUE_MAX_LEN) return false;
  for (const ch of w) if (ch < 'a' || ch > 'z') return false;
  return !grid.some((x) => w.indexOf(x) >= 0);
}

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
  const g = newWords();
  let now = T0 + int(r, 1e9);
  /** A few sessions fill the room, to reach the limit of twenty players. */
  const crowd = chance(r, 0.03) ? 24 : 5 + int(r, 6);
  const count = (t: Team) => g.players.filter((p) => p.team === t).length;
  const giverOf = (t: Team) => g.players.find((p) => p.team === t && p.giver) ?? null;
  const other = (t: Team): Team => (t === 'red' ? 'blue' : 'red');
  const left = (k: Kind) => g.map.filter((m, i) => m === k && !g.revealed[i]).length;
  /** My own count of turns that have timed out in a row. */
  let idle = 0;
  /** Who held the map in the game now on (they must all have been sent it). */
  let gaveMapTo = new Set<string>();

  /** What the server must send after a change: the public view to everyone, then the map to each clue-giver. */
  const published = (): Sent[] => {
    const msgs: Sent[] = [{ to: null, v: wordsView(g, now) }];
    if (g.phase !== 'lobby') for (const p of g.players) if (p.giver) msgs.push({ to: p.id, v: wordsView(g, now, p.id) });
    return msgs;
  };
  /** The server must have said exactly this since `mark`, and none of it may give the map away. */
  const said = (mark: number, want: Sent[], what: string) => {
    const got = room.out.slice(mark);
    must(json(got) === json(JSON.parse(json(want))), () => `${what}: the server sent ${json(got).slice(0, 600)} but should have sent ${json(want).slice(0, 600)}`);
    if (g.phase === 'lobby') return;
    // Secrecy, checked against the shadow's map rather than through wordsView.
    for (const m of got) {
      const giver = m.to !== null && !!g.players.find((p) => p.id === m.to)?.giver;
      const text = json(m.v);
      if (giver) {
        must(json(m.v.secret) === json(g.map), `clue-giver ${m.to} was sent the wrong map`);
        gaveMapTo.add(m.to!);
      } else {
        must(m.v.secret === null, `${m.to ?? 'everyone'} was sent the map`);
        // The trap is never face up while a game is on, so the word cannot appear in an honest message.
        must(!text.includes('trap'), `${m.to ?? 'everyone'} was told where the trap is`);
      }
      m.v.cells.forEach((c: any, i: number) => must(g.revealed[i] ? c.kind === g.map[i] && c.open : c.kind === null && !c.open, `card ${i} shows ${c.kind} to ${m.to ?? 'everyone'}`));
      must(m.v.result === null, 'a result is showing during a game');
    }
  };
  const noticed = (mark: number, want: string | null) => {
    const got = room.notices.slice(mark);
    must(json(got) === json(want === null ? [] : [want]), `notices were ${json(got)}, expected ${json(want)}`);
  };
  /** The notice for a game that has just ended. */
  const endNotice = (wasPlaying: boolean, byClock = false): string | null => {
    if (!wasPlaying || g.phase !== 'lobby') return null;
    must(g.result, 'a game ended without a result');
    if (!g.result.winner) return byClock ? 'Word clues stopped: nobody was playing' : 'Word clues stopped: a team ran short of players';
    return `${g.result.winner === 'red' ? 'Red' : 'Blue'} team won at word clues${g.result.reason === 'trap' ? ' (the other team hit the trap)' : ''}`;
  };
  const ended = (winner: Team | null, reason: string) => {
    must(g.phase === 'lobby' && g.clue === null && g.guesses === 0 && g.until === 0, `the game should be over (${reason}) but is ${json([g.phase, g.clue, g.guesses, g.until])}`);
    must(json(g.result) === json({ winner, reason }), `result is ${json(g.result)}, expected ${winner} by ${reason}`);
    // Once it is over the whole map shows to everyone.
    must(wordsView(g, now).cells.every((c, i) => c.kind === g.map[i]), 'the map is still hidden after the game');
    stats.games++;
  };
  const passed = (from: Team) => {
    must(g.phase === 'clue' && g.turn === other(from) && g.clue === null && g.guesses === 0 && g.until === now + CLUE_MS, `the turn should have passed from ${from}: ${json([g.phase, g.turn, g.clue, g.guesses, g.until - now])}`);
  };

  const check = () => {
    must(serverDraws === shadowDraws, `server drew ${serverDraws} random numbers, the rules ${shadowDraws}`);
    must(new Set(g.players.map((p) => p.id)).size === g.players.length, 'a player is in the game twice');
    must(g.players.length <= WORDS_MAX, `${g.players.length} players`);
    for (const p of g.players) must(room.here(p.id), `${p.id} is in the game but not in the room`);
    for (const t of TEAMS) must(g.players.filter((p) => p.team === t && p.giver).length === (count(t) ? 1 : 0), `${t} team of ${count(t)} has ${g.players.filter((p) => p.team === t && p.giver).length} clue-givers`);
    const v = wordsView(g, now);
    scan(v, [], 'view');
    if (g.grid.length) {
      // Any grid, in play or left over from the last game: 25 different words, split 9/8/7/1.
      must(g.grid.length === GRID && new Set(g.grid).size === GRID && g.grid.every((w) => WORD_LIST.includes(w)), 'the grid is not 25 different words from the list');
      const n = (k: Kind) => g.map.filter((m) => m === k).length;
      must(g.map.length === GRID && n(g.first) === 9 && n(other(g.first)) === 8 && n('neutral') === 7 && n('trap') === 1, `the deal is ${json([n(g.first), n(other(g.first)), n('neutral'), n('trap')])}`);
      must(g.revealed.length === GRID, 'revealed has the wrong length');
      must(v.remaining.red === left('red') && v.remaining.blue === left('blue'), 'the view miscounts the words left');
    }
    if (g.phase === 'lobby') {
      must(g.clue === null && g.guesses === 0 && v.left === 0 && v.guessesLeft === 0, 'the lobby has a clue or a clock');
      return;
    }
    must(count('red') >= 2 && count('blue') >= 2, `a game is on with teams of ${count('red')} and ${count('blue')}`);
    must(left('red') > 0 && left('blue') > 0 && left('trap') === 1, 'a game is on that should have ended');
    must(g.result === null, 'a result is set during a game');
    must(idle === g.idle && g.idle < IDLE_TURNS, `idle count is ${g.idle}, mine ${idle}`);
    if (g.phase === 'clue') must(g.clue === null && g.guesses === 0 && v.guessesLeft === 0, 'a clue is showing before it was given');
    else {
      must(g.clue !== null && g.clue.n >= 1 && g.clue.n <= 9 && /^[A-Z]{1,20}$/.test(g.clue.word), `clue is ${json(g.clue)}`);
      // The team may guess one more than the number, and the turn passes the moment that is used up.
      must(g.guesses >= 0 && g.guesses <= g.clue.n && v.guessesLeft === g.clue.n + 1 - g.guesses && v.guessesLeft >= 1, `guesses ${g.guesses} of ${g.clue.n}`);
    }
    // Never stuck: the phase has a deadline ahead of us, reaching it moves the game on, and a game left
    // alone is abandoned after a few turns.
    const span = g.phase === 'clue' ? CLUE_MS : GUESS_MS;
    must(g.until > now && g.until <= now + span && v.left === g.until - now, `the ${g.phase} deadline is ${g.until - now} ms away`);
    const later = structuredClone(g);
    for (let i = 0; i < IDLE_TURNS && later.phase !== 'lobby'; i++) must(wordsTick(later, later.until), 'a deadline does not move the game on');
    must(later.phase === 'lobby' && later.result?.winner === null, 'a game left alone never ends');
    // Everyone who holds the map has been sent it.
    for (const p of g.players) if (p.giver) must(gaveMapTo.has(p.id), `clue-giver ${p.id} was never sent the map`);
  };

  const act = (p: PlayerInfo, action: Record<string, unknown>) => {
    const me = g.players.find((x) => x.id === p.id) ?? null;
    const playing = g.phase !== 'lobby';
    const k = action.k;
    const myTurn = !!me && me.team === g.turn;
    const card = typeof action.i === 'number' && Number.isInteger(action.i) && action.i >= 0 && action.i < GRID ? action.i : -1;
    // What should happen, restated here rather than asked of the rules.
    let want = false;
    if (k === 'join') want = !playing && !me && g.players.length < WORDS_MAX;
    else if (k === 'leave') want = !!me;
    else if (k === 'switch') want = !playing && !!me;
    else if (k === 'giver') want = !playing && !!me && !me.giver;
    else if (k === 'start') want = !playing && !!me && count('red') >= 2 && count('blue') >= 2;
    else if (k === 'clue') want = g.phase === 'clue' && myTurn && me!.giver && typeof action.n === 'number' && Number.isInteger(action.n) && action.n >= 1 && action.n <= 9 && clueOk(g.grid, action.word);
    else if (k === 'guess') want = g.phase === 'guess' && myTurn && !me!.giver && card >= 0 && !g.revealed[card];
    else if (k === 'end') want = g.phase === 'guess' && myTurn && !me!.giver && g.guesses >= 1;

    const before = json(g);
    const was = { turn: g.turn, guesses: g.guesses, n: g.clue?.n ?? 0, until: g.until, phase: g.phase, kind: card >= 0 ? g.map[card] : null, smaller: (count('blue') < count('red') ? 'blue' : 'red') as Team, team: me?.team, giver: me?.giver, givers: json(TEAMS.map((t) => giverOf(t)?.id)) };
    let changed = false;
    let turned: Kind | null = null;
    if (k === 'join') changed = wordsJoin(g, p);
    else if (k === 'leave') changed = wordsLeave(g, p.id);
    else if (k === 'switch') changed = wordsSwitch(g, p.id);
    else if (k === 'giver') changed = wordsVolunteer(g, p.id);
    else if (k === 'start') changed = wordsStart(g, p.id, now, rnd);
    else if (k === 'clue') changed = wordsClue(g, p.id, action.word, action.n, now);
    else if (k === 'guess') changed = (turned = wordsGuess(g, p.id, action.i, now)) !== null;
    else if (k === 'end') changed = wordsEndTurn(g, p.id, now);
    must(changed === want, `rules ${changed ? 'accepted' : 'refused'} it`);
    if (!changed) {
      stats.refused++;
      must(json(g) === before, 'a refused action changed the state');
    } else if (k === 'join') {
      const mine = g.players[g.players.length - 1];
      must(mine.id === p.id && mine.team === was.smaller, `joined ${mine.team}, the smaller team was ${was.smaller}`);
      if (g.players.length === WORDS_MAX) stats.full++;
    } else if (k === 'switch') must(g.players.find((x) => x.id === p.id)!.team === other(was.team!), 'switching did not change team');
    else if (k === 'giver') must(giverOf(was.team!)?.id === p.id, 'the volunteer is not the clue-giver');
    else if (k === 'start') {
      must(g.phase === 'clue' && g.turn === g.first && g.clue === null && g.until === now + CLUE_MS && g.result === null && g.revealed.every((x) => !x), 'the game did not start cleanly');
      must(json(TEAMS.map((t) => giverOf(t)?.id)) === was.givers, 'starting changed the clue-givers');
      idle = 0;
      gaveMapTo = new Set();
    } else if (k === 'clue') {
      stats.clues++;
      idle = 0;
      must(g.phase === 'guess' && g.turn === was.turn && g.guesses === 0 && g.until === now + GUESS_MS && g.clue!.n === action.n && g.clue!.word === (action.word as string).trim().toUpperCase(), `after a clue: ${json([g.phase, g.turn, g.clue])}`);
    } else if (k === 'guess') {
      stats.guesses++;
      idle = 0;
      const mine = was.turn;
      const theirs = other(mine);
      must(turned === was.kind && g.revealed[card], `turned over ${turned}, the card was ${was.kind}`);
      if (was.kind === 'trap') {
        ended(theirs, 'trap');
        stats.trap++;
      } else if (was.kind === mine) {
        if (left(mine) === 0) {
          ended(mine, 'all');
          stats.won++;
        } else if (was.guesses + 1 > was.n) passed(mine);
        else must(g.phase === 'guess' && g.turn === mine && g.guesses === was.guesses + 1 && g.until === was.until, 'a right guess did not leave the team guessing');
      } else if (was.kind === theirs && left(theirs) === 0) {
        ended(theirs, 'all');
        stats.lastWordForThem++;
      } else passed(mine);
    } else if (k === 'end') passed(was.turn);
    else if (k === 'leave') {
      if (playing && (count('red') < 2 || count('blue') < 2)) {
        ended(null, 'short');
        stats.short++;
      } else {
        must(g.phase === was.phase && g.turn === was.turn && g.until === was.until && g.guesses === was.guesses, 'someone leaving disturbed the turn');
        if (playing && was.giver) stats.promoted++;
      }
    }
    const mark = room.out.length;
    const noted = room.notices.length;
    server.onAction({ ...p }, action, now);
    said(mark, changed ? published() : [], 'action');
    noticed(noted, changed ? endNotice(playing) : null);
  };

  const tick = () => {
    const playing = g.phase !== 'lobby';
    const due = playing && now >= g.until;
    const from = g.turn;
    const changed = wordsTick(g, now);
    must(changed === due, `tick ${changed ? 'changed' : 'did not change'} the game`);
    if (changed) {
      stats.timeouts++;
      if (++idle >= IDLE_TURNS) {
        ended(null, 'short');
        stats.idle++;
      } else passed(from);
    }
    const mark = room.out.length;
    const noted = room.notices.length;
    server.tick!(now);
    said(mark, changed ? published() : [], 'tick');
    noticed(noted, changed ? endNotice(playing, true) : null);
  };

  const leaveRoom = (id: string) => {
    room.exit(id);
    const playing = g.phase !== 'lobby';
    const was = g.players.find((p) => p.id === id);
    const changed = wordsLeave(g, id);
    must(changed === !!was, 'leaving the room and the rules disagree about who was playing');
    if (changed && playing) {
      if (count('red') < 2 || count('blue') < 2) {
        ended(null, 'short');
        stats.short++;
      } else if (was!.giver) stats.promoted++;
    }
    const mark = room.out.length;
    const noted = room.notices.length;
    server.onLeave(id, now);
    said(mark, changed ? published() : [], 'leaving the room');
    noticed(noted, changed ? endNotice(playing) : null);
  };

  const LETTERS = 'qxzjvkw';
  const goodClue = () => Array.from({ length: 2 + int(r, 7) }, () => pick(r, [...LETTERS])).join('');
  const badClue = (): unknown =>
    pick(r, [
      () => (g.grid.length ? pick(r, g.grid) : 'word'),
      () => (g.grid.length ? pick(r, g.grid).toUpperCase() : 'WORD'),
      () => `zz${g.grid.length ? pick(r, g.grid) : 'word'}q`,
      () => 'two words',
      () => 'abc1',
      () => 'q'.repeat(CLUE_MAX_LEN + 1),
      () => '   ',
      () => 'né',
      () => garbage(r),
    ])();

  const steps = 60 + int(r, chance(r, 0.2) ? 900 : 300);
  for (let i = 0; i < steps; i++) {
    const anyone = room.people.length ? pick(r, room.people) : null;
    const playing = g.phase !== 'lobby';
    const turnGiver = playing ? room.people.find((p) => p.id === giverOf(g.turn)?.id) ?? null : null;
    const turnGuessers = playing ? room.people.filter((p) => g.players.some((x) => x.id === p.id && x.team === g.turn && !x.giver)) : [];
    let roll = r();
    // The server only ticks every 100 ms, so an action can arrive just after a deadline and before the tick
    // that would have acted on it. Step past the deadline without ticking, act, and only then tick.
    const late = playing && chance(r, 0.05);
    if (late) {
      now = g.until + int(r, 101);
      roll = 0.24 + r() * 0.76;
      trail.push('the deadline passes, and before the next tick:');
      stats.late++;
    }
    if (!anyone || roll < (room.people.length < 4 || (crowd > WORDS_MAX && room.people.length < crowd) ? 0.3 : 0.04)) {
      if (room.people.length >= crowd) continue;
      const p = room.enter();
      trail.push(`${p.id} enters the room`);
      const mark = room.out.length;
      server.onJoin!({ ...p }, now);
      // A newcomer is never a clue-giver: the public view, privately, if anyone is playing.
      said(mark, g.players.length ? [{ to: p.id, v: wordsView(g, now) }] : [], 'entering the room');
    } else if (roll < 0.055) {
      // Leaving the room: often the clue-giver whose turn it is, or a guesser who is needed.
      const p = turnGiver && chance(r, 0.3) ? turnGiver : turnGuessers.length && chance(r, 0.3) ? pick(r, turnGuessers) : anyone;
      trail.push(`${p.id} leaves the room`);
      leaveRoom(p.id);
    } else if (roll < 0.075) {
      const p = turnGiver && chance(r, 0.3) ? turnGiver : anyone;
      trail.push(`${p.id} leaves the game`);
      act(p, { k: 'leave' });
      if (chance(r, 0.6)) {
        trail.push(`${p.id} tries to come straight back`);
        act(p, { k: 'join' });
      }
    } else if (roll < 0.17) {
      // Time, up to and across the deadline.
      const toDeadline = g.until - now;
      const dt = Math.max(0, pick(r, [0, 1, 100, 100, 5000, toDeadline - 1, toDeadline, toDeadline, toDeadline + 1, GUESS_MS * 3, 86_400_000]));
      now += dt;
      trail.push(`time +${dt}`);
      tick();
    } else if (roll < 0.24) {
      // Nonsense: unknown actions, junk in every field, the right action from the wrong person.
      const k = chance(r, 0.7) ? pick(r, ['join', 'leave', 'switch', 'giver', 'start', 'clue', 'guess', 'end', 'toString', '__proto__']) : garbage(r);
      const action: Record<string, unknown> = chance(r, 0.15)
        ? Object.assign(Object.create({ k: pick(r, ['guess', 'clue', 'start']), i: int(r, GRID), word: 'qqq', n: 2 }), chance(r, 0.5) ? { i: garbage(r) } : {})
        : { k, word: chance(r, 0.5) ? goodClue() : badClue(), n: chance(r, 0.5) ? 1 + int(r, 9) : garbage(r), i: chance(r, 0.5) ? int(r, GRID) : garbage(r) };
      if (k === 'leave' && chance(r, 0.8)) action.k = 'end';
      trail.push(`${anyone.id} sends junk ${typeof action.k === 'string' ? action.k : typeof action.k}`);
      act(anyone, action);
    } else if (!playing) {
      let what = pick(r, ['join', 'join', 'join', 'join', 'switch', 'giver', 'start', 'start', 'start']);
      // In a crowded session, hold the start back until the table is full.
      if (what === 'start' && crowd > WORDS_MAX && g.players.length < WORDS_MAX && chance(r, 0.95)) what = 'join';
      trail.push(`${anyone.id}: ${what}`);
      act(anyone, { k: what });
      if (what === 'join' && chance(r, 0.1)) act(anyone, { k: 'join' });
    } else if (g.phase === 'clue') {
      // Mostly the right clue-giver with a good clue.
      const p = turnGiver && chance(r, 0.85) ? turnGiver : anyone;
      const word = chance(r, 0.85) ? (chance(r, 0.2) ? `  ${goodClue().toUpperCase()} ` : goodClue()) : badClue();
      const n = chance(r, 0.9) ? 1 + int(r, chance(r, 0.7) ? 3 : 9) : pick(r, [0, 10, 1.5, -1, '2', NaN, garbage(r)]);
      trail.push(`${p.id} gives the clue ${typeof word === 'string' ? word.slice(0, 24) : typeof word} ${typeof n === 'number' ? n : typeof n}`);
      act(p, { k: 'clue', word, n });
    } else {
      const p = turnGuessers.length && chance(r, 0.85) ? pick(r, turnGuessers) : anyone;
      if (chance(r, 0.1)) {
        trail.push(`${p.id} ends the turn`);
        act(p, { k: 'end' });
      } else {
        // Guessers who mostly get it right, so that games are won as well as lost.
        const hidden = g.map.map((_, x) => x).filter((x) => !g.revealed[x]);
        const own = hidden.filter((x) => g.map[x] === g.turn);
        const at = chance(r, 0.7) && own.length ? pick(r, own) : chance(r, 0.85) ? pick(r, hidden) : pick(r, [int(r, GRID), -1, GRID, 2.5, '3', NaN, garbage(r)]);
        trail.push(`${p.id} turns over ${typeof at === 'number' ? `${at} (${g.map[at] ?? 'off the grid'})` : typeof at}`);
        act(p, { k: 'guess', i: at });
      }
    }
    if (late) {
      trail.push('tick');
      tick();
    }
    check();
    stats.steps++;
  }

  // Left alone, a game in progress is abandoned rather than holding the table for ever.
  for (let i = 0; i <= IDLE_TURNS && g.phase !== 'lobby'; i++) {
    now = g.until + (i % 2);
    trail.push('everyone goes quiet');
    tick();
    check();
  }
  must(g.phase === 'lobby', 'still playing after everyone went quiet');
  // Then the room empties, in any order.
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

test(`words: ${RUNS} seeded sessions of random and hostile play`, () => {
  simulate('words', session);
  console.log(`words sim: ${json(stats)}`);
  expect(stats.sessions).toBe(RUNS);
  // The run is only worth something if the interesting things really happened.
  if (RUNS >= 300) {
    expect(stats.games).toBeGreaterThan(RUNS);
    for (const k of ['won', 'trap', 'lastWordForThem', 'short', 'idle', 'promoted', 'timeouts', 'full', 'late'] as const) expect(stats[k], k).toBeGreaterThan(0);
  }
}, 3_600_000);
