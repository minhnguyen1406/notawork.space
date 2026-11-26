import { expect, test } from 'vitest';
import {
  DRAWER_POINTS, FINAL_MS, GUESS_GAP_MS, GUESS_MIN, GUESS_SPEED, MAX_INK, MAX_MSGS_PER_SEC, MAX_MSG_POINTS, PALETTE, REVEAL_MS, TURN_MS, WIDTHS, WORDS,
  drawClear, drawGuess, drawInk, drawJoin, drawLeave, drawRanking, drawStart, drawTick, drawUndo, drawView, drawWinners, guessPoints, newDraw,
} from '../../shared/minigames/draw';

const ann = { id: 'a', name: 'Ann' };
const bao = { id: 'b', name: 'Bao' };
const chi = { id: 'c', name: 'Chi' };
/** Three players, game started at time 0, Ann drawing the first word in the list. */
const three = () => {
  const g = newDraw();
  for (const p of [ann, bao, chi]) drawJoin(g, p);
  drawStart(g, 'a', 0, () => 0);
  return g;
};
const score = (g: ReturnType<typeof newDraw>, id: string) => g.players.find((p) => p.id === id)!.score;
const dot = (n = false) => ({ n, c: 0, w: 0, pts: [0.5, 0.5] });

test('the word list is long enough, simple and has no repeats', () => {
  expect(WORDS.length).toBeGreaterThanOrEqual(120);
  expect(new Set(WORDS).size).toBe(WORDS.length);
  for (const w of WORDS) expect(w).toMatch(/^[a-z]{3,}$/);
});

test('joining twice does nothing, and it takes two people who have joined to start', () => {
  const g = newDraw();
  expect(drawJoin(g, ann)).toBe(true);
  expect(drawJoin(g, ann)).toBe(false);
  expect(drawStart(g, 'a', 0)).toBe(false);
  drawJoin(g, bao);
  expect(drawStart(g, 'zed', 0)).toBe(false);
  expect(drawStart(g, 'b', 0)).toBe(true);
  expect(drawStart(g, 'a', 1)).toBe(false); // already going
  expect(g.phase).toBe('turn');
  expect(WORDS).toContain(g.word);
});

test('everyone draws once, in the order they joined, then the ranking shows and the lobby returns', () => {
  const g = three();
  const drawers: string[] = [];
  const words: string[] = [];
  let now = 0;
  while (g.phase !== 'final') {
    drawers.push(g.drawer!);
    words.push(g.word!);
    expect(drawTick(g, (now += TURN_MS), () => 0)).toBe(true); // time runs out
    expect(g.phase).toBe('reveal');
    expect(drawTick(g, now + REVEAL_MS - 1, () => 0)).toBe(false);
    expect(drawTick(g, (now += REVEAL_MS), () => 0)).toBe(true);
  }
  expect(drawers).toEqual(['a', 'b', 'c']);
  expect(new Set(words).size).toBe(3); // no word twice
  expect(drawView(g, now).done).toBe(3);
  expect(drawTick(g, now + FINAL_MS, () => 0)).toBe(true);
  expect(g.phase).toBe('lobby');
  expect(g.players).toHaveLength(3); // still joined for another game
});

test('a faster guess scores more, and the drawer scores for each person who gets it', () => {
  expect(guessPoints(TURN_MS)).toBe(GUESS_MIN + GUESS_SPEED);
  expect(guessPoints(0)).toBe(GUESS_MIN);
  const g = three();
  expect(drawGuess(g, 'b', g.word, 1000)).toBe('right');
  expect(g.phase).toBe('turn'); // Chi has not got it yet
  expect(drawGuess(g, 'c', g.word, 60_000)).toBe('right');
  expect(score(g, 'b')).toBeGreaterThan(score(g, 'c'));
  expect(score(g, 'c')).toBe(guessPoints(TURN_MS - 60_000));
  expect(score(g, 'a')).toBe(DRAWER_POINTS * 2);
  expect(g.phase).toBe('reveal'); // everyone has it: the turn ends early
  expect(drawRanking(g).map((p) => p.id)).toEqual(['b', 'c', 'a']);
  expect(drawWinners(g).map((p) => p.id)).toEqual(['b']);
});

test('guesses ignore case and spaces around them; wrong ones are shown, right ones are not', () => {
  const g = three();
  expect(drawGuess(g, 'b', '  Zebra ', 1000)).toBe('wrong');
  expect(drawView(g, 1000).feed).toEqual([{ name: 'Bao', text: 'Zebra', ok: false }]);
  expect(drawGuess(g, 'b', `  ${g.word!.toUpperCase()}  `, 2000)).toBe('right');
  expect(drawView(g, 2000).feed[1]).toEqual({ name: 'Bao', ok: true });
});

