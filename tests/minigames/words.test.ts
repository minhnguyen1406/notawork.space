import { expect, test } from 'vitest';
import {
  CLUE_MS, GUESS_MS, IDLE_TURNS, WORD_LIST, WORDS_MAX, clueProblem, newWords, otherTeam, wordsClue, wordsEndTurn, wordsGuess, wordsJoin, wordsLeave,
  wordsLeft, wordsReady, wordsStart, wordsSwitch, wordsTick, wordsView, wordsVolunteer, type Kind, type Team, type WordsGame, type WordsView,
} from '../../shared/minigames/words';
import { create } from '../../worker/src/minigames/words';
import type { GameIO } from '../../worker/src/minigames/api';
import type { PlayerInfo } from '../../shared/protocol';

/** A repeatable random source. */
const seeded = (seed = 1) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const people = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id.toUpperCase() }));
/** n players joined in order: a and b become the clue-givers, the rest guessers, alternating red and blue. */
const lobby = (n = 4) => {
  const g = newWords();
  for (const p of people.slice(0, n)) wordsJoin(g, p);
  return g;
};
const started = (n = 4, seed = 1) => {
  const g = lobby(n);
  expect(wordsStart(g, 'a', 0, seeded(seed))).toBe(true);
  return g;
};
const giver = (g: WordsGame, t: Team) => g.players.find((p) => p.team === t && p.giver)!.id;
const guesser = (g: WordsGame, t: Team) => g.players.find((p) => p.team === t && !p.giver)!.id;
/** A face-down card of this kind. */
const card = (g: WordsGame, k: Kind) => g.map.findIndex((m, i) => m === k && !g.revealed[i]);
/** Start a game and give the first clue. */
const guessing = (n = 2, players = 4) => {
  const g = started(players);
  expect(wordsClue(g, giver(g, g.turn), 'zzz', n, 0)).toBe(true);
  return g;
};

test('the list has at least 220 different plain words', () => {
  expect(new Set(WORD_LIST).size).toBe(WORD_LIST.length);
  expect(WORD_LIST.length).toBeGreaterThanOrEqual(220);
  for (const w of WORD_LIST) expect(w).toMatch(/^[a-z]+$/);
});

test('joining deals people evenly, with one clue-giver a side', () => {
  const g = lobby(5);
  expect(g.players.map((p) => p.team)).toEqual(['red', 'blue', 'red', 'blue', 'red']);
  expect(g.players.filter((p) => p.giver).map((p) => p.id)).toEqual(['a', 'b']);
  expect(wordsJoin(g, people[0])).toBe(false); // already in
});

test('no more than twenty can join', () => {
  const g = newWords();
  for (let i = 0; i < WORDS_MAX; i++) expect(wordsJoin(g, { id: `p${i}`, name: `P${i}` })).toBe(true);
  expect(wordsJoin(g, { id: 'late', name: 'Late' })).toBe(false);
  expect(g.players.filter((p) => p.team === 'red').length).toBe(10);
  expect(g.players.filter((p) => p.giver).length).toBe(2);
});

test('switching team and volunteering keep exactly one clue-giver a side', () => {
  const g = lobby(4);
  expect(wordsVolunteer(g, 'c')).toBe(true);
  expect(giver(g, 'red')).toBe('c');
  expect(wordsVolunteer(g, 'c')).toBe(false); // already is
  expect(wordsSwitch(g, 'c')).toBe(true); // red's clue-giver goes to blue as a guesser
  expect(g.players.find((p) => p.id === 'c')).toMatchObject({ team: 'blue', giver: false });
  expect(giver(g, 'red')).toBe('a');
  expect(giver(g, 'blue')).toBe('b');
  expect(wordsSwitch(g, 'zed')).toBe(false);
});

test('start needs a clue-giver and a guesser on each team, and someone who is playing', () => {
  const g = lobby(3);
  expect(wordsReady(g)).toBe(false);
  expect(wordsStart(g, 'a', 0)).toBe(false);
  wordsJoin(g, people[3]);
  expect(wordsStart(g, 'zed', 0)).toBe(false);
  wordsSwitch(g, 'd'); // three against one
  expect(wordsStart(g, 'a', 0)).toBe(false);
  wordsSwitch(g, 'd');
  expect(wordsStart(g, 'a', 0)).toBe(true);
  expect(wordsStart(g, 'a', 0)).toBe(false); // already going
});

