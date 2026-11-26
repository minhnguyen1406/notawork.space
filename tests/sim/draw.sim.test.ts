// Draw and guess, played thousands of times by a seeded random crowd that also misbehaves.
// Two layers are driven with the same actions and the same random numbers: the rules (a "shadow" state the
// test can see into) and the real server factory behind a recording GameIO. After every step the shadow is
// checked against the game's invariants and the server's messages are checked against the shadow.
//
//   SIM_RUNS=20000 npx vitest run tests/sim/draw.sim.test.ts     more sessions
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/draw.sim.test.ts     replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/draw';
import {
  DRAWER_POINTS, DRAW_MIN, FINAL_MS, GUESS_GAP_MS, GUESS_MIN, GUESS_SPEED, MAX_GUESS, MAX_INK, MAX_MSGS_PER_SEC, MAX_MSG_POINTS, MAX_STROKES, PALETTE, REVEAL_MS,
  TURN_MS, WIDTHS, WORDS, drawClear, drawGuess, drawInk, drawJoin, drawLeave, drawStart, drawTick, drawUndo, drawView, newDraw,
} from '../../shared/minigames/draw';

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
    // The spy remembers every call; forget them each session or a long run exhausts memory.
    spy.mockClear();
    const seed = SEED0 + i;
    const trail: string[] = [];
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
const stats = {
  sessions: 0, steps: 0, games: 0, finals: 0, turns: 0, right: 0, wrong: 0, hints: 0, stopped: 0, drawerLeft: 0, inks: 0, undos: 0, clears: 0, syncs: 0,
  capRate: 0, capInk: 0, capStrokes: 0, capPoints: 0, capGuess: 0, capGap: 0, notDrawer: 0, cameBackKnowing: 0, midJoinDrew: 0, late: 0, lateGuess: 0, refused: 0,
};