test('guesses that are not allowed change nothing', () => {
  const g = three();
  const word = g.word!;
  expect(drawGuess(g, 'a', word, 1000)).toBe('no'); // the drawer
  expect(drawGuess(g, 'zed', word, 1000)).toBe('no'); // not playing
  expect(drawGuess(g, 'b', 42, 1000)).toBe('no');
  expect(drawGuess(g, 'b', '   ', 1000)).toBe('no');
  expect(drawGuess(g, 'b', 'x'.repeat(41), 1000)).toBe('no');
  expect(drawGuess(g, 'b', 'zebra', 1000)).toBe('wrong');
  expect(drawGuess(g, 'b', word, 1000 + GUESS_GAP_MS - 1)).toBe('no'); // too soon after the last one
  expect(drawGuess(g, 'b', word, 1000 + GUESS_GAP_MS)).toBe('right');
  expect(drawGuess(g, 'b', word, 5000)).toBe('no'); // already has it, and must not type it out
  expect(g.feed).toHaveLength(2);
  expect(score(g, 'a')).toBe(DRAWER_POINTS);
  const idle = newDraw();
  drawJoin(idle, ann);
  expect(drawGuess(idle, 'a', 'cat', 0)).toBe('no'); // no turn going
});

test('the word is never in what everyone is sent until the turn is over', () => {
  const g = three();
  const word = g.word!;
  drawGuess(g, 'b', 'zebra', 1000);
  drawGuess(g, 'b', word, 2000);
  drawTick(g, TURN_MS * 0.8, () => 0);
  const v = drawView(g, TURN_MS * 0.8);
  expect(v.word).toBeNull();
  expect(JSON.stringify(v)).not.toContain(word);
  expect(v.hint).toHaveLength(word.length);
  drawTick(g, TURN_MS);
  expect(drawView(g, TURN_MS).word).toBe(word);
});

test('one letter is shown at half time and another at three quarters', () => {
  const g = three();
  const word = g.word!;
  const shown = (now: number) => [...drawView(g, now).hint].filter((ch) => ch !== '_').length;
  expect(drawTick(g, TURN_MS * 0.5 - 1, () => 0)).toBe(false);
  expect(drawView(g, 0).hint).toBe('_'.repeat(word.length));
  expect(drawTick(g, TURN_MS * 0.5, () => 0)).toBe(true);
  expect(shown(TURN_MS * 0.5)).toBe(1);
  expect(drawTick(g, TURN_MS * 0.6, () => 0)).toBe(false);
  expect(drawTick(g, TURN_MS * 0.75, () => 0)).toBe(true);
  expect(shown(TURN_MS * 0.75)).toBe(2);
  const hint = drawView(g, TURN_MS * 0.75).hint;
  [...hint].forEach((ch, i) => expect(ch === '_' || ch === word[i]).toBe(true));
});

test('a three-letter word keeps two letters hidden', () => {
  const g = three();
  g.word = 'cat';
  drawTick(g, TURN_MS * 0.9, () => 0);
  expect([...drawView(g, TURN_MS * 0.9).hint].filter((ch) => ch === '_')).toHaveLength(2);
});

test('only the drawer may draw, and only sensible strokes are kept', () => {
  const g = three();
  expect(drawInk(g, 'b', dot(true), 0)).toBeNull();
  expect(drawInk(g, 'a', { n: true, c: PALETTE.length, w: 0, pts: [0, 0] }, 0)).toBeNull();
  expect(drawInk(g, 'a', { n: true, c: 0, w: WIDTHS.length, pts: [0, 0] }, 0)).toBeNull();
  expect(drawInk(g, 'a', { n: true, c: 0.5, w: 0, pts: [0, 0] }, 0)).toBeNull();
  expect(drawInk(g, 'a', { n: true, c: '0', w: 0, pts: [0, 0] }, 0)).toBeNull();
  for (const pts of [undefined, 'x', [], [0.5], [0.5, 1.2], [-0.1, 0.5], [0.5, NaN], [0.5, '0.5'], new Array(MAX_MSG_POINTS * 2 + 2).fill(0.5)]) {
    expect(drawInk(g, 'a', { n: true, c: 0, w: 0, pts }, 0)).toBeNull();
  }
  expect(g.strokes).toHaveLength(0);
  expect(drawInk(g, 'a', { n: true, c: 2, w: 1, pts: [0.12345, 1] }, 0)).toEqual({ i: 0, o: 0, c: 2, w: 1, pts: [0.123, 1] });
  // More points for the same stroke keep its colour whatever the message says.
  expect(drawInk(g, 'a', { n: false, c: 5, w: 0, pts: [0.2, 0.2, 0.3, 0.3] }, 0)).toEqual({ i: 0, o: 1, c: 2, w: 1, pts: [0.2, 0.2, 0.3, 0.3] });
  expect(drawInk(g, 'a', dot(true), 0)?.i).toBe(1);
  expect(g.strokes).toEqual([{ c: 2, w: 1, pts: [0.123, 1, 0.2, 0.2, 0.3, 0.3] }, { c: 0, w: 0, pts: [0.5, 0.5] }]);
  expect(g.ink).toBe(4);
});