test('the deal is 25 different words: 9 for the first team, 8 for the other, 7 neutral, 1 trap', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = started(4, seed);
    expect(g.grid.length).toBe(25);
    expect(new Set(g.grid).size).toBe(25);
    for (const w of g.grid) expect(WORD_LIST).toContain(w);
    const count = (k: Kind) => g.map.filter((m) => m === k).length;
    expect(g.turn).toBe(g.first);
    expect(count(g.first)).toBe(9);
    expect(count(otherTeam(g.first))).toBe(8);
    expect(count('neutral')).toBe(7);
    expect(count('trap')).toBe(1);
    expect(g.revealed).toEqual(Array(25).fill(false));
    expect(g.phase).toBe('clue');
  }
  // Different seeds give different grids and both teams get to go first.
  expect(new Set(Array.from({ length: 30 }, (_, s) => started(4, s + 1).first)).size).toBe(2);
});

test('nobody can join, switch or volunteer once the game is on', () => {
  const g = started(5);
  expect(wordsJoin(g, people[5])).toBe(false);
  expect(wordsSwitch(g, 'c')).toBe(false);
  expect(wordsVolunteer(g, 'c')).toBe(false);
});

test('clue validation: letters only, one word, not on the grid or containing a grid word', () => {
  const grid = ['sun', 'Flower', 'boat'];
  expect(clueProblem(grid, 'ocean')).toBeNull();
  expect(clueProblem(grid, '  Ocean ')).toBeNull();
  expect(clueProblem(grid, 'SUN')).toBeTruthy(); // a grid word, any case
  expect(clueProblem(grid, 'Sunny')).toBeTruthy(); // contains one
  expect(clueProblem(grid, 'sunFLOWERs')).toBeTruthy();
  expect(clueProblem(grid, 'two words')).toBeTruthy();
  expect(clueProblem(grid, 'half-way')).toBeTruthy();
  expect(clueProblem(grid, 'r2d2')).toBeTruthy();
  expect(clueProblem(grid, '')).toBeTruthy();
  expect(clueProblem(grid, '   ')).toBeTruthy();
  expect(clueProblem(grid, 'a'.repeat(21))).toBeTruthy();
  expect(clueProblem(grid, 7)).toBeTruthy();
  expect(clueProblem(grid, null)).toBeTruthy();
});

test('only the clue-giver whose turn it is gives the clue, with a number from 1 to 9', () => {
  const g = started();
  const t = g.turn;
  expect(wordsClue(g, guesser(g, t), 'zzz', 2, 0)).toBe(false);
  expect(wordsClue(g, giver(g, otherTeam(t)), 'zzz', 2, 0)).toBe(false);
  expect(wordsClue(g, 'zed', 'zzz', 2, 0)).toBe(false);
  for (const n of [0, 10, 1.5, -1, NaN, '2', null, undefined]) expect(wordsClue(g, giver(g, t), 'zzz', n, 0)).toBe(false);
  expect(wordsClue(g, giver(g, t), g.grid[3].toUpperCase(), 2, 0)).toBe(false);
  expect(wordsClue(g, giver(g, t), `${g.grid[3]}s`, 2, 0)).toBe(false);
  expect(wordsClue(g, giver(g, t), 'not one', 2, 0)).toBe(false);
  expect(wordsClue(g, giver(g, t), { toString: () => 'zzz' }, 2, 0)).toBe(false);
  expect(g.phase).toBe('clue');
  expect(wordsClue(g, giver(g, t), ' Zzz ', 9, 1000)).toBe(true);
  expect(g.clue).toEqual({ word: 'ZZZ', n: 9 });
  expect(g.phase).toBe('guess');
  expect(g.until).toBe(1000 + GUESS_MS);
  expect(wordsClue(g, giver(g, t), 'again', 1, 0)).toBe(false); // one clue a turn
});

test('only guessers on the team whose turn it is may guess, and only face-down cards on the grid', () => {
  const g = started();
  const t = g.turn;
  expect(wordsGuess(g, guesser(g, t), 0, 0)).toBeNull(); // no clue yet
  wordsClue(g, giver(g, t), 'zzz', 3, 0);
  expect(wordsGuess(g, giver(g, t), 0, 0)).toBeNull(); // clue-givers never guess
  expect(wordsGuess(g, guesser(g, otherTeam(t)), 0, 0)).toBeNull();
  expect(wordsGuess(g, giver(g, otherTeam(t)), 0, 0)).toBeNull();
  expect(wordsGuess(g, 'zed', 0, 0)).toBeNull();
  for (const i of [-1, 25, 1.5, '3', null, undefined, NaN]) expect(wordsGuess(g, guesser(g, t), i, 0)).toBeNull();
  expect(g.revealed.some(Boolean)).toBe(false);
  const i = card(g, t);
  expect(wordsGuess(g, guesser(g, t), i, 0)).toBe(t);
  expect(wordsGuess(g, guesser(g, t), i, 0)).toBeNull(); // already turned over
});

