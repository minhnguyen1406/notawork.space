import { expect, test } from 'vitest';
import {
  FINAL_MS,
  MAX_POINTS,
  MIN_POINTS,
  QUESTIONS,
  QUESTION_MS,
  REVEAL_MS,
  ROUNDS,
  newTrivia,
  pointsFor,
  shuffleOptions,
  triviaAnswer,
  triviaJoin,
  triviaLeave,
  triviaStart,
  triviaTick,
  triviaView,
  triviaWinners,
  type TriviaGame,
} from '../../shared/minigames/trivia';

const ann = { id: 'a', name: 'Ann' };
const bao = { id: 'b', name: 'Bao' };
const chi = { id: 'c', name: 'Chi' };
/** A small repeatable random number generator. */
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const started = (people = [ann, bao, chi], seed = 7) => {
  const g = newTrivia();
  for (const p of people) triviaJoin(g, p);
  expect(triviaStart(g, people[0].id, 0, seeded(seed))).toBe(true);
  return g;
};
const wrong = (g: TriviaGame) => (g.correct + 1) % 4;
const score = (g: TriviaGame, id: string) => g.players.find((p) => p.id === id)!.score;
/** The right answer to the question now open, straight from the bank. */
const truth = (g: TriviaGame) => QUESTIONS[g.deck[g.round]][2];

test('the bank is big enough, well formed, and has plenty about Vietnam', () => {
  expect(QUESTIONS.length).toBeGreaterThanOrEqual(70);
  expect(QUESTIONS.filter((q) => q[0] === 'Vietnam').length).toBeGreaterThanOrEqual(12);
  expect(new Set(QUESTIONS.map((q) => q[1])).size).toBe(QUESTIONS.length);
  for (const q of QUESTIONS) {
    expect(q.length).toBe(6);
    expect(new Set(q.slice(2)).size, q[1]).toBe(4);
    for (const s of q) expect(s.trim().length, q[1]).toBeGreaterThan(0);
  }
});

test('shuffling keeps all four options and still points at the right one', () => {
  const rnd = seeded(1);
  const places = new Set<number>();
  for (const q of QUESTIONS) {
    for (let n = 0; n < 20; n++) {
      const { options, correct } = shuffleOptions(q, rnd);
      expect([...options].sort()).toEqual([...q.slice(2)].sort());
      expect(options[correct]).toBe(q[2]);
      places.add(correct);
    }
  }
  expect(places.size).toBe(4); // the right answer turns up in every position
  expect(shuffleOptions(QUESTIONS[0], () => 0.999999).options).toHaveLength(4);
});

test('in a real game the option marked correct is the bank answer, every round', () => {
  const g = started([ann], 3);
  const rnd = seeded(11);
  for (let r = 0; r < ROUNDS; r++) {
    expect(g.phase).toBe('question');
    expect(g.options[g.correct]).toBe(truth(g));
    expect(triviaView(g, g.until - 1).options).toEqual(g.options);
    triviaTick(g, g.until, rnd); // time out
    expect(triviaView(g, g.until - 1).options[triviaView(g, g.until - 1).correct!]).toBe(truth(g));
    triviaTick(g, g.until, rnd); // next question
  }
  expect(g.phase).toBe('final');
});

test('a game is ten different questions, and the next game uses fresh ones', () => {
  const g = started([ann]);
  expect(g.deck).toHaveLength(ROUNDS);
  expect(new Set(g.deck).size).toBe(ROUNDS);
  const seen = new Set(g.deck);
  const games = Math.floor(QUESTIONS.length / ROUNDS);
  for (let n = 1; n < games; n++) {
    g.phase = 'lobby';
    triviaStart(g, 'a', 0, seeded(n));
    for (const i of g.deck) {
      expect(seen.has(i)).toBe(false);
      seen.add(i);
    }
  }
  g.phase = 'lobby';
  expect(triviaStart(g, 'a', 0, seeded(99))).toBe(true); // starts over rather than running dry
  expect(new Set(g.deck).size).toBe(ROUNDS);
});