test('drawing is capped per second and per turn', () => {
  const g = three();
  for (let i = 0; i < MAX_MSGS_PER_SEC; i++) expect(drawInk(g, 'a', dot(i === 0), 10)).not.toBeNull();
  expect(drawInk(g, 'a', dot(), 999)).toBeNull();
  expect(drawUndo(g, 'a', 999)).toBe(false); // Undo and Clear count too
  expect(drawInk(g, 'a', dot(), 1010)).not.toBeNull();

  const full = new Array(MAX_MSG_POINTS * 2).fill(0.5);
  let now = 2000;
  let kept = g.ink;
  while (drawInk(g, 'a', { n: false, c: 0, w: 0, pts: full }, (now += 50))) kept += MAX_MSG_POINTS;
  expect(g.ink).toBe(kept);
  expect(g.ink).toBeLessThanOrEqual(MAX_INK);
  expect(g.ink).toBeGreaterThan(MAX_INK - MAX_MSG_POINTS);
  // Clearing gives the ink back.
  expect(drawClear(g, 'a', now + 2000)).toBe(true);
  expect(g.ink).toBe(0);
  expect(drawInk(g, 'a', dot(true), now + 2000)).not.toBeNull();
});

test('undo and clear are the drawer\'s alone', () => {
  const g = three();
  drawInk(g, 'a', dot(true), 0);
  drawInk(g, 'a', dot(true), 0);
  expect(drawUndo(g, 'b', 0)).toBe(false);
  expect(drawClear(g, 'b', 0)).toBe(false);
  expect(drawUndo(g, 'a', 0)).toBe(true);
  expect(g.strokes).toHaveLength(1);
  expect(g.ink).toBe(1);
  expect(drawClear(g, 'a', 0)).toBe(true);
  expect(g.strokes).toHaveLength(0);
  expect(drawUndo(g, 'a', 0)).toBe(false); // nothing left
});

test('each turn starts with a clean sheet, and nobody draws between turns', () => {
  const g = three();
  drawInk(g, 'a', dot(true), 0);
  drawGuess(g, 'b', 'zebra', 10);
  drawTick(g, TURN_MS);
  expect(g.strokes).toHaveLength(1); // still on show with the word
  expect(drawInk(g, 'a', dot(true), TURN_MS + 1)).toBeNull();
  drawTick(g, TURN_MS + REVEAL_MS, () => 0);
  expect(g.drawer).toBe('b');
  expect(g.strokes).toHaveLength(0);
  expect(g.feed).toHaveLength(0);
  expect(drawInk(g, 'a', dot(true), TURN_MS + REVEAL_MS + 1)).toBeNull(); // not Ann's turn any more
});

test('the drawer leaving skips to the next turn', () => {
  const g = three();
  expect(drawLeave(g, 'a', 5000)).toBe(true);
  expect(g.phase).toBe('reveal');
  drawTick(g, 5000 + REVEAL_MS, () => 0);
  expect(g.phase).toBe('turn');
  expect(g.drawer).toBe('b');
  expect(drawView(g, 5000 + REVEAL_MS).turns).toBe(3); // Ann's skipped turn, Bao's and Chi's
});

test('a guesser leaving can finish the turn, and loses their turn to draw', () => {
  const g = three();
  drawGuess(g, 'b', g.word, 1000);
  drawLeave(g, 'c', 2000); // the only one still guessing
  expect(g.phase).toBe('reveal');
  expect(g.queue).toEqual(['b']);
  expect(drawLeave(g, 'zed', 2000)).toBe(false);
});