test('any guesser on the team may guess', () => {
  const g = guessing(3, 6);
  const t = g.turn;
  const [one, two] = g.players.filter((p) => p.team === t && !p.giver).map((p) => p.id);
  expect(wordsGuess(g, one, card(g, t), 0)).toBe(t);
  expect(wordsGuess(g, two, card(g, t), 0)).toBe(t);
  expect(g.guesses).toBe(2);
});

test("own team's word: keep guessing, up to the clue number plus one", () => {
  const g = guessing(2);
  const t = g.turn;
  const who = guesser(g, t);
  expect(wordsView(g, 0).guessesLeft).toBe(3);
  wordsGuess(g, who, card(g, t), 5);
  wordsGuess(g, who, card(g, t), 5);
  expect(g.phase).toBe('guess');
  expect(g.turn).toBe(t);
  expect(wordsView(g, 5).guessesLeft).toBe(1);
  wordsGuess(g, who, card(g, t), 5000); // the third: the limit for a clue of two
  expect(g.turn).toBe(otherTeam(t));
  expect(g.phase).toBe('clue');
  expect(g.clue).toBeNull();
  expect(g.until).toBe(5000 + CLUE_MS);
  expect(wordsLeft(g, t)).toBe(6);
  expect(wordsGuess(g, who, card(g, t), 5000)).toBeNull();
});

test('a neutral word ends the turn', () => {
  const g = guessing(3);
  const t = g.turn;
  expect(wordsGuess(g, guesser(g, t), card(g, 'neutral'), 0)).toBe('neutral');
  expect(g.turn).toBe(otherTeam(t));
  expect(g.phase).toBe('clue');
  expect(wordsLeft(g, 'red') + wordsLeft(g, 'blue')).toBe(17);
});

test("the other team's word ends the turn and counts for them", () => {
  const g = guessing(3);
  const t = g.turn;
  const them = otherTeam(t);
  expect(wordsGuess(g, guesser(g, t), card(g, them), 0)).toBe(them);
  expect(g.turn).toBe(them);
  expect(g.phase).toBe('clue');
  expect(wordsLeft(g, them)).toBe(7);
  expect(wordsLeft(g, t)).toBe(9);
});

test('the trap loses the game at once', () => {
  const g = guessing(3);
  const t = g.turn;
  expect(wordsGuess(g, guesser(g, t), card(g, 'trap'), 0)).toBe('trap');
  expect(g.phase).toBe('lobby');
  expect(g.result).toEqual({ winner: otherTeam(t), reason: 'trap' });
});

test('the first team to have all its words turned over wins', () => {
  const g = guessing(9);
  const t = g.turn;
  for (let n = 0; n < 8; n++) wordsGuess(g, guesser(g, t), card(g, t), 0);
  expect(g.phase).toBe('guess');
  wordsGuess(g, guesser(g, t), card(g, t), 0);
  expect(g.phase).toBe('lobby');
  expect(g.result).toEqual({ winner: t, reason: 'all' });
});

test("turning over the other team's last word wins it for them", () => {
  const g = guessing(1);
  const t = g.turn;
  const them = otherTeam(t);
  for (const [i, k] of g.map.entries()) if (k === them) g.revealed[i] = true;
  g.revealed[g.map.indexOf(them)] = false; // one left
  wordsGuess(g, guesser(g, t), card(g, them), 0);
  expect(g.result).toEqual({ winner: them, reason: 'all' });
});

test('guessers can end the turn, but only after a guess', () => {
  const g = guessing(3);
  const t = g.turn;
  expect(wordsEndTurn(g, guesser(g, t), 0)).toBe(false);
  wordsGuess(g, guesser(g, t), card(g, t), 0);
  expect(wordsEndTurn(g, giver(g, t), 0)).toBe(false);
  expect(wordsEndTurn(g, guesser(g, otherTeam(t)), 0)).toBe(false);
  expect(wordsEndTurn(g, guesser(g, t), 0)).toBe(true);
  expect(g.turn).toBe(otherTeam(t));
  expect(g.phase).toBe('clue');
});