test('one player is enough, only someone who joined can start, and not mid-game', () => {
  const g = newTrivia();
  expect(triviaStart(g, 'a', 0)).toBe(false);
  expect(triviaJoin(g, ann)).toBe(true);
  expect(triviaJoin(g, ann)).toBe(false);
  expect(triviaStart(g, 'zed', 0)).toBe(false);
  expect(triviaStart(g, 'a', 0)).toBe(true);
  expect(triviaStart(g, 'a', 1)).toBe(false);
});

test('points scale with speed, from 1000 down to 500, and wrong answers score nothing', () => {
  expect(pointsFor(QUESTION_MS)).toBe(MAX_POINTS);
  expect(pointsFor(0)).toBe(MIN_POINTS);
  expect(pointsFor(QUESTION_MS / 2)).toBe(750);
  expect(pointsFor(QUESTION_MS * 9)).toBe(MAX_POINTS);
  const g = started();
  const right = g.correct;
  triviaAnswer(g, 'a', right, 0);
  triviaAnswer(g, 'b', right, QUESTION_MS - 3000);
  expect(score(g, 'a')).toBe(0); // nothing is added until the reveal
  triviaAnswer(g, 'c', wrong(g), 5000);
  expect(g.phase).toBe('reveal');
  expect(score(g, 'a')).toBe(1000);
  expect(score(g, 'b')).toBe(600);
  expect(score(g, 'c')).toBe(0);
});

test('one answer each, no changing, and nonsense is refused', () => {
  const g = started();
  for (const bad of [-1, 4, 1.5, '1', null, undefined, NaN, {}, [0]]) expect(triviaAnswer(g, 'a', bad, 10)).toBe(false);
  expect(triviaAnswer(g, 'zed', 0, 10)).toBe(false);
  expect(triviaAnswer(g, 'a', wrong(g), 10)).toBe(true);
  expect(triviaAnswer(g, 'a', g.correct, 20)).toBe(false);
  expect(g.answers.a.choice).toBe(wrong(g));
  expect(triviaAnswer(g, 'b', g.correct, QUESTION_MS)).toBe(false); // too late
});

test('the question ends early once everyone has answered, otherwise at 15 seconds', () => {
  const g = started();
  triviaAnswer(g, 'a', 0, 1000);
  triviaAnswer(g, 'b', 1, 2000);
  expect(g.phase).toBe('question');
  expect(triviaTick(g, 2500)).toBe(false);
  triviaAnswer(g, 'c', 2, 3000);
  expect(g.phase).toBe('reveal');
  expect(g.until).toBe(3000 + REVEAL_MS);

  const h = started();
  triviaAnswer(h, 'a', h.correct, 1000);
  expect(triviaTick(h, QUESTION_MS - 1)).toBe(false);
  expect(triviaTick(h, QUESTION_MS)).toBe(true);
  expect(h.phase).toBe('reveal');
  expect(score(h, 'a')).toBeGreaterThan(900);
});

test('while a question is open no view gives the answer away', () => {
  const g = started();
  const right = g.correct;
  triviaAnswer(g, 'a', right, 100);
  triviaAnswer(g, 'b', wrong(g), 200);
  const pub = triviaView(g, 300);
  expect(pub).not.toHaveProperty('correct');
  expect(pub).not.toHaveProperty('picks');
  expect(pub).not.toHaveProperty('gained');
  expect(pub).not.toHaveProperty('mine');
  expect(pub.answered.sort()).toEqual(['a', 'b']);
  expect(pub.players.every((p) => p.score === 0)).toBe(true); // a score moving would say who was right
  // Nothing in the public view changes with where the right answer is.
  const other = structuredClone(g);
  other.correct = wrong(g);
  expect(JSON.stringify(triviaView(other, 300))).toBe(JSON.stringify(pub));
  // My own copy adds my choice and nothing else.
  const mine = triviaView(g, 300, 'b');
  expect(mine.mine).toBe(wrong(g));
  expect({ ...mine, mine: undefined }).toEqual({ ...pub, mine: undefined });
  expect(triviaView(g, 300, 'c')).not.toHaveProperty('mine');
  expect(pub.options).toHaveLength(4);
  expect(pub.left).toBe(QUESTION_MS - 300);
  expect(pub.span).toBe(QUESTION_MS);
});