const isIndex = (v: unknown, n: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n;
/** Every piece of text in a message (not the keys, and not the numbers of a picture). */
function texts(v: unknown, into: string[] = []): string[] {
  if (typeof v === 'string') into.push(v);
  else if (Array.isArray(v)) {
    if (typeof v[0] !== 'number') for (const x of v) texts(x, into);
  } else if (v && typeof v === 'object') for (const x of Object.values(v)) texts(x, into);
  return into;
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
  const g = newDraw();
  let now = T0 + int(r, 1e9);
  /** Some sessions have a drawer who never stops, to reach the caps on a picture. */
  const artist = chance(r, 0.12);
  const dots = chance(r, 0.5);

  const inGame = (id: string) => g.players.some((p) => p.id === id);
  const playing = () => g.phase === 'turn' || g.phase === 'reveal';
  const nameOf = (id: string) => g.players.find((p) => p.id === id)!.name;

  // ---- My own book-keeping, kept apart from the rules' state, to check it against. ----
  const scores = new Map<string, number>();
  /** One entry per stay in the game: whether they are due a turn this game, and how many they have had. */
  const stay = new Map<string, { due: boolean; drew: number; joinedMidGame: boolean }>();
  let myDone = 0;
  let myHints = 0;
  let seenTurn = 0;
  /** This turn: who knows the word (whether or not they are still here), when each last guessed, the drawer's messages. */
  let knowers = new Set<string>();
  let lastGuessAt = new Map<string, number>();
  let attempts: number[] = [];
  let accepted: number[] = [];
  let shownHint = '';
  const usedWords = new Set<string>();
  // ---- What the server remembers between calls, mirrored. ----
  let toldTurn = 0;
  let lastPhase = g.phase;
  const lastSync = new Map<string, number>();

  const waiting = () => g.players.filter((p) => stay.get(p.id)!.due && stay.get(p.id)!.drew === 0).map((p) => p.id);
  const allKnow = () => {
    const guessers = g.players.filter((p) => p.id !== g.drawer);
    return guessers.length > 0 && guessers.every((p) => knowers.has(p.id));
  };

  const picture = () => ({ t: 'strokes', turn: g.turn, strokes: g.strokes });
  /** What one person is sent to see the game as it stands. */
  const catchUp = (id: string): Sent[] => {
    const msgs: Sent[] = [];
    if (playing()) msgs.push({ to: id, v: picture() });
    if (g.phase === 'turn' && g.drawer === id) msgs.push({ to: id, v: { t: 'word', turn: g.turn, word: g.word } });
    msgs.push({ to: id, v: drawView(g, now) });
    return msgs;
  };
  let wantNotices: string[] = [];
  /** What the server sends after a change to the game. */
  const publish = (): Sent[] => {
    const msgs: Sent[] = [];
    if (g.phase === 'turn' && g.turn !== toldTurn) {
      toldTurn = g.turn;
      msgs.push({ to: null, v: picture() }, { to: g.drawer, v: { t: 'word', turn: g.turn, word: g.word } });
    }
    if (g.phase === 'final' && lastPhase !== 'final') {
      // The winners, from my own scores.
      const top = Math.max(0, ...scores.values());
      const names = g.players.filter((p) => scores.get(p.id) === top).map((p) => p.name);
      const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} tied` : `${names[0] ?? 'Nobody'} won`;
      wantNotices.push(`${who} at Draw and guess with ${names.length ? top : 0} points`);
    }
    if (g.phase === 'lobby' && (lastPhase === 'turn' || lastPhase === 'reveal')) wantNotices.push('Draw and guess stopped: not enough players left.');
    lastPhase = g.phase;
    msgs.push({ to: null, v: drawView(g, now) });
    return msgs;
  };

  /** Run something on the server and check exactly what it sent, and that none of it gives the word away. */
  const onServer = (run: () => void, want: Sent[], what: string) => {
    const mark = room.out.length;
    const noted = room.notices.length;
    run();
    const got = room.out.slice(mark);
    must(json(got) === json(JSON.parse(json(want))), () => `${what}: the server sent ${json(got).slice(0, 700)} but should have sent ${json(want).slice(0, 700)}`);
    must(json(room.notices.slice(noted)) === json(wantNotices), () => `${what}: notices ${json(room.notices.slice(noted))}, expected ${json(wantNotices)}`);
    wantNotices = [];
    for (const m of got) {
      // The word itself goes to the drawer alone, and only while they are drawing it.
      if (m.v.t === 'word') must(g.phase === 'turn' && m.to !== null && m.to === g.drawer && m.v.word === g.word && m.v.turn === g.turn, `the word was sent to ${m.to ?? 'everyone'}`);
      else if (g.phase === 'turn') {
        const word = g.word!;
        must(!texts(m.v).some((s) => s.toLowerCase().includes(word)), () => `"${word}" is in a ${m.v.t} message to ${m.to ?? 'everyone'}: ${json(m.v).slice(0, 300)}`);
        if (m.v.t === 'state') must(m.v.word === null, 'the view names the word during the turn');
      }
    }
  };

  /** A turn has just begun: check who is drawing what, and start this turn's book-keeping. */
  const turnBegan = () => {
    must(g.turn === seenTurn + 1, `turn number went from ${seenTurn} to ${g.turn}`);
    seenTurn = g.turn;
    const next = waiting()[0];
    must(g.phase === 'turn' && g.drawer !== null && g.drawer === next, `${g.drawer} is drawing, but ${next} is next in line`);
    const s = stay.get(g.drawer)!;
    s.drew++;
    if (s.joinedMidGame) stats.midJoinDrew++;
    must(typeof g.word === 'string' && WORDS.includes(g.word), `the word is ${g.word}`);
    if (usedWords.size === WORDS.length) usedWords.clear();
    must(!usedWords.has(g.word), `"${g.word}" came up again with ${WORDS.length - usedWords.size} words unused`);
    usedWords.add(g.word);
    must(g.until === now + TURN_MS && g.startAt === now, 'the turn clock is wrong');
    must(g.strokes.length === 0 && g.ink === 0 && g.guessed.length === 0 && g.feed.length === 0 && g.hints.length === 0, 'the new turn did not start clean');
    knowers = new Set();
    lastGuessAt = new Map();
    attempts = [];
    accepted = [];
    myHints = 0;
    shownHint = '_'.repeat([...g.word].length);
    stats.turns++;
  };
  const turnEnded = () => {
    must(g.phase === 'reveal' && g.until === now + REVEAL_MS && g.word !== null, `the turn should be over: ${json([g.phase, g.until - now])}`);
    myDone++;
    must(drawView(g, now).word === g.word, 'the reveal does not show the word');
  };
  const stopped = () => {
    must(g.phase === 'lobby' && g.drawer === null && g.word === null && g.queue.length === 0 && g.strokes.length === 0, 'the game should have stopped');
    stats.stopped++;
  };

  const check = (late = false) => {
    must(serverDraws === shadowDraws, `server drew ${serverDraws} random numbers, the rules ${shadowDraws}`);
    must(new Set(g.players.map((p) => p.id)).size === g.players.length, 'a player is in the game twice');
    for (const p of g.players) must(room.here(p.id), `${p.id} is in the game but not in the room`);
    // Scores are exactly what the stated formula has given out.
    must(json(g.players.map((p) => [p.id, p.score])) === json(g.players.map((p) => [p.id, scores.get(p.id)])), () => `scores are ${json(g.players)}, mine ${json([...scores])}`);
    const v = drawView(g, now);
    scan(v, [], 'view');
    must(v.feed.length <= 8 && v.feed.every((f) => (f.ok ? !('text' in f) : typeof f.text === 'string' && f.text.length <= MAX_GUESS)), 'the feed is wrong');
    must(json(v.guessed) === json([...knowers].filter(inGame)) || !playing(), () => `guessed shows ${json(v.guessed)}, mine ${json([...knowers])}`);
    must(v.word === (g.phase === 'reveal' ? g.word : null), 'the view shows the word at the wrong time');
    if (g.phase === 'lobby' || g.phase === 'final') must(g.drawer === null && g.word === null && v.hint === '', `${g.phase} still has a drawer or a word`);
    if (g.phase === 'lobby') {
      must(v.left === 0, 'the lobby has a clock');
      return;
    }
    // The picture stays inside its caps.
    must(g.strokes.length <= MAX_STROKES && g.ink <= MAX_INK && g.ink === g.strokes.reduce((n, s) => n + s.pts.length / 2, 0), `the picture has ${g.strokes.length} strokes and ${g.ink} points`);
    if (playing()) {
      must(g.players.length >= DRAW_MIN, `a game is on with ${g.players.length} players`);
      must(json(g.queue) === json(waiting()), () => `the queue is ${json(g.queue)}, but still to draw are ${json(waiting())}`);
      must(v.done === myDone && v.turns === myDone + waiting().length + (g.phase === 'turn' ? 1 : 0), `the view counts ${v.done} of ${v.turns} turns, I count ${myDone}`);
    }
    if (g.phase === 'turn') {
      must(g.drawer !== null && inGame(g.drawer) && !knowers.has(g.drawer), `the drawer ${g.drawer} is not playing`);
      // Hints: the word's length, only its own letters, never fewer than two hidden, and nothing taken back.
      const word = [...g.word!];
      const hint = [...v.hint];
      must(hint.length === word.length && hint.every((ch, i) => ch === '_' || ch === word[i]), `hint ${v.hint} for a word of ${word.length}`);
      must(hint.filter((ch) => ch === '_').length >= Math.min(2, word.length) && hint.filter((ch) => ch !== '_').length <= myHints, `hint ${v.hint} shows too much`);
      must([...shownHint].every((ch, i) => ch === '_' || ch === hint[i]), 'a hint letter was hidden again');
      shownHint = v.hint;
      must(!allKnow(), 'everyone has guessed but the turn goes on');
    }
    // Never stuck: the phase has a deadline ahead of us, and the clock alone carries the game to the lobby.
    const span = g.phase === 'turn' ? TURN_MS : g.phase === 'reveal' ? REVEAL_MS : FINAL_MS;
    must((late || g.until > now) && g.until <= now + span && v.left === Math.max(0, g.until - now), `the ${g.phase} deadline is ${g.until - now} ms away`);
    const later = structuredClone({ ...g, strokes: [] });
    for (let i = 0; i < 2 * g.players.length + 4 && later.phase !== 'lobby'; i++) must(drawTick(later, Math.max(now, later.until), rng(1)), 'a deadline does not move the game on');
    must(later.phase === 'lobby', 'the clock never brings the game back to the lobby');
  };

  /** Someone goes, from the game or the room. Returns whether the game changed. */
  const leaving = (id: string): boolean => {
    const member = inGame(id);
    const was = { playing: playing(), phase: g.phase, until: g.until, drawer: g.drawer, turnDrawer: g.phase === 'turn' && g.drawer === id };
    const changed = drawLeave(g, id, now);
    must(changed === member, `leaving ${changed ? 'changed' : 'did not change'} the game`);
    if (!changed) return false;
    scores.delete(id);
    stay.delete(id);
    if (was.playing && g.players.length < DRAW_MIN) stopped();
    else if (was.phase === 'turn' && (was.turnDrawer || allKnow())) {
      turnEnded();
      if (was.turnDrawer) stats.drawerLeft++;
    } else must(g.phase === was.phase && g.until === was.until && g.drawer === was.drawer, 'someone leaving disturbed the turn');
    return true;
  };

  const act = (p: PlayerInfo, action: Record<string, unknown>) => {
    const k = action.k;
    const member = inGame(p.id);
    const drawing = g.phase === 'turn' && g.drawer === p.id;
    const digest = () => json({ ...g, rate: 0, strokes: g.strokes.length, last: g.strokes[g.strokes.length - 1]?.pts.length });
    const before = digest();
    let want: Sent[] = [];
    let refused = false;
    if (k === 'join') {
      const ok = drawJoin(g, p);
      must(ok === !member, `joining was ${ok ? 'accepted' : 'refused'}`);
      if (ok) {
        scores.set(p.id, 0);
        stay.set(p.id, { due: playing(), drew: 0, joinedMidGame: playing() });
        want = [...catchUp(p.id), ...publish()];
      } else refused = true;
    } else if (k === 'leave') {
      if (leaving(p.id)) want = publish();
      else refused = true;
    } else if (k === 'start') {
      const should = !playing() && member && g.players.length >= DRAW_MIN;
      const ok = drawStart(g, p.id, now, rnd);
      must(ok === should, `starting was ${ok ? 'accepted' : 'refused'}`);
      if (ok) {
        // Everyone in the game draws once, in the order they joined, from nought.
        for (const q of g.players) {
          scores.set(q.id, 0);
          stay.set(q.id, { due: true, drew: 0, joinedMidGame: false });
        }
        myDone = 0;
        must(g.drawer === g.players[0].id, 'the first to join does not draw first');
        turnBegan();
        stats.games++;
        want = publish();
      } else refused = true;
    } else if (k === 'guess') {
      const text = action.text;
      // The guess as it will be shown: outer spaces gone, inner runs of space made one.
      const shown = typeof text === 'string' ? text.split(/\s+/).filter(Boolean).join(' ') : '';
      const sayable = typeof text === 'string' && shown.length > 0 && shown.length <= MAX_GUESS;
      const may = g.phase === 'turn' && member && !drawing && !knowers.has(p.id);
      const spaced = now - (lastGuessAt.get(p.id) ?? -Infinity) >= GUESS_GAP_MS;
      const ok = may && sayable && spaced;
      const right = ok && shown.toLowerCase() === g.word;
      if (may && !sayable && typeof text === 'string' && shown.length > MAX_GUESS) stats.capGuess++;
      if (may && sayable && !spaced) stats.capGap++;
      if (g.phase === 'turn' && member && knowers.has(p.id)) stats.cameBackKnowing++;
      const was = { until: g.until, drawer: g.drawer! };
      const res = drawGuess(g, p.id, text, now);
      must(res === (right ? 'right' : ok ? 'wrong' : 'no'), `the guess was "${res}"`);
      if (!ok) refused = true;
      else {
        lastGuessAt.set(p.id, now);
        const line = g.feed[g.feed.length - 1];
        if (right) {
          // The stated formula: 40 at the buzzer rising to 100 at once, and 25 to the drawer.
          const part = Math.min(1, Math.max(0, (was.until - now) / TURN_MS));
          const points = GUESS_MIN + Math.round(GUESS_SPEED * part);
          must(points >= GUESS_MIN && points <= GUESS_MIN + GUESS_SPEED, `a guess worth ${points}`);
          if (now >= was.until) stats.lateGuess++;
          scores.set(p.id, scores.get(p.id)! + points);
          scores.set(was.drawer, scores.get(was.drawer)! + DRAWER_POINTS);
          knowers.add(p.id);
          must(json(line) === json({ name: p.name, ok: true }), `the feed says ${json(line)}`);
          if (allKnow()) turnEnded();
          else must(g.phase === 'turn' && g.until === was.until, 'a right guess disturbed the turn');
          stats.right++;
        } else {
          must(json(line) === json({ name: p.name, text: shown, ok: false }), `the feed says ${json(line)}`);
          must(g.phase === 'turn' && g.until === was.until, 'a wrong guess disturbed the turn');
          stats.wrong++;
        }
        want = publish();
      }
    } else if (k === 'draw') {
      const raw = action.pts;
      let ptsOk = Array.isArray(raw) && raw.length >= 2 && raw.length % 2 === 0 && raw.length <= MAX_MSG_POINTS * 2;
      if (ptsOk) for (let i = 0; i < (raw as unknown[]).length; i++) {
        const x = (raw as unknown[])[i];
        if (typeof x !== 'number' || !(x >= 0 && x <= 1)) ptsOk = false;
      }
      const n = ptsOk ? (raw as number[]).length / 2 : 0;
      const fresh = action.n === true || g.strokes.length === 0;
      const styleOk = !fresh || (isIndex(action.c, PALETTE.length) && isIndex(action.w, WIDTHS.length));
      const room1 = !fresh || g.strokes.length < MAX_STROKES;
      const inkOk = g.ink + n <= MAX_INK;
      const valid = drawing && ptsOk && styleOk && room1 && inkOk;
      const was = { strokes: g.strokes.length, len: g.strokes[g.strokes.length - 1]?.pts.length ?? 0, ink: g.ink };
      const prior = attempts.filter((t) => t > now - 1000).length;
      if (drawing) attempts.push(now);
      const ink = drawInk(g, p.id, action, now);
      if (!drawing) stats.notDrawer++;
      if (!valid) {
        must(ink === null, () => `a stroke that should be refused was accepted: ${json(action).slice(0, 200)} gave ${json(ink).slice(0, 200)}`);
        if (drawing && ptsOk && styleOk && !room1) stats.capStrokes++;
        if (drawing && ptsOk && styleOk && room1 && !inkOk) stats.capInk++;
        if (drawing && Array.isArray(raw) && raw.length > MAX_MSG_POINTS * 2) stats.capPoints++;
      } else if (!ink) {
        // The only other reason to refuse: too many messages from the drawer in the last second.
        must(prior >= MAX_MSGS_PER_SEC, `a good stroke was refused after only ${prior} messages in the last second`);
        stats.capRate++;
      }
      if (!ink) {
        refused = true;
        must(g.strokes.length === was.strokes && g.ink === was.ink, 'a refused stroke changed the picture');
      } else {
        accepted.push(now);
        const s = g.strokes[g.strokes.length - 1];
        must(g.strokes.length === was.strokes + (fresh ? 1 : 0) && ink.i === g.strokes.length - 1 && ink.o === (fresh ? 0 : was.len / 2), `stroke ${ink.i} from point ${ink.o}`);
        if (fresh) must(s.c === action.c && s.w === action.w, 'the new stroke has the wrong pen');
        must(ink.c === s.c && ink.w === s.w && g.ink === was.ink + n && ink.pts.length === n * 2, 'the relayed stroke is wrong');
        (raw as number[]).forEach((x, i) => must(ink.pts[i] === Math.round(x * 1000) / 1000 && s.pts[s.pts.length - n * 2 + i] === ink.pts[i], `point ${i} was relayed as ${ink.pts[i]}`));
        want = [{ to: null, v: { t: 'ink', turn: g.turn, ...ink } }];
        stats.inks++;
      }
    } else if (k === 'undo' || k === 'clear') {
      const valid = drawing && g.strokes.length > 0;
      const prior = attempts.filter((t) => t > now - 1000).length;
      if (valid) attempts.push(now);
      const was = { strokes: g.strokes.length, ink: g.ink, len: g.strokes[g.strokes.length - 1]?.pts.length ?? 0 };
      const ok = k === 'undo' ? drawUndo(g, p.id, now) : drawClear(g, p.id, now);
      if (!valid) must(!ok, `${k} was accepted from someone who may not`);
      else if (!ok) must(prior >= MAX_MSGS_PER_SEC, `${k} was refused after only ${prior} messages in the last second`);
      if (ok) {
        accepted.push(now);
        if (k === 'undo') must(g.strokes.length === was.strokes - 1 && g.ink === was.ink - was.len / 2, 'undo took the wrong amount away');
        else must(g.strokes.length === 0 && g.ink === 0, 'clear left something');
        want = [{ to: null, v: picture() }];
        stats[k === 'undo' ? 'undos' : 'clears']++;
      } else refused = true;
    } else if (k === 'sync') {
      // Anyone may ask for the picture again, but not in a flood.
      if (now - (lastSync.get(p.id) ?? 0) >= 500) {
        lastSync.set(p.id, now);
        want = catchUp(p.id);
        stats.syncs++;
      }
    } else refused = true;
    if (refused) {
      stats.refused++;
      must(digest() === before, 'a refused action changed the state');
    }
    // The drawer is held to a rate: never more than two windows' worth in any one second.
    must(accepted.filter((t) => t > now - 1000).length <= 2 * MAX_MSGS_PER_SEC, 'the drawer sent too many messages in a second');
    onServer(() => server.onAction({ ...p }, action, now), want, `action ${typeof k === 'string' ? k.slice(0, 12) : typeof k}`);
  };

  const tick = () => {
    const was = g.phase;
    const due = g.phase !== 'lobby' && now >= g.until;
    let hintsDue = myHints;
    if (!due && g.phase === 'turn') {
      const gone = (now - g.startAt) / TURN_MS;
      hintsDue = Math.max(myHints, gone >= 0.75 ? 2 : gone >= 0.5 ? 1 : 0);
    }
    const hinted = hintsDue > myHints;
    const changed = drawTick(g, now, rnd);
    must(changed === (due || hinted), `tick ${changed ? 'changed' : 'did not change'} the game`);
    if (due) {
      if (was === 'turn') turnEnded();
      else if (was === 'reveal') {
        if (waiting().length) turnBegan();
        else {
          must(g.phase === 'final' && g.until === now + FINAL_MS, 'the game should have gone to the final ranking');
          // Everyone who was due a turn and stayed has drawn exactly once.
          for (const q of g.players) must(stay.get(q.id)!.drew === (stay.get(q.id)!.due ? 1 : 0), `${q.id} drew ${stay.get(q.id)!.drew} times`);
          stats.finals++;
        }
      } else must(g.phase === 'lobby', 'the final ranking did not give way to the lobby');
    } else if (hinted) {
      myHints = hintsDue;
      stats.hints++;
    }
    onServer(() => server.tick!(now), changed ? publish() : [], 'tick');
  };

  const leaveRoom = (id: string) => {
    room.exit(id);
    lastSync.delete(id);
    const changed = leaving(id);
    onServer(() => server.onLeave(id, now), changed ? publish() : [], 'leaving the room');
  };

  /** A wrong guess that cannot contain the word by accident. */
  const safe = (s: unknown) => (typeof s === 'string' && g.word && s.toLowerCase().includes(g.word) ? '123' : s);
  const wrongGuess = (): unknown =>
    safe(pick(r, [() => String(int(r, 1000)), () => `${int(r, 99)}  \t ${int(r, 99)}`, () => '?', () => '9'.repeat(MAX_GUESS), () => '9'.repeat(MAX_GUESS + 1), () => ` ${'8 '.repeat(30)}`, () => '   ', () => garbage(r)])());
  const rightGuess = () => pick(r, [g.word!, g.word!.toUpperCase(), `  ${g.word} `, `\t${g.word![0].toUpperCase()}${g.word!.slice(1)}\n`]);
  const points = (n: number) => Array.from({ length: n * 2 }, () => (chance(r, 0.05) ? pick(r, [0, 1]) : r()));
  const stroke = (): Record<string, unknown> => {
    if (chance(r, 0.85)) return { k: 'draw', n: chance(r, 0.3), c: int(r, PALETTE.length), w: int(r, WIDTHS.length), pts: points(1 + int(r, MAX_MSG_POINTS)) };
    // A bad stroke of some kind.
    const pts = pick(r, [
      () => points(MAX_MSG_POINTS + 1), () => [0.5], () => [0.1, 0.2, 0.3], () => [], () => [0.5, 1.0001], () => [-0.001, 0.5], () => [0.5, NaN], () => [Infinity, 0], () => ['0.5', 0.5],
      () => [0.5, null], () => new Array(4), () => [[0.5, 0.5]], () => ({ length: 2, 0: 0.5, 1: 0.5 }), () => garbage(r),
    ])();
    return chance(r, 0.6) ? { k: 'draw', n: true, c: 0, w: 0, pts } : { k: 'draw', n: chance(r, 0.5) ? true : garbage(r), c: pick(r, [PALETTE.length, -1, 0.5, '0', garbage(r)]), w: pick(r, [WIDTHS.length, -1, 1.5, garbage(r)]), pts: points(2) };
  };

  const steps = 60 + int(r, chance(r, 0.2) ? 700 : 240);
  for (let i = 0; i < steps; i++) {
    const anyone = room.people.length ? pick(r, room.people) : null;
    const drawer = g.phase === 'turn' ? room.people.find((p) => p.id === g.drawer) ?? null : null;
    const guessers = g.phase === 'turn' ? room.people.filter((p) => inGame(p.id) && p.id !== g.drawer && !knowers.has(p.id)) : [];
    let roll = r();
    // The server only ticks every 100 ms, so an action can arrive just after a deadline and before the tick
    // that would have acted on it. Step past the deadline without ticking, act, and only then tick.
    const late = g.phase !== 'lobby' && chance(r, 0.04);
    if (late) {
      now = Math.max(now, g.until + int(r, 101));
      roll = 0.26 + r() * 0.74;
      trail.push('the deadline passes, and before the next tick:');
      stats.late++;
    }
    if (!anyone || roll < (room.people.length < 3 ? 0.25 : 0.03)) {
      if (room.people.length >= 7) continue;
      const p = room.enter();
      trail.push(`${p.id} enters the room`);
      // A newcomer hears about a game only if somebody is in it, and privately. They are never the drawer.
      onServer(() => server.onJoin!({ ...p }, now), g.players.length ? catchUp(p.id) : [], 'entering the room');
    } else if (roll < 0.05) {
      const p = drawer && chance(r, 0.4) ? drawer : anyone;
      trail.push(`${p.id} leaves the room`);
      leaveRoom(p.id);
    } else if (roll < 0.075) {
      // Leaving the game, often to come straight back: the drawer, or someone who has just got the word.
      const knows = room.people.filter((p) => inGame(p.id) && knowers.has(p.id));
      const p = drawer && chance(r, 0.3) ? drawer : knows.length && chance(r, 0.5) ? pick(r, knows) : anyone;
      trail.push(`${p.id} leaves the game`);
      act(p, { k: 'leave' });
      if (chance(r, 0.7)) {
        trail.push(`${p.id} comes straight back`);
        act(p, { k: 'join' });
        if (g.phase === 'turn' && chance(r, 0.7)) {
          trail.push(`${p.id} guesses the word again`);
          act(p, { k: 'guess', text: rightGuess() });
        }
      }
    } else if (roll < (artist ? 0.12 : 0.2)) {
      // Time: small steps, the hint times, and up to and across the deadline.
      const toDeadline = g.until - now;
      const toHint = g.startAt + TURN_MS * pick(r, [0.5, 0.75]) - now;
      const dt = Math.max(0, artist ? pick(r, [0, 20, 100, 300, 1000]) : pick(r, [0, 1, 100, 300, 1000, 5000, toHint - 1, toHint, toDeadline - 1, toDeadline, toDeadline, toDeadline + 1, TURN_MS * 3, 86_400_000]));
      now += dt;
      trail.push(`time +${dt}`);
      tick();
    } else if (roll < 0.26) {
      // Nonsense: unknown actions, junk in every field, the right action from the wrong person.
      const k = chance(r, 0.8) ? pick(r, ['join', 'start', 'guess', 'draw', 'undo', 'clear', 'sync', 'toString', '__proto__']) : garbage(r);
      const action: Record<string, unknown> = chance(r, 0.15)
        ? Object.assign(Object.create({ k: pick(r, ['draw', 'guess', 'start', 'undo']), n: true, c: 1, w: 1, pts: [0.5, 0.5], text: '77' }), chance(r, 0.5) ? { pts: garbage(r) } : {})
        : { ...stroke(), k, text: chance(r, 0.5) ? wrongGuess() : garbage(r) };
      trail.push(`${anyone.id} sends junk ${typeof action.k === 'string' ? action.k : typeof action.k}`);
      act(anyone, action);
    } else if (g.phase === 'lobby' || g.phase === 'final') {
      const what = pick(r, ['join', 'join', 'join', 'start', 'start', 'sync']);
      trail.push(`${anyone.id}: ${what}`);
      act(anyone, { k: what });
      if (what === 'join' && chance(r, 0.1)) act(anyone, { k: 'join' });
    } else if (g.phase === 'reveal') {
      // Nothing much can be done between turns, but people try.
      const what = pick(r, ['join', 'guess', 'draw', 'undo', 'sync', 'start']);
      trail.push(`${anyone.id} tries ${what} between turns`);
      act(anyone, what === 'draw' ? stroke() : { k: what, text: g.word });
    } else if (roll < (artist ? 0.8 : 0.5) && drawer) {
      const what = r();
      if (what < (artist ? 0.75 : 0.25)) {
        // A burst of drawing, faster than the rate allows, with the clock running.
        const many = 10 + int(r, 60);
        trail.push(`${drawer.id} scribbles ${many} messages`);
        for (let j = 0; j < many && g.phase === 'turn' && g.drawer === drawer.id; j++) {
          act(drawer, artist && dots ? { k: 'draw', n: true, c: int(r, PALETTE.length), w: int(r, WIDTHS.length), pts: points(1) } : { k: 'draw', n: chance(r, 0.2), c: 0, w: 1, pts: points(artist ? MAX_MSG_POINTS : 1 + int(r, MAX_MSG_POINTS)) });
          if (chance(r, 0.8)) {
            now += pick(r, [0, 5, 20, 34, 40, 60]);
            tick();
          }
        }
      } else if (what < 0.85) {
        trail.push(`${drawer.id} draws`);
        act(drawer, stroke());
      } else {
        const k = pick(r, artist ? ['undo', 'sync'] : ['undo', 'undo', 'clear', 'sync']);
        trail.push(`${drawer.id}: ${k}`);
        act(drawer, { k });
      }
    } else if (roll < 0.9) {
      // Guessing: mostly people who may, sometimes the drawer or someone watching.
      const p = guessers.length && chance(r, 0.9) ? pick(r, guessers) : anyone;
      const text = chance(r, 0.3) ? rightGuess() : wrongGuess();
      trail.push(`${p.id} guesses ${typeof text === 'string' ? json(text.slice(0, 20)) : typeof text}`);
      act(p, { k: 'guess', text });
      if (chance(r, 0.15)) {
        trail.push(`${p.id} guesses again at once`);
        act(p, { k: 'guess', text: chance(r, 0.5) ? rightGuess() : wrongGuess() });
      }
    } else {
      // Other people's hands on the picture, late joiners, and requests for the picture.
      const k = pick(r, ['draw', 'undo', 'clear', 'join', 'join', 'sync', 'sync', 'start']);
      trail.push(`${anyone.id} tries ${k}`);
      act(anyone, k === 'draw' ? { k, n: true, c: 0, w: 0, pts: [0.5, 0.5] } : { k });
    }
    if (late) {
      trail.push('tick');
      tick();
    }
    check();
    stats.steps++;
  }

  // Left alone, the clock finishes the game and returns to the lobby.
  for (let i = 0; i < 2 * g.players.length + 6 && g.phase !== 'lobby'; i++) {
    now = Math.max(now, g.until + (i % 2));
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

test('nothing fixed in a message could be mistaken for a secret word', () => {
  // The secrecy check searches the text of every message for the word, so no word may hide in a name or a label.
  const fixed = [...NAMES, 'state', 'strokes', 'ink', 'word', 'lobby', 'turn', 'reveal', 'final', 'p123456789'].map((s) => s.toLowerCase());
  expect(WORDS.filter((w) => fixed.some((f) => f.includes(w)))).toEqual([]);
  expect(WORDS.every((w) => /^[a-z ]{3,}$/.test(w))).toBe(true);
});

test(`draw: ${RUNS} seeded sessions of random and hostile play`, () => {
  simulate('draw', session);
  console.log(`draw sim: ${json(stats)}`);
  expect(stats.sessions).toBe(RUNS);
  // The run is only worth something if the interesting things really happened.
  if (RUNS >= 300) {
    expect(stats.finals).toBeGreaterThan(RUNS / 2);
    for (const k of Object.keys(stats) as (keyof typeof stats)[]) expect(stats[k], k).toBeGreaterThan(0);
  }
}, 3_600_000);