test('an idle clue-giver loses the turn after 90 seconds, idle guessers after 120', () => {
  const g = started();
  const t = g.turn;
  expect(CLUE_MS).toBe(90_000);
  expect(GUESS_MS).toBe(120_000);
  expect(wordsTick(g, CLUE_MS - 1)).toBe(false);
  expect(wordsTick(g, CLUE_MS)).toBe(true);
  expect(g.turn).toBe(otherTeam(t));
  expect(g.phase).toBe('clue');
  const at = CLUE_MS + 10;
  wordsClue(g, giver(g, g.turn), 'zzz', 2, at);
  expect(wordsTick(g, at + GUESS_MS - 1)).toBe(false);
  expect(wordsView(g, at + 20_000).left).toBe(GUESS_MS - 20_000);
  expect(wordsTick(g, at + GUESS_MS)).toBe(true);
  expect(g.turn).toBe(t);
  expect(g.phase).toBe('clue');
  expect(g.clue).toBeNull();
  expect(wordsTick(newWords(), 1e9)).toBe(false); // nothing times out in the lobby
});

test('a clue-giver leaving promotes a guesser from the same team', () => {
  const g = started(6);
  const t = g.turn;
  const old = giver(g, t);
  const next = guesser(g, t);
  expect(wordsLeave(g, old)).toBe(true);
  expect(g.phase).toBe('clue');
  expect(giver(g, t)).toBe(next);
  expect(wordsView(g, 0, next).secret).toEqual(g.map); // and now sees the map
  expect(wordsClue(g, next, 'zzz', 1, 0)).toBe(true);
  expect(wordsLeave(g, 'zed')).toBe(false);
});

test('a team left with fewer than two players ends the game', () => {
  const g = guessing(2, 5);
  wordsLeave(g, guesser(g, 'blue')); // blue had two
  expect(g.phase).toBe('lobby');
  expect(g.result).toEqual({ winner: null, reason: 'short' });
  expect(wordsStart(g, 'a', 0)).toBe(false);
  // In the lobby a team that loses its clue-giver gets another.
  wordsLeave(g, giver(g, 'red'));
  expect(g.players.filter((p) => p.team === 'red' && p.giver).length).toBe(1);
});

test('a new game can be played after one ends', () => {
  const g = guessing(1);
  wordsGuess(g, guesser(g, g.turn), card(g, 'trap'), 0);
  expect(wordsStart(g, 'c', 50, seeded(9))).toBe(true);
  expect(g.result).toBeNull();
  expect(g.revealed.some(Boolean)).toBe(false);
});

// ---------------------------------------------------------------- secrecy

/** True if this view gives away anything about a face-down card. */
const leaks = (g: WordsGame, v: WordsView) => v.secret !== null || v.cells.some((c, i) => !g.revealed[i] && c.kind !== null) || 'map' in v;

test('the secret map never appears in the view of a guesser or an onlooker', () => {
  const g = guessing(3, 6);
  const t = g.turn;
  wordsGuess(g, guesser(g, t), card(g, t), 0);
  for (const viewer of [null, 'zed', ...g.players.filter((p) => !p.giver).map((p) => p.id)]) {
    const v = wordsView(g, 0, viewer);
    expect(leaks(g, v)).toBe(false);
    expect(v.cells.filter((c) => c.kind !== null).length).toBe(1);
    // The trap is face down, so the word for it must not be anywhere in what is sent.
    expect(JSON.stringify(v)).not.toContain('trap');
  }
  for (const t2 of ['red', 'blue'] as const) expect(wordsView(g, 0, giver(g, t2)).secret).toEqual(g.map);
  // Someone who was a clue-giver and left no longer gets it.
  const gone = giver(g, t);
  wordsLeave(g, gone);
  expect(wordsView(g, 0, gone).secret).toBeNull();
});

test('once the game is over the whole map is shown to everyone', () => {
  const g = guessing(1);
  const i = card(g, 'trap');
  wordsGuess(g, guesser(g, g.turn), i, 0);
  const v = wordsView(g, 0);
  expect(v.cells.map((c) => c.kind)).toEqual(g.map);
  expect(v.cells.filter((c) => c.open).length).toBe(1);
  expect(v.cells[i]).toMatchObject({ kind: 'trap', open: true });
});