test('the reveal shows the right answer, who chose what, and the running scores', () => {
  const g = started();
  const right = g.correct;
  triviaAnswer(g, 'a', right, 0);
  triviaAnswer(g, 'b', wrong(g), 0);
  triviaTick(g, QUESTION_MS);
  const v = triviaView(g, QUESTION_MS + 1000);
  expect(v.phase).toBe('reveal');
  expect(v.correct).toBe(right);
  expect(v.options[v.correct!]).toBe(truth(g));
  expect(v.picks).toEqual({ a: right, b: (right + 1) % 4 });
  expect(v.gained).toEqual({ a: 1000, b: 0 });
  expect(v.players.map((p) => p.score)).toEqual([1000, 0, 0]);
  expect(v.left).toBe(REVEAL_MS - 1000);
});

test('ten questions, then the final ranking, then back to the lobby', () => {
  const g = started([ann, bao]);
  const rnd = seeded(5);
  let now = 0;
  for (let r = 0; r < ROUNDS; r++) {
    expect(triviaView(g, now).round).toBe(r + 1);
    triviaAnswer(g, 'a', g.correct, now + 1000);
    triviaAnswer(g, 'b', r === 0 ? g.correct : wrong(g), now + 2000);
    expect(g.phase).toBe('reveal');
    now = g.until;
    expect(triviaTick(g, now - 1, rnd)).toBe(false);
    expect(triviaTick(g, now, rnd)).toBe(true);
  }
  expect(g.phase).toBe('final');
  expect(score(g, 'a')).toBe(ROUNDS * pointsFor(QUESTION_MS - 1000));
  expect(triviaWinners(g).map((p) => p.id)).toEqual(['a']);
  expect(triviaView(g, now).winners).toEqual(['a']);
  expect(triviaAnswer(g, 'a', 0, now)).toBe(false);
  expect(triviaTick(g, now + FINAL_MS, rnd)).toBe(true);
  expect(g.phase).toBe('lobby');
  expect(triviaTick(g, now + FINAL_MS * 9, rnd)).toBe(false);
  // A new game wipes the scores.
  expect(triviaStart(g, 'b', now, rnd)).toBe(true);
  expect(g.players.every((p) => p.score === 0)).toBe(true);
});

test('a tie has two winners, and nobody wins on zero', () => {
  const g = started([ann, bao]);
  expect(triviaWinners(g)).toEqual([]);
  triviaAnswer(g, 'a', g.correct, 500);
  triviaAnswer(g, 'b', g.correct, 500);
  expect(triviaWinners(g).map((p) => p.id)).toEqual(['a', 'b']);
});

test('someone joining mid-game plays from the next question', () => {
  const g = started([ann, bao]);
  triviaJoin(g, chi);
  expect(g.playing).toEqual(['a', 'b']);
  expect(triviaAnswer(g, 'c', g.correct, 100)).toBe(false);
  // The question does not wait for the newcomer.
  triviaAnswer(g, 'a', 0, 200);
  triviaAnswer(g, 'b', 0, 300);
  expect(g.phase).toBe('reveal');
  triviaTick(g, g.until, seeded(2));
  expect(g.playing).toEqual(['a', 'b', 'c']);
  expect(triviaAnswer(g, 'c', g.correct, g.until - QUESTION_MS)).toBe(true);
  expect(g.answers.c.points).toBe(1000);
});