test('with one player left the game stops', () => {
  const g = three();
  drawLeave(g, 'c', 1000);
  expect(g.phase).toBe('turn');
  drawLeave(g, 'b', 2000);
  expect(g.phase).toBe('lobby');
  expect(g.word).toBeNull();
  expect(drawTick(g, 10 * TURN_MS)).toBe(false);
  expect(drawStart(g, 'a', 0)).toBe(false);
});

test('someone who joins part-way can guess at once and draws last', () => {
  const g = newDraw();
  drawJoin(g, ann);
  drawJoin(g, bao);
  drawStart(g, 'a', 0, () => 0);
  drawJoin(g, chi);
  expect(drawView(g, 0).turns).toBe(3);
  expect(drawGuess(g, 'c', g.word, 1000)).toBe('right');
  expect(g.phase).toBe('turn'); // Bao is still guessing
  expect(g.queue).toEqual(['b', 'c']);
});

test('a new game starts everyone from nought, and a tie has two winners', () => {
  const g = newDraw();
  drawJoin(g, ann);
  drawJoin(g, bao);
  drawStart(g, 'a', 0, () => 0);
  drawGuess(g, 'b', g.word, 0); // Bao 100, Ann 25
  drawTick(g, REVEAL_MS, () => 0);
  drawTick(g, REVEAL_MS + TURN_MS, () => 0);
  drawTick(g, 2 * REVEAL_MS + TURN_MS, () => 0);
  expect(g.phase).toBe('final');
  expect(drawWinners(g).map((p) => p.name)).toEqual(['Bao']);
  expect(drawStart(g, 'b', 0, () => 0)).toBe(true); // "Play again" without waiting for the lobby
  expect(g.players.map((p) => p.score)).toEqual([0, 0]);
  expect(drawWinners(g)).toHaveLength(2);
});

test('the view counts down the time left', () => {
  const g = three();
  expect(drawView(g, 4000).left).toBe(TURN_MS - 4000);
  expect(drawView(g, TURN_MS * 2).left).toBe(0);
  expect(drawView(newDraw(), 5).left).toBe(0);
});

// Found by tests/sim/draw.sim.test.ts. Leaving used to wipe "has guessed", so a guesser could leave, rejoin and
// guess the same word again: 25 more points for the drawer every time, and the chance to type the word
// they already knew into the guess list as a "wrong" guess for everyone to read.
test('someone who has guessed the word cannot leave, come back and guess it again', () => {
  const g = three();
  const word = g.word!;
  expect(drawGuess(g, 'b', word, 1000)).toBe('right');
  expect(score(g, 'a')).toBe(DRAWER_POINTS);
  expect(drawLeave(g, 'b', 2000)).toBe(true);
  expect(g.phase).toBe('turn'); // Chi is still guessing
  expect(drawView(g, 2000).guessed).toEqual([]); // the view lists only people who are playing
  expect(drawJoin(g, bao)).toBe(true);
  expect(drawGuess(g, 'b', word, 3000)).toBe('no');
  expect(drawGuess(g, 'b', `it is ${word}`, 4000)).toBe('no');
  expect(score(g, 'a')).toBe(DRAWER_POINTS);
  expect(g.feed.some((f) => f.text?.includes(word))).toBe(false);
  expect(drawView(g, 4000).guessed).toEqual(['b']);
  // They still count as having got it, so the turn ends when Chi does too.
  expect(drawGuess(g, 'c', word, 5000)).toBe('right');
  expect(g.phase).toBe('reveal');
  expect(score(g, 'a')).toBe(2 * DRAWER_POINTS);
  // The next turn is a new word: they guess like anyone else.
  drawTick(g, 5000 + REVEAL_MS, () => 0);
  expect(g.drawer).toBe('c');
  expect(drawGuess(g, 'b', g.word, 5000 + REVEAL_MS + 1000)).toBe('right');
});

// Found by tests/sim/draw.sim.test.ts. `every` skips the holes of a sparse array, so one got through and was
// stored and relayed as points. JSON cannot carry a hole, so no browser could send this; refused all the same.
test('points with holes in the list are refused', () => {
  const g = three();
  expect(drawInk(g, 'a', { n: true, c: 0, w: 0, pts: new Array(4) }, 0)).toBeNull();
  const holed = [0.5, 0.5, 0.5, 0.5];
  delete holed[2];
  expect(drawInk(g, 'a', { n: true, c: 0, w: 0, pts: holed }, 0)).toBeNull();
  expect(g.strokes).toEqual([]);
  expect(g.ink).toBe(0);
});
