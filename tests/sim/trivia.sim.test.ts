// Trivia night, played thousands of times by a seeded random crowd that also misbehaves.
// Two layers are driven with the same actions and the same random numbers: the rules (a "shadow" state the
// test can see into) and the real server factory behind a recording GameIO. After every step the shadow is
// checked against the game's invariants and a tally kept by the test, and the server's messages are checked
// against the shadow and searched for anything that would give an answer away.
//
//   SIM_RUNS=20000 npx vitest run tests/sim/trivia.sim.test.ts --silent=false     more sessions, with the counts
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/trivia.sim.test.ts     replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/trivia';
import { FINAL_MS, MAX_POINTS, MIN_POINTS, QUESTIONS, QUESTION_MS, REVEAL_MS, ROUNDS, newTrivia, triviaAnswer, triviaJoin, triviaLeave, triviaStart, triviaTick, triviaView } from '../../shared/minigames/trivia';

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
const SPAN = { lobby: 0, question: QUESTION_MS, reveal: REVEAL_MS, final: FINAL_MS };
const stats = { sessions: 0, late: 0, steps: 0, started: 0, finished: 0, abandoned: 0, questions: 0, right: 0, wrong: 0, refused: 0, timeouts: 0, bankRefills: 0 };

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
  const g = newTrivia();
  let now = T0 + int(r, 1e9);
  const inGame = (id: string) => g.players.some((p) => p.id === id);
  const nameOf = (id: string) => room.people.find((p) => p.id === id)!.name;

  // The test's own books, kept without looking at the rules' scores or answers.
  /** Scores, in the order people joined. */
  const tally = new Map<string, number>();
  /** This question's answers and what each will be worth at the reveal. */
  const answers = new Map<string, { choice: number; points: number }>();
  /** Questions asked since the bank was last refilled. */
  const asked = new Set<number>();

  const right = () => QUESTIONS[g.deck[g.round]][2];
  /** Everyone gets the public view; while a question is open, each person who has answered also gets their own copy. */
  const published = (): Sent[] => [
    { to: null, v: triviaView(g, now) },
    ...(g.phase === 'question' ? Object.keys(g.answers).map((id) => ({ to: id, v: triviaView(g, now, id) })) : []),
  ];
  const finalNotice = () => {
    const top = Math.max(0, ...tally.values());
    const won = [...tally].filter(([, s]) => top > 0 && s === top).map(([id]) => nameOf(id));
    if (!won.length) return 'Trivia night ended with nobody on the board';
    return tally.size === 1 ? `${won[0]} scored ${top} at trivia night` : `${won.join(' and ')} won trivia night with ${top} points`;
  };

  /** Nothing in what was just sent may give away the answer or anyone else's choice. */
  const inspect = (sent: Sent[]) => {
    for (const { to, v } of sent) {
      if (to === null) must(!('mine' in v), 'a broadcast carries somebody\'s own choice');
      else must(room.here(to), `a message went to ${to}, who has left`);
      if (v.phase !== 'reveal') must(!('correct' in v) && !('picks' in v) && !('gained' in v), `a ${v.phase} view carries the answers`);
      if (v.phase === 'question') {
        // Scores only move at the reveal, so they cannot be used to work out who was right.
        for (const p of v.players) must(p.score === tally.get(p.id), `${p.id}'s score moved while the question was open`);
        if ('mine' in v) must(to !== null && v.mine === answers.get(to)?.choice, `${to} was sent a choice that is not their own`);
      }
      if (v.phase !== 'final') must(!('winners' in v), 'winners outside the final ranking');
    }
  };

  /** Do one thing to both layers and compare. `rules` changes the shadow and says whether anything changed. */
  const both = (what: string, rules: () => boolean, call: () => void, starter?: PlayerInfo): boolean => {
    const was = g.phase;
    const before = json(g);
    const changed = rules();
    if (!changed) must(json(g) === before, `${what}: refused, but the state changed`);
    const notes: string[] = [];
    if (changed && starter) notes.push(`${starter.name} started trivia night: join at the signpost to play from the next question`);
    if (was === 'question' && g.phase === 'reveal') {
      stats.questions++;
      for (const [id, x] of answers) tally.set(id, tally.get(id)! + x.points);
    }
    if (was !== 'question' && g.phase === 'question') answers.clear();
    if (was !== 'final' && g.phase === 'final') {
      stats.finished++;
      notes.push(finalNotice());
    }
    if (was !== 'lobby' && was !== 'final' && g.phase === 'lobby') stats.abandoned++;
    const mark = room.out.length;
    const noted = room.notices.length;
    call();
    const got = room.out.slice(mark);
    const want = changed ? published() : [];
    must(json(got) === json(JSON.parse(json(want))), () => `${what}: the server sent ${json(got)} but should have sent ${json(want)}`);
    must(json(room.notices.slice(noted)) === json(notes), () => `${what}: notices ${json(room.notices.slice(noted))}, expected ${json(notes)}`);
    inspect(got);
    return changed;
  };

  const act = (p: PlayerInfo, action: Record<string, unknown>) => {
    const member = inGame(p.id);
    // What should happen, restated here rather than asked of the rules.
    let want = false;
    if (action.k === 'join') want = !member;
    else if (action.k === 'leave') want = member;
    else if (action.k === 'start') want = member && (g.phase === 'lobby' || g.phase === 'final');
    else if (action.k === 'answer') {
      const c = action.choice;
      want = g.phase === 'question' && now < g.until && g.playing.includes(p.id) && !answers.has(p.id) && (c === 0 || c === 1 || c === 2 || c === 3);
    }
    if (want && action.k === 'join') tally.set(p.id, 0);
    if (want && action.k === 'leave') {
      tally.delete(p.id);
      answers.delete(p.id);
    }
    if (want && action.k === 'start') for (const id of tally.keys()) tally.set(id, 0);
    if (want && action.k === 'answer') {
      const ok = g.options[action.choice as number] === right();
      const share = Math.min(1, Math.max(0, (g.until - now) / QUESTION_MS));
      answers.set(p.id, { choice: action.choice as number, points: ok ? MIN_POINTS + Math.round((MAX_POINTS - MIN_POINTS) * share) : 0 });
      stats[ok ? 'right' : 'wrong']++;
    }
    const changed = both(
      'action',
      () => {
        if (action.k === 'join') return triviaJoin(g, p);
        if (action.k === 'leave') return triviaLeave(g, p.id, now);
        if (action.k === 'start') return triviaStart(g, p.id, now, rnd);
        if (action.k === 'answer') return triviaAnswer(g, p.id, action.choice, now);
        return false;
      },
      () => server.onAction({ ...p }, action, now),
      action.k === 'start' ? p : undefined,
    );
    must(changed === want, `rules ${changed ? 'accepted' : 'refused'} it`);
    if (!changed) stats.refused++;
    else if (action.k === 'start') {
      stats.started++;
      // Ten different questions, none of them asked since the bank was last refilled.
      must(g.deck.length === ROUNDS && new Set(g.deck).size === ROUNDS, `deck is ${json(g.deck)}`);
      if (QUESTIONS.length - asked.size < ROUNDS) {
        asked.clear();
        stats.bankRefills++;
      }
      for (const q of g.deck) {
        must(Number.isInteger(q) && q >= 0 && q < QUESTIONS.length, `question ${q} is not in the bank`);
        must(!asked.has(q), `question ${q} repeated with ${QUESTIONS.length - asked.size} still unasked`);
        asked.add(q);
      }
      must(g.round === 0, 'a new game did not start at the first question');
    }
  };

  const tick = () => {
    const due = g.phase !== 'lobby' && now >= g.until;
    const was = g.phase;
    const round = g.round;
    const changed = both('tick', () => triviaTick(g, now, rnd), () => server.tick!(now));
    must(changed === due, `tick ${changed ? 'changed' : 'did not change'} the game`);
    if (!changed) return;
    stats.timeouts++;
    // One step at a time, in the only order there is.
    if (was === 'question') must(g.phase === 'reveal' && g.round === round, 'a timed-out question did not go to its reveal');
    else if (was === 'reveal') must(round + 1 < ROUNDS ? g.phase === 'question' && g.round === round + 1 : g.phase === 'final', `after reveal ${round + 1} came ${g.phase} ${g.round + 1}`);
    else must(g.phase === 'lobby', 'the final ranking did not give way to the lobby');
  };

  const leaveRoom = (id: string) => {
    room.exit(id);
    tally.delete(id);
    answers.delete(id);
    both('leaving the room', () => triviaLeave(g, id, now), () => server.onLeave(id, now));
  };

  const check = () => {
    must(serverDraws === shadowDraws, `server drew ${serverDraws} random numbers, the rules ${shadowDraws}`);
    must(json(g.players.map((p) => [p.id, p.score])) === json([...tally]), () => `scores ${json(g.players)} but the tally says ${json([...tally])}`);
    for (const p of g.players) must(room.here(p.id) && Number.isInteger(p.score) && p.score >= 0 && p.score <= MAX_POINTS * ROUNDS, `bad player ${json(p)}`);
    for (const id of g.playing) must(inGame(id), `${id} may answer but is not in the game`);
    const v = triviaView(g, now);
    scan(v, [], 'view');
    must(v.total === ROUNDS && v.span === SPAN[g.phase] && v.left >= 0 && v.left <= v.span, `clock ${v.left}/${v.span} in ${g.phase}`);
    if (g.phase === 'lobby') {
      must(v.round === 0 && v.question === null && !v.options.length && !v.playing.length && !v.answered.length, 'the lobby view shows a question');
      return;
    }
    must(g.players.length > 0, `${g.phase} with nobody playing`);
    must(v.round >= 1 && v.round <= ROUNDS, `round ${v.round}`);
    // Never stuck: this phase has a deadline ahead of us, and reaching it moves the game on.
    must(g.until > now && g.until <= now + SPAN[g.phase], `${g.phase} deadline is ${g.until - now} ms away`);
    const later = structuredClone(g);
    must(triviaTick(later, g.until, rng(1)) && (later.phase !== g.phase || later.round !== g.round), `the ${g.phase} deadline does not move the game on`);
    if (g.phase === 'final') return;
    // The shuffle kept all four options and still points at the right one.
    const q = QUESTIONS[g.deck[g.round]];
    must(v.question === q[1] && v.category === q[0], 'the view shows a different question');
    must(json([...g.options].sort()) === json([...q.slice(2)].sort()), `options ${json(g.options)} are not those of "${q[1]}"`);
    must(g.options[g.correct] === q[2], `"${g.options[g.correct]}" is marked right for "${q[1]}"`);
    must(json(Object.entries(g.answers)) === json([...answers]), () => `answers ${json(g.answers)} but the tally says ${json([...answers])}`);
    for (const id of Object.keys(g.answers)) must(g.playing.includes(id), `${id} answered without being asked`);
    if (g.phase === 'reveal') {
      must(v.correct === g.options.indexOf(q[2]), 'the reveal names the wrong option');
      must(json(v.picks) === json(Object.fromEntries([...answers].map(([id, x]) => [id, x.choice]))), 'the reveal shows the wrong picks');
      must(json(v.gained) === json(Object.fromEntries([...answers].map(([id, x]) => [id, x.points]))), 'the reveal shows the wrong points');
      return;
    }
    // While the question is open, nobody is left to wait for, and what people are shown does not depend on
    // the secrets at all: a game with a different right answer and different choices looks exactly the same.
    must(g.playing.some((id) => !g.answers[id]), 'everyone has answered but the question is still open');
    const twin = structuredClone(g);
    twin.correct = (g.correct + 1) % 4;
    for (const x of Object.values(twin.answers)) Object.assign(x, { choice: (x.choice + 1) % 4, points: x.points ? 0 : 777 });
    must(json(triviaView(twin, now)) === json(v), 'the public view depends on the answer or on what people chose');
    for (const p of room.people) {
      const mine = triviaView(g, now, p.id);
      if (twin.answers[p.id]) twin.answers[p.id].choice = g.answers[p.id].choice;
      must(json(triviaView(twin, now, p.id)) === json(mine), `${p.id}'s view depends on the answer or on what others chose`);
      if (twin.answers[p.id]) twin.answers[p.id].choice = (g.answers[p.id].choice + 1) % 4;
      must(('mine' in mine) === answers.has(p.id), `${p.id}'s own choice is ${'mine' in mine ? 'shown' : 'missing'}`);
    }
  };

  /** A deadline has passed but the server has not ticked yet: it only ticks every 100 ms, so actions can land in the gap. */
  let owed = false;
  const steps = 60 + int(r, chance(r, 0.1) ? 900 : 260);
  for (let i = 0; i < steps; i++) {
    const anyone = room.people.length ? pick(r, room.people) : null;
    const members = room.people.filter((p) => inGame(p.id));
    const waiting = room.people.filter((p) => g.phase === 'question' && g.playing.includes(p.id) && !g.answers[p.id]);
    const roll = r();
    if (!anyone || roll < 0.04) {
      if (room.people.length >= 7) continue;
      const p = room.enter();
      trail.push(`${p.id} enters the room`);
      const mark = room.out.length;
      server.onJoin!({ ...p }, now);
      // A newcomer hears about a game only if somebody is in it: the public view, privately.
      const want: Sent[] = g.players.length ? [{ to: p.id, v: triviaView(g, now) }] : [];
      must(json(room.out.slice(mark)) === json(JSON.parse(json(want))), 'a newcomer was sent the wrong thing');
      inspect(room.out.slice(mark));
    } else if (roll < (g.phase === 'lobby' ? 0.07 : 0.055)) {
      // Leaving the room: sometimes the last person everyone is waiting for, sometimes the only player.
      const p = waiting.length && chance(r, 0.4) ? pick(r, waiting) : members.length && chance(r, 0.5) ? pick(r, members) : anyone;
      trail.push(`${p.id} leaves the room`);
      leaveRoom(p.id);
    } else if (roll < (g.phase === 'lobby' ? 0.3 : 0.11)) {
      trail.push(`${anyone.id} joins`);
      act(anyone, { k: 'join' });
      if (chance(r, 0.2)) act(anyone, { k: 'join' });
    } else if (roll < (g.phase === 'lobby' ? 0.34 : 0.125)) {
      const p = waiting.length && chance(r, 0.4) ? pick(r, waiting) : anyone;
      trail.push(`${p.id} leaves the game`);
      act(p, { k: 'leave' });
      if (chance(r, 0.5)) {
        trail.push(`${p.id} comes straight back`);
        act(p, { k: 'join' });
      }
    } else if (roll < (g.phase === 'lobby' || g.phase === 'final' ? 0.6 : 0.19)) {
      trail.push(`${anyone.id} starts (${g.phase})`);
      act(anyone, { k: 'start' });
    } else if (roll < (g.phase === 'question' ? 0.72 : 0.24)) {
      // Mostly someone who still owes an answer, right about half the time; otherwise anyone, with anything.
      const p = waiting.length && chance(r, 0.85) ? pick(r, waiting) : anyone;
      const good = g.phase === 'question' ? g.options.indexOf(right()) : 0;
      const choice = chance(r, 0.08) ? garbage(r) : chance(r, 0.5) ? good : (good + 1 + int(r, 3)) % 4;
      trail.push(`${p.id} answers ${typeof choice === 'number' ? choice : typeof choice}`);
      act(p, { k: 'answer', choice });
      if (chance(r, 0.15)) act(p, { k: 'answer', choice: int(r, 4) }); // no changing your mind
    } else if (roll < (g.phase === 'question' ? 0.78 : 0.3)) {
      const k = chance(r, 0.5) ? pick(r, ['join', 'leave', 'start', 'answer', 'reveal', 'toString', '__proto__']) : garbage(r);
      const action = chance(r, 0.2) ? (Object.assign(Object.create({ k: 'answer', choice: 1 }), { n: garbage(r) }) as Record<string, unknown>) : { k, choice: garbage(r) };
      trail.push(`${anyone.id} sends junk k=${typeof action.k === 'string' ? action.k : typeof action.k}`);
      act(anyone, action);
    } else if (g.phase !== 'lobby' && !owed && roll > 0.96) {
      now = g.until + int(r, 101);
      trail.push('the deadline passes, but the server has not ticked yet');
      owed = true;
      stats.late++;
      stats.steps++;
      continue;
    } else {
      const toDeadline = g.phase === 'lobby' ? 1000 : g.until - now;
      const dt = Math.max(0, pick(r, [0, 1, 100, 100, 2500, 2500, toDeadline - 1, toDeadline, toDeadline, toDeadline + 1, QUESTION_MS * 3, 86_400_000]));
      now += dt;
      trail.push(`time +${dt}`);
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

  // Left alone, the game always finds its way back to the lobby.
  trail.push('everyone goes quiet');
  for (let n = 0; g.phase !== 'lobby'; n++) {
    must(n <= ROUNDS * 2 + 1, 'still not back in the lobby after every deadline a game can have');
    now = g.until + int(r, 3) * 50;
    tick();
    check();
  }
  // Then the room empties, in any order, and the game ends up clean.
  if (members0(room.people, inGame) && chance(r, 0.5)) {
    const p = pick(r, room.people.filter((x) => inGame(x.id)));
    trail.push(`${p.id} starts one last game`);
    act(p, { k: 'start' });
    check();
  }
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
const members0 = (people: PlayerInfo[], inGame: (id: string) => boolean) => people.some((p) => inGame(p.id));

test(`trivia: ${RUNS} seeded sessions of random and hostile play`, () => {
  simulate('trivia', session);
  console.log(`trivia sim: ${json(stats)}`);
  expect(stats.sessions).toBe(RUNS);
  // The run is only worth something if the interesting things really happened.
  if (RUNS >= 100) {
    expect(stats.finished).toBeGreaterThan(RUNS / 2);
    expect(stats.abandoned).toBeGreaterThan(0);
    expect(stats.right).toBeGreaterThan(RUNS);
    expect(stats.wrong).toBeGreaterThan(RUNS);
    expect(stats.bankRefills).toBeGreaterThan(0);
  }
}, 3_600_000);