test('leaving never leaves the game waiting for someone who has gone', () => {
  const g = started();
  triviaAnswer(g, 'a', g.correct, 1000);
  triviaAnswer(g, 'b', wrong(g), 1000);
  expect(g.phase).toBe('question');
  expect(triviaLeave(g, 'c', 2000)).toBe(true); // the only one still thinking
  expect(g.phase).toBe('reveal');
  expect(triviaLeave(g, 'c', 2000)).toBe(false);
  // Leaving takes your pending answer with you.
  const h = started();
  triviaAnswer(h, 'a', h.correct, 0);
  triviaLeave(h, 'a', 100);
  expect(h.phase).toBe('question');
  expect(h.answers).toEqual({});
  expect(triviaView(h, 100).players.map((p) => p.id)).toEqual(['b', 'c']);
  // The last one out ends the game, and a fresh one can start.
  triviaLeave(h, 'b', 200);
  triviaLeave(h, 'c', 300);
  expect(h.phase).toBe('lobby');
  expect(triviaTick(h, 99_999)).toBe(false);
  triviaJoin(h, ann);
  expect(triviaStart(h, 'a', 400)).toBe(true);
});

test('if the only people left joined mid-question, it moves on at once', () => {
  const g = started([ann]);
  triviaJoin(g, bao);
  triviaLeave(g, 'a', 500);
  expect(g.phase).toBe('reveal');
  triviaTick(g, g.until, seeded(4));
  expect(g.playing).toEqual(['b']);
});

test('twenty players can play a whole game', () => {
  const people = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: `Player ${i}` }));
  const g = started(people);
  const rnd = seeded(8);
  let now = 0;
  while (g.phase !== 'final') {
    people.forEach((p, i) => triviaAnswer(g, p.id, i % 2 ? g.correct : wrong(g), now + i * 100));
    expect(g.phase).toBe('reveal');
    expect(Object.keys(triviaView(g, now).picks!)).toHaveLength(20);
    now = g.until;
    triviaTick(g, now, rnd);
  }
  expect(triviaWinners(g).map((p) => p.id)).toEqual(['p1']);
  expect(score(g, 'p0')).toBe(0);
});

test('the server broadcasts no answers while a question is open, and tells only me my choice', async () => {
  const { create } = await import('../../worker/src/minigames/trivia');
  const casts: any[] = [];
  const sends: { id: string; v: any }[] = [];
  const notices: string[] = [];
  const io = { players: () => [], send: (id: string, v: unknown) => sends.push({ id, v }), broadcast: (v: unknown) => casts.push(v), notice: (t: string) => notices.push(t), emote() {}, put() {}, nudge() {}, resetBall() {}, setScore() {} };
  const s = create(io as any);
  const A = { ...ann } as any;
  const B = { ...bao } as any;
  s.onAction(A, { k: 'join' }, 0);
  s.onAction(B, { k: 'join' }, 0);
  s.onAction(A, { k: 'start' }, 0);
  s.onAction(A, { k: 'answer', choice: 2 }, 1000);
  s.onAction(A, { k: 'answer', choice: 3 }, 1500); // ignored: no changing
  for (const v of casts) {
    expect(v).not.toHaveProperty('mine');
    if (v.phase === 'question') expect(v).not.toHaveProperty('correct');
  }
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ id: 'a', v: { mine: 2, phase: 'question' } });
  expect(sends[0].v).not.toHaveProperty('correct');
  s.onAction(B, { k: 'answer', choice: 0 }, 2000);
  const last = casts.at(-1);
  expect(last.phase).toBe('reveal');
  expect(last.picks).toEqual({ a: 2, b: 0 });
  // Play it out on the clock alone: the game finishes, announces, and returns to the lobby.
  for (let now = 2000; now < 400_000 && casts.at(-1).phase !== 'final'; now += 100) s.tick!(now);
  expect(casts.at(-1).phase).toBe('final');
  expect(notices.some((n) => n.includes('trivia night') && !n.includes('started'))).toBe(true);
  s.onLeave('a', 400_000);
  s.onLeave('b', 400_000);
  expect(casts.at(-1)).toMatchObject({ phase: 'lobby', players: [] });
});