test('the server broadcasts only the public view and sends the map to the two clue-givers alone', () => {
  const sent: { to: string; view: WordsView }[] = [];
  const cast: WordsView[] = [];
  const notices: string[] = [];
  const io: GameIO = {
    players: () => [],
    send: (to, view) => sent.push({ to, view: view as WordsView }),
    broadcast: (view) => cast.push(view as WordsView),
    notice: (text) => notices.push(text),
    emote() {}, put() {}, nudge() {}, resetBall() {}, setScore() {},
  };
  const s = create(io);
  const info = (id: string) => ({ id, name: id.toUpperCase(), color: '#fff', look: 'x', x: 0, z: 0, ry: 0, seat: null }) as PlayerInfo;
  for (const id of ['a', 'b', 'c', 'd']) s.onAction(info(id), { k: 'join' }, 0);
  s.onAction(info('zed'), { k: 'start' }, 0); // not playing
  expect(cast.at(-1)!.phase).toBe('lobby');
  s.onAction(info('c'), { k: 'start' }, 0);
  expect(cast.at(-1)!.phase).toBe('clue');

  const first = cast.at(-1)!.turn;
  const giverId = first === 'red' ? 'a' : 'b';
  const guesserId = first === 'red' ? 'c' : 'd';
  const map = sent.at(-1)!.view.secret!;
  expect(map.length).toBe(25);

  // Hostile and out-of-turn actions change nothing.
  const before = cast.length;
  s.onAction(info(guesserId), { k: 'clue', word: 'zzz', n: 2 }, 1);
  s.onAction(info(giverId), { k: 'clue', word: 'zzz', n: 99 }, 1);
  s.onAction(info(giverId), { k: 'clue', word: ['zzz'], n: 2 }, 1);
  s.onAction(info(guesserId), { k: 'guess', i: 0 }, 1);
  s.onAction(info(giverId), { k: 'nonsense' }, 1);
  s.onAction(info(giverId), {}, 1);
  expect(cast.length).toBe(before);

  s.onAction(info(giverId), { k: 'clue', word: 'zzz', n: 2 }, 1);
  expect(cast.at(-1)!.clue).toEqual({ word: 'ZZZ', n: 2 });
  s.onAction(info(guesserId), { k: 'guess', i: map.indexOf(first) }, 2);
  expect(cast.at(-1)!.cells.filter((c) => c.kind).length).toBe(1);
  s.tick!(3 + GUESS_MS); // time runs out: the other team's turn
  expect(cast.at(-1)!.turn).toBe(otherTeam(first));
  s.onJoin!(info('late'), 4 + GUESS_MS);
  expect(sent.at(-1)).toMatchObject({ to: 'late', view: { secret: null } });

  // While the game was on: no broadcast held the map, and it was only ever sent to a and b.
  const playing = cast.filter((v) => v.phase !== 'lobby');
  expect(playing.length).toBeGreaterThanOrEqual(4);
  for (const v of playing) {
    expect(v.secret).toBeNull();
    expect(v.cells.every((c) => c.open === (c.kind !== null))).toBe(true);
    expect(JSON.stringify(v)).not.toContain('trap');
  }
  const withMap = sent.filter((m) => m.view.secret);
  expect(new Set(withMap.map((m) => m.to))).toEqual(new Set(['a', 'b']));
  for (const m of sent.filter((x) => !['a', 'b'].includes(x.to))) expect(JSON.stringify(m.view)).not.toContain('trap');

  // A clue-giver walks out of the room: their guesser cannot carry on alone, so the game stops and says so.
  s.onLeave('a', 5 + GUESS_MS);
  expect(cast.at(-1)).toMatchObject({ phase: 'lobby', result: { winner: null, reason: 'short' } });
  expect(notices.length).toBe(1);
});

test('the server promotes a guesser when a clue-giver leaves, sends them the map, and announces a win', () => {
  const sent: { to: string; view: WordsView }[] = [];
  const cast: WordsView[] = [];
  const notices: string[] = [];
  const io: GameIO = {
    players: () => [],
    send: (to, view) => sent.push({ to, view: view as WordsView }),
    broadcast: (view) => cast.push(view as WordsView),
    notice: (text) => notices.push(text),
    emote() {}, put() {}, nudge() {}, resetBall() {}, setScore() {},
  };
  const s = create(io);
  const info = (id: string) => ({ id, name: id.toUpperCase(), color: '#fff', look: 'x', x: 0, z: 0, ry: 0, seat: null }) as PlayerInfo;
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) s.onAction(info(id), { k: 'join' }, 0);
  s.onAction(info('a'), { k: 'start' }, 0);
  sent.length = 0;
  s.onAction(info('a'), { k: 'leave' }, 1); // red's clue-giver: c steps up
  expect(cast.at(-1)!.phase).toBe('clue');
  expect(cast.at(-1)!.players.find((p) => p.id === 'c')!.giver).toBe(true);
  const toC = sent.find((m) => m.to === 'c')!;
  expect(toC.view.secret!.length).toBe(25);
  expect(sent.some((m) => m.to === 'a')).toBe(false);

  // Play to the trap: the team that hit it loses, and everyone is told.
  const map = toC.view.secret!;
  const turn = cast.at(-1)!.turn;
  s.onAction(info(turn === 'red' ? 'c' : 'b'), { k: 'clue', word: 'zzz', n: 1 }, 2);
  s.onAction(info(turn === 'red' ? 'e' : 'd'), { k: 'guess', i: map.indexOf('trap') }, 3);
  const end = cast.at(-1)!;
  expect(end).toMatchObject({ phase: 'lobby', result: { winner: otherTeam(turn), reason: 'trap' } });
  expect(end.cells.map((c) => c.kind)).toEqual(map); // the whole map, for everyone
  expect(notices).toEqual([`${otherTeam(turn) === 'red' ? 'Red' : 'Blue'} team won at word clues (the other team hit the trap)`]);
});

// Found by tests/sim/words.sim.test.ts: with everyone idle the turn used to pass back and forth for ever,
// and since nobody can join mid-game the table was held until all four left the room.
test('a game everyone has walked away from is abandoned after four timed-out turns in a row', () => {
  const g = started();
  let now = 0;
  for (let i = 0; i < IDLE_TURNS - 1; i++) {
    now = g.until;
    expect(wordsTick(g, now)).toBe(true);
    expect(g.phase).toBe('clue');
  }
  // A clue or a guess shows someone is there, and starts the count again.
  expect(wordsClue(g, giver(g, g.turn), 'zzz', 1, now)).toBe(true);
  for (let i = 0; i < IDLE_TURNS - 1; i++) {
    now = g.until;
    expect(wordsTick(g, now)).toBe(true);
    expect(g.phase).not.toBe('lobby');
  }
  wordsClue(g, giver(g, g.turn), 'zzz', 1, now);
  expect(wordsGuess(g, guesser(g, g.turn), card(g, 'neutral'), now)).toBe('neutral');
  for (let i = 0; i < IDLE_TURNS; i++) {
    expect(g.phase).not.toBe('lobby');
    now = g.until;
    expect(wordsTick(g, now)).toBe(true);
  }
  expect(g.phase).toBe('lobby');
  expect(g.result).toEqual({ winner: null, reason: 'short' });
  expect(wordsTick(g, now + 1e9)).toBe(false);
  // The table is free again: someone new can join and a fresh game can start.
  expect(wordsJoin(g, people[4])).toBe(true);
  expect(wordsStart(g, 'e', now, seeded(3))).toBe(true);
  expect(g.idle).toBe(0);
});

test('the server says so when it abandons an idle game, and shows everyone the map', () => {
  const cast: WordsView[] = [];
  const notices: string[] = [];
  const io: GameIO = { players: () => [], send() {}, broadcast: (view) => cast.push(view as WordsView), notice: (text) => notices.push(text), emote() {}, put() {}, nudge() {}, resetBall() {}, setScore() {} };
  const s = create(io);
  const info = (id: string) => ({ id, name: id.toUpperCase(), color: '#fff', look: 'x', x: 0, z: 0, ry: 0, seat: null }) as PlayerInfo;
  for (const id of ['a', 'b', 'c', 'd']) s.onAction(info(id), { k: 'join' }, 0);
  s.onAction(info('a'), { k: 'start' }, 0);
  for (let now = 0; now <= IDLE_TURNS * CLUE_MS; now += 100) s.tick!(now);
  expect(cast.at(-1)).toMatchObject({ phase: 'lobby', result: { winner: null, reason: 'short' } });
  expect(cast.at(-1)!.cells.every((c) => c.kind !== null)).toBe(true);
  expect(notices).toEqual(['Word clues stopped: nobody was playing']);
});
