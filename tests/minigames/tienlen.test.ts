import { expect, test } from 'vitest';
import {
  QUAD_CHOPS_PAIR_OF_TWOS,
  RANKS,
  TURN_MS,
  beats,
  cardName,
  cardOf,
  classify,
  isRed,
  newTienlen,
  tlBegin,
  tlDeal,
  tlIllegal,
  tlJoin,
  tlLeave,
  tlPass,
  tlPlay,
  tlTick,
  tlView,
  type TlGame,
} from '../../shared/minigames/tienlen';
import { create } from '../../worker/src/minigames/tienlen';
import type { GameIO } from '../../worker/src/minigames/api';
import type { PlayerInfo } from '../../shared/protocol';

/** '3S 10H 2D' → cards. S spades, C clubs, D diamonds, H hearts. */
const cs = (text: string) =>
  text
    .trim()
    .split(/\s+/)
    .map((t) => {
      const rank = RANKS.indexOf(t.slice(0, -1));
      const suit = 'SCDH'.indexOf(t.slice(-1));
      if (rank < 0 || suit < 0) throw new Error(`bad card ${t}`);
      return cardOf(rank, suit);
    });
const kind = (text: string) => classify(cs(text))?.kind ?? null;
/** Does play `a` beat `b` on the table? */
const wins = (a: string, b: string) => beats(classify(cs(a))!, classify(cs(b))!);

const people = [
  { id: 'a', name: 'Ann' },
  { id: 'b', name: 'Bao' },
  { id: 'c', name: 'Chi' },
  { id: 'd', name: 'Dung' },
];
/** A hand in progress with exactly these cards (no need for 13 each). The first hand of a session. */
const table = (...hands: string[]): TlGame => {
  const g = newTienlen();
  hands.forEach((h, i) => {
    tlJoin(g, people[i]);
    g.hands[people[i].id] = cs(h);
  });
  tlBegin(g, 0);
  return g;
};

// ---- cards -------------------------------------------------------------------------------------

test('cards order by rank 3..2 first, then suit spades < clubs < diamonds < hearts', () => {
  const order = cs('3S 3C 3D 3H 4S 10H JS KH AS AH 2S 2C 2D 2H');
  expect([...order].sort((x, y) => x - y)).toEqual(order);
  expect(cs('3S')[0]).toBe(0);
  expect(cs('2H')[0]).toBe(51);
  expect(cardName(cs('10D')[0])).toBe('10♦');
  expect(cs('3S 3C 3D 3H').map(isRed)).toEqual([false, false, true, true]);
});

// ---- classification ----------------------------------------------------------------------------

test('singles, pairs, triples and four of a kind', () => {
  expect(classify(cs('7D'))).toEqual({ kind: 'single', n: 1, top: cs('7D')[0] });
  expect(classify(cs('7D 7S'))).toEqual({ kind: 'pair', n: 2, top: cs('7D')[0] });
  expect(kind('2S 2H')).toBe('pair');
  expect(kind('9S 9C 9H')).toBe('triple');
  expect(kind('2S 2C 2H')).toBe('triple');
  expect(kind('JS JC JD JH')).toBe('quad');
  expect(kind('7D 8D')).toBeNull();
  expect(kind('7D 7S 8D')).toBeNull();
  expect(kind('7D 7S 7C 8D')).toBeNull();
});

test('straights need three or more consecutive ranks, of any suits, and never a 2', () => {
  expect(classify(cs('5H 3S 4D'))).toEqual({ kind: 'straight', n: 3, top: cs('5H')[0] });
  expect(kind('3S 4S')).toBeNull();
  expect(kind('3S 4S 6S')).toBeNull();
  expect(kind('QS KD AH')).toBe('straight');
  expect(kind('KD AH 2S')).toBeNull(); // 2 cannot end a straight
  expect(kind('AH 2S 3S')).toBeNull(); // and there is no wrapping round
  expect(kind('2S 3S 4S')).toBeNull();
  expect(kind('3S 4C 5D 6H 7S 8C 9D 10H JS QC KD AH')).toBe('straight'); // the longest possible
  expect(kind('3S 4C 5D 6H 7S 8C 9D 10H JS QC KD AH 2S')).toBeNull();
  expect(kind('3S 3C 4D 5H')).toBeNull();
});

test('runs of pairs need three or more consecutive pairs and never 2s', () => {
  expect(classify(cs('3S 3C 4D 4H 5S 5H'))).toEqual({ kind: 'pairs', n: 6, top: cs('5H')[0] });
  expect(kind('3S 3C 4D 4H')).toBeNull(); // two pairs is not a play
  expect(kind('3S 3C 4D 4H 6S 6H')).toBeNull();
  expect(kind('3S 3C 4D 4H 5S 6H')).toBeNull();
  expect(kind('8S 8C 9D 9H 10S 10H JC JD')).toBe('pairs');
  expect(kind('KS KC AD AH 2S 2H')).toBeNull();
  expect(kind('QS QC KS KC AD AH')).toBe('pairs');
  expect(kind('3S 3C 3D 4S 4C 4D')).toBeNull(); // triples in a row are not a play in the southern game
});

test('classify rejects rubbish from a browser', () => {
  for (const bad of [undefined, null, 'x', 5, {}, [], [1.5], [-1], [52], ['3'], [NaN], [4, 4], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]]) expect(classify(bad)).toBeNull();
});

// ---- beating -----------------------------------------------------------------------------------

test('a higher single wins on rank, then on suit', () => {
  expect(wins('4S', '3H')).toBe(true);
  expect(wins('3H', '3D')).toBe(true);
  expect(wins('3S', '3C')).toBe(false);
  expect(wins('2S', 'AH')).toBe(true);
  expect(wins('AH', '2S')).toBe(false);
  expect(wins('2H', '2D')).toBe(true);
  expect(wins('7D', '7D')).toBe(false);
});

test('pairs, triples and straights are compared by their highest card', () => {
  expect(wins('5S 5H', '5C 5D')).toBe(true); // the heart decides
  expect(wins('5C 5D', '5S 5H')).toBe(false);
  expect(wins('6S 6C', '5D 5H')).toBe(true);
  expect(wins('2S 2C', 'AD AH')).toBe(true);
  expect(wins('9S 9C 9D', '8C 8D 8H')).toBe(true);
  expect(wins('8C 8D 8H', '9S 9C 9D')).toBe(false);
  expect(wins('4S 5S 6S', '3H 4H 5H')).toBe(true);
  expect(wins('3S 4S 5H', '3H 4H 5D')).toBe(true); // same ranks: suit of the top card
  expect(wins('3H 4H 5D', '3S 4S 5H')).toBe(false);
  expect(wins('4S 4C 5S 5C 6S 6H', '4D 4H 5D 5H 6C 6D')).toBe(true);
});

test('the kind and the number of cards must match', () => {
  expect(wins('9S 9C', '3S')).toBe(false);
  expect(wins('3S', '3C 3D')).toBe(false);
  expect(wins('9S 9C 9D', '3S 3C')).toBe(false);
  expect(wins('9S 10S JS QS', '3S 4S 5S')).toBe(false); // a longer straight does not beat a shorter one
  expect(wins('9S 10S JS', '3S 4S 5S 6S')).toBe(false);
  expect(wins('2S 2H', '2D')).toBe(false);
  expect(wins('2S', 'KS KH')).toBe(false);
  expect(wins('KS KC KD KH', 'AS')).toBe(false); // four of a kind is only a bomb against 2s and pair runs
  expect(wins('KS KC KD KH', 'AS AH')).toBe(false);
  expect(wins('KS KC KD KH', '3S 4S 5S 6S')).toBe(false);
  expect(wins('3S 3C 4D 4H 5S 5H', 'AS')).toBe(false);
  expect(wins('3S 3C 4D 4H 5S 5H', 'AS AH')).toBe(false);
});

test('chop: a single 2 falls to four of a kind or to a run of three pairs', () => {
  expect(wins('3S 3C 3D 3H', '2H')).toBe(true);
  expect(wins('3S 3C 4D 4H 5S 5H', '2H')).toBe(true);
  expect(wins('3S 3C 4D 4H 5S 5H 6C 6D', '2S')).toBe(true);
  expect(wins('AS AC AH', '2S')).toBe(false);
  expect(wins('3S 4S 5S', '2S')).toBe(false);
});

test('chop: a pair of 2s falls to a run of four pairs, not to three', () => {
  expect(wins('3S 3C 4D 4H 5S 5H 6C 6D', '2D 2H')).toBe(true);
  expect(wins('3S 3C 4D 4H 5S 5H', '2S 2C')).toBe(false);
  expect(wins('AS AC AD AH', '2S 2C')).toBe(QUAD_CHOPS_PAIR_OF_TWOS);
  expect(QUAD_CHOPS_PAIR_OF_TWOS).toBe(false);
});

test('chop: three 2s fall only to a run of five pairs', () => {
  expect(wins('3S 3C 4D 4H 5S 5H 6C 6D 7S 7H', '2S 2C 2D')).toBe(true);
  expect(wins('3S 3C 4D 4H 5S 5H 6C 6D', '2S 2C 2D')).toBe(false);
  expect(wins('AS AC AD AH', '2S 2C 2D')).toBe(false);
});

test('chopping the chop: four of a kind beats a three-pair run, and a higher bomb beats a lower one', () => {
  expect(wins('3S 3C 3D 3H', 'QS QC KS KC AD AH')).toBe(true);
  expect(wins('QS QC KS KC AD AH', '3S 3C 3D 3H')).toBe(false);
  expect(wins('4S 4C 4D 4H', '3S 3C 3D 3H')).toBe(true);
  expect(wins('3S 3C 3D 3H', '4S 4C 4D 4H')).toBe(false);
  expect(wins('4S 4C 5D 5H 6S 6H', '3S 3C 4D 4H 5S 5H')).toBe(true);
  expect(wins('3S 3C 4D 4H 5S 5H', '4S 4C 5D 5C 6S 6D')).toBe(false);
  // A run of four pairs is the biggest bomb: over a three-pair run and over four of a kind.
  expect(wins('3S 3C 4D 4H 5S 5H 6C 6D', '2S 2C 2D 2H')).toBe(true);
  expect(wins('3S 3C 4D 4H 5S 5H 6C 6D', 'QS QC KS KC AD AH')).toBe(true);
  expect(wins('2S 2C 2D 2H', '3S 3C 4D 4H 5S 5H 6C 6D')).toBe(false);
  expect(wins('4S 4C 5D 5H 6S 6H 7C 7D', '3S 3C 4D 4H 5S 5H 6C 6D')).toBe(true);
});

test('a chop works in play, and can itself be chopped', () => {
  const g = table('3S 2H 9D', '4S 4C 5S 5C 6S 6C 9S', '7S 7C 7D 7H KS', '8S 8C');
  expect(tlPlay(g, 'a', cs('3S'), 0)).toBe('play');
  expect(tlPass(g, 'b', 0)).toBe(true);
  expect(tlPass(g, 'c', 0)).toBe(true);
  expect(tlPass(g, 'd', 0)).toBe(true);
  expect(g.turn).toBe('a'); // new trick
  expect(tlPlay(g, 'a', cs('2H'), 0)).toBe('play');
  expect(tlPlay(g, 'b', cs('4S 4C 5S 5C 6S 6C'), 0)).toBe('chop');
  expect(tlPlay(g, 'c', cs('7S 7C 7D 7H'), 0)).toBe('chop');
  expect(g.table?.by).toBe('c');
  expect(g.turn).toBe('d');
});

// ---- joining and dealing -----------------------------------------------------------------------

test('two to four players; nobody joins twice, a fifth is refused, one cannot deal', () => {
  const g = newTienlen();
  expect(tlJoin(g, people[0])).toBe(true);
  expect(tlJoin(g, people[0])).toBe(false);
  expect(tlDeal(g, 'a', 0)).toBe(false);
  tlJoin(g, people[1]);
  expect(tlDeal(g, 'zed', 0)).toBe(false); // only someone at the table deals
  tlJoin(g, people[2]);
  tlJoin(g, people[3]);
  expect(tlJoin(g, { id: 'e', name: 'Em' })).toBe(false);
  expect(tlDeal(g, 'a', 0)).toBe(true);
  expect(tlDeal(g, 'a', 0)).toBe(false); // not in the middle of a hand
});

test('a deal gives 13 different cards each, sorted, and the 3 of spades leads the first hand', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const g = newTienlen();
  for (const p of people) tlJoin(g, p);
  tlDeal(g, 'b', 1000, rnd);
  const all = people.flatMap((p) => g.hands[p.id]);
  expect(new Set(all).size).toBe(52);
  for (const p of people) {
    expect(g.hands[p.id]).toHaveLength(13);
    expect(g.hands[p.id]).toEqual([...g.hands[p.id]].sort((x, y) => x - y));
  }
  expect(g.hands[g.turn!]).toContain(0);
  expect(g.mustInclude).toBe(0);
  expect(g.until).toBe(1000 + TURN_MS);
});

test('nobody can sit down while a hand is being played', () => {
  const g = table('3S 4S', '5S 6S');
  expect(tlJoin(g, people[2])).toBe(false);
});

// ---- the opening rule --------------------------------------------------------------------------

test('first hand: the holder of the 3 of spades leads and the first play must include it', () => {
  const g = table('4S 5S 6S', '3S 3C 4C 5C 9S', '7S 8S');
  expect(g.turn).toBe('b');
  expect(tlPlay(g, 'a', cs('4S'), 0)).toBe(false); // not their turn
  expect(tlPlay(g, 'b', cs('9S'), 0)).toBe(false); // leaves out the 3 of spades
  expect(tlPlay(g, 'b', cs('3C 4C 5C'), 0)).toBe(false);
  expect(tlPass(g, 'b', 0)).toBe(false); // the leader cannot pass
  expect(tlPlay(g, 'b', cs('3S 4C 5C'), 0)).toBe('play'); // any legal play containing it
  expect(g.mustInclude).toBeNull();
  expect(g.turn).toBe('c');
});

test('the 3 of spades may open as part of a pair', () => {
  const g = table('4S 5S', '3S 3C 9S');
  expect(tlPlay(g, 'b', cs('3S 3C'), 0)).toBe('play');
});

test('with fewer than four players the 3 of spades may be undealt: the lowest card dealt opens instead', () => {
  const g = table('4S 5S', '3C 9S');
  expect(g.turn).toBe('b');
  expect(g.mustInclude).toBe(cs('3C')[0]);
  expect(tlPlay(g, 'b', cs('9S'), 0)).toBe(false);
  expect(tlPlay(g, 'b', cs('3C'), 0)).toBe('play');
});

test('later hands: the previous winner leads, with any play', () => {
  const g = table('4S 9S', '3S', '5S 6S');
  expect(tlPlay(g, 'b', cs('3S'), 0)).toBe('win');
  expect(g.phase).toBe('ended');
  expect(g.lastWinner).toBe('b');
  // Deal again by hand: the 3 of spades is now with Ann, but Bao won, so Bao leads anything.
  g.hands = { a: cs('3S 4S'), b: cs('8S 9S'), c: cs('5S 6S') };
  tlBegin(g, 0);
  expect(g.turn).toBe('b');
  expect(g.mustInclude).toBeNull();
  expect(tlPlay(g, 'b', cs('9S'), 0)).toBe('play');
});

test('if the previous winner has left the table, the next hand opens with the lowest card again', () => {
  const g = table('4S 9S', '3S', '5S 6S');
  tlPlay(g, 'b', cs('3S'), 0);
  tlLeave(g, 'b', 0);
  expect(tlDeal(g, 'a', 0)).toBe(true);
  expect(g.mustInclude).not.toBeNull();
  expect(g.hands[g.turn!]).toContain(g.mustInclude);
});

// ---- playing, passing and tricks ---------------------------------------------------------------

test('a play must be cards you hold, a legal set, and must beat the table', () => {
  const g = table('3S 5S 5C 9S KD', '4S 6S 6C 8D 2S', '7S 7C 10S');
  expect(tlPlay(g, 'a', cs('3S 4S 5S'), 0)).toBe(false); // the 4 of spades is Bao's
  expect(tlPlay(g, 'a', cs('3S 9S'), 0)).toBe(false); // not a set
  expect(tlPlay(g, 'a', [0, 0], 0)).toBe(false); // the same card twice is not a pair
  for (const bad of [undefined, 'x', 0, [], [0.5], { length: 1, 0: 0 }]) expect(tlPlay(g, 'a', bad, 0)).toBe(false);
  expect(tlPlay(g, 'a', cs('3S'), 0)).toBe('play');
  expect(g.hands.a).toEqual(cs('5S 5C 9S KD'));
  expect(tlPlay(g, 'b', cs('6S 6C'), 0)).toBe(false); // a pair on a single
  expect(tlPlay(g, 'b', cs('4S'), 0)).toBe('play');
  expect(tlPlay(g, 'c', cs('7S'), 0)).toBe('play');
  expect(tlPlay(g, 'a', cs('5S'), 0)).toBe(false); // too low
  expect(tlPlay(g, 'a', cs('9S'), 0)).toBe('play');
  expect(g.table).toEqual({ by: 'a', name: 'Ann', cards: cs('9S') });
  expect(g.turn).toBe('b');
});

test('a player who passes is out of the trick until it ends, even if they could beat a later play', () => {
  const g = table('3S 5S KD AD', '4S 6S 2S', '7S 7C 10S', '8S 8C 9C');
  tlPlay(g, 'a', cs('3S'), 0);
  expect(tlPass(g, 'c', 0)).toBe(false); // out of turn
  expect(tlPass(g, 'b', 0)).toBe(true);
  expect(tlPlay(g, 'c', cs('7S'), 0)).toBe('play');
  expect(tlPlay(g, 'd', cs('8S'), 0)).toBe('play');
  expect(tlPlay(g, 'a', cs('KD'), 0)).toBe('play');
  // Bao holds a 2 that would win, but passed: the turn skips to Chi.
  expect(g.turn).toBe('c');
  expect(tlPlay(g, 'b', cs('2S'), 0)).toBe(false);
  expect(tlView(g, 'a', 0).players.map((p) => p.passed)).toEqual([false, true, false, false]);
  expect(tlPass(g, 'c', 0)).toBe(true);
  expect(tlPass(g, 'd', 0)).toBe(true);
  // Everyone else has passed: Ann, the last to play, leads anything, and the passes are wiped.
  expect(g.turn).toBe('a');
  expect(g.table).toBeNull();
  expect(g.passed).toEqual([]);
  expect(tlPass(g, 'a', 0)).toBe(false);
  expect(tlPlay(g, 'a', cs('5S'), 0)).toBe('play');
  expect(g.turn).toBe('b'); // Bao is back in for the new trick
  expect(tlPlay(g, 'b', cs('2S'), 0)).toBe('play');
});

test('the lead after a trick may be any kind of play', () => {
  const g = table('3S 5S 5C', '4S 6S 6C 9S', '7S 7C 10S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPass(g, 'b', 0);
  tlPass(g, 'c', 0);
  expect(tlPlay(g, 'a', cs('5S 5C'), 0)).toBe('win');
});

test('with two players, one pass hands the lead straight back', () => {
  const g = table('3S 9S KD', '4S 6S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPlay(g, 'b', cs('4S'), 0);
  tlPlay(g, 'a', cs('9S'), 0);
  tlPass(g, 'b', 0);
  expect(g.turn).toBe('a');
  expect(g.table).toBeNull();
});

test('the first player out of cards wins; everyone’s remaining cards are shown', () => {
  const g = table('3S 4D', '5S 9C 2H', '7S KS');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPlay(g, 'b', cs('5S'), 0);
  tlPass(g, 'c', 0);
  expect(tlPlay(g, 'a', cs('4D'), 0)).toBe(false);
  tlPass(g, 'a', 0);
  expect(g.turn).toBe('b');
  tlPlay(g, 'b', cs('9C'), 0);
  tlPass(g, 'c', 0);
  tlPass(g, 'a', 0);
  expect(tlPlay(g, 'b', cs('2H'), 5)).toBe('win');
  expect(g.phase).toBe('ended');
  expect(g.winner).toEqual({ id: 'b', name: 'Bao' });
  const v = tlView(g, 'zed', 5);
  expect(v.reveal).toEqual([
    { id: 'a', name: 'Ann', cards: cs('4D') },
    { id: 'b', name: 'Bao', cards: [] },
    { id: 'c', name: 'Chi', cards: cs('7S KS') },
  ]);
  expect(v.table?.cards).toEqual(cs('2H')); // the winning play stays up
  expect(v.left).toBe(0);
  // Nothing more can be played, and anyone at the table can deal again.
  expect(tlPlay(g, 'a', cs('4D'), 6)).toBe(false);
  expect(tlPass(g, 'c', 6)).toBe(false);
  expect(tlTick(g, 6 + TURN_MS * 2)).toBe(false);
  expect(tlDeal(g, 'c', 7)).toBe(true);
  expect(g.turn).toBe('b');
  expect(g.reveal).toBeNull();
});

// ---- time-outs ---------------------------------------------------------------------------------

test('time-out: a player who could pass passes', () => {
  const g = table('3S 9S', '4S 6S', '7S 8S');
  tlPlay(g, 'a', cs('3S'), 1000);
  expect(tlTick(g, 1000 + TURN_MS - 1)).toBe(false);
  expect(tlTick(g, 1000 + TURN_MS)).toBe(true);
  expect(g.passed).toEqual(['b']);
  expect(g.hands.b).toEqual(cs('4S 6S'));
  expect(g.turn).toBe('c');
  expect(g.until).toBe(1000 + TURN_MS * 2); // the next player gets a full turn
  expect(tlTick(g, 1000 + TURN_MS)).toBe(false);
});

test('time-out: a player who is leading plays their lowest single', () => {
  const g = table('5S 5C 9S', '4S 6S', '7S 8S');
  // Bao holds the lowest card dealt and idles on the opening lead.
  expect(g.turn).toBe('b');
  expect(tlTick(g, TURN_MS)).toBe(true);
  expect(g.table).toEqual({ by: 'b', name: 'Bao', cards: cs('4S') });
  expect(g.turn).toBe('c');
  // Everyone idles: two passes, then Bao leads again and his last card goes, which wins.
  expect(tlTick(g, TURN_MS * 2)).toBe(true);
  expect(tlTick(g, TURN_MS * 3)).toBe(true);
  expect(g.turn).toBe('b');
  expect(g.table).toBeNull();
  expect(tlTick(g, TURN_MS * 4)).toBe(true);
  expect(g.phase).toBe('ended');
  expect(g.winner?.id).toBe('b');
});

test('an abandoned table always finishes: idle players alone play a full deal out', () => {
  const g = newTienlen();
  for (const p of people) tlJoin(g, p);
  let seed = 3;
  tlDeal(g, 'a', 0, () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648));
  let now = 0;
  for (let i = 0; i < 400 && g.phase === 'play'; i++) expect(tlTick(g, (now += TURN_MS))).toBe(true);
  expect(g.phase).toBe('ended');
});

test('the view counts down the time left in the turn', () => {
  const g = table('3S 9S', '4S 6S');
  expect(tlView(g, 'a', 4000).left).toBe(TURN_MS - 4000);
  expect(tlView(g, 'a', TURN_MS * 3).left).toBe(0);
});

// ---- leaving -----------------------------------------------------------------------------------

test('a player who leaves on their turn is removed and the turn moves on', () => {
  const g = table('3S 9S', '4S 6S', '7S 8S', '10S JS');
  tlPlay(g, 'a', cs('3S'), 0);
  expect(tlLeave(g, 'b', 50)).toBe(true);
  expect(g.players.map((p) => p.id)).toEqual(['a', 'c', 'd']);
  expect(g.hands.b).toBeUndefined();
  expect(g.turn).toBe('c');
  expect(g.until).toBe(50 + TURN_MS);
  expect(tlLeave(g, 'b', 60)).toBe(false);
});

test('a player who leaves out of turn does not disturb the turn', () => {
  const g = table('3S 9S', '4S 6S', '7S 8S', '10S JS');
  tlPlay(g, 'a', cs('3S'), 0);
  tlLeave(g, 'd', 0);
  expect(g.turn).toBe('b');
  tlPlay(g, 'b', cs('4S'), 0);
  tlPlay(g, 'c', cs('7S'), 0);
  expect(g.turn).toBe('a');
});

test('if the player who owns the table leaves, the trick still ends once the rest have passed', () => {
  const g = table('3S 9S', '4S 6S', '7S 8S', '10S JS');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPass(g, 'b', 0);
  tlLeave(g, 'a', 0);
  expect(g.turn).toBe('c');
  tlPass(g, 'c', 0);
  tlPass(g, 'd', 0);
  // Nobody is left to come back round to: the next seat leads a fresh trick.
  expect(g.table).toBeNull();
  expect(g.passed).toEqual([]);
  expect(g.turn).toBe('b');
  expect(tlPlay(g, 'b', cs('6S'), 0)).toBe('play');
});

test('if the last remaining player in a trick beats a departed owner, they lead next', () => {
  const g = table('3S 9S', '4S 6S', '7S 8S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPass(g, 'b', 0);
  tlLeave(g, 'a', 0);
  expect(tlPlay(g, 'c', cs('7S'), 0)).toBe('play');
  expect(g.turn).toBe('c');
  expect(g.table).toBeNull();
});

test('if the opener leaves before playing, the lowest card still at the table opens', () => {
  const g = table('3S 9S', '4S 6S', '5S 8S');
  expect(g.turn).toBe('a');
  tlLeave(g, 'a', 0);
  expect(g.turn).toBe('b');
  expect(g.mustInclude).toBe(cs('4S')[0]);
  expect(tlPlay(g, 'b', cs('6S'), 0)).toBe(false);
  expect(tlPlay(g, 'b', cs('4S'), 0)).toBe('play');
});

test('with one player left the hand ends and they win it', () => {
  const g = table('3S 9S', '4S 6S', '7S 8S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlLeave(g, 'b', 0);
  expect(g.phase).toBe('play');
  tlLeave(g, 'c', 0);
  expect(g.phase).toBe('ended');
  expect(g.winner).toEqual({ id: 'a', name: 'Ann' });
  expect(g.turn).toBeNull();
  expect(tlTick(g, TURN_MS * 5)).toBe(false);
  expect(tlDeal(g, 'a', 0)).toBe(false); // needs a second player again
  tlLeave(g, 'a', 0);
  expect(g).toEqual(newTienlen()); // an empty table starts a new session
});

// ---- what the browser may know -----------------------------------------------------------------

test('tlIllegal explains why Play is disabled', () => {
  const hand = cs('3S 5S 5C 9S');
  expect(tlIllegal(hand, null, null, cs('5S 5C'))).toBeNull();
  expect(tlIllegal(hand, null, 0, cs('5S 5C'))).toContain('3♠');
  expect(tlIllegal(hand, null, 0, cs('3S'))).toBeNull();
  expect(tlIllegal(hand, cs('4S'), null, cs('3S'))).toContain('beat');
  expect(tlIllegal(hand, cs('4S'), null, cs('9S'))).toBeNull();
  expect(tlIllegal(hand, null, null, cs('3S 9S'))).toContain('legal');
  expect(tlIllegal(hand, null, null, cs('KH'))).toContain('hold');
});

test('no view contains another player’s hand', () => {
  const g = table('3S 5S 5C 9S', '4S 6S 6C 8D', '7S 7C 10S JD', 'QS KS AS 2S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPass(g, 'b', 0);
  const shown = cs('3S'); // the only card anyone has seen
  for (const viewer of ['a', 'b', 'c', 'd', 'zed', null]) {
    const v = tlView(g, viewer, 0);
    const mine = viewer && g.hands[viewer] ? g.hands[viewer] : null;
    expect(v.hand).toEqual(mine);
    expect(v.reveal).toBeNull();
    expect(v.players.map((p) => p.count)).toEqual([3, 4, 4, 4]);
    // Apart from the card counts and the clock, the only numbers in the view are the viewer's cards and the table's.
    const nums: number[] = [];
    JSON.stringify({ ...v, left: undefined, players: [] }, (_k, x) => (typeof x === 'number' ? (nums.push(x), x) : x));
    expect(nums.sort((x, y) => x - y)).toEqual([...shown, ...(mine ?? [])].sort((x, y) => x - y));
  }
});

// ---- the server --------------------------------------------------------------------------------

test('the server never broadcasts, sends each person only their own hand, and announces the winner', () => {
  const room = [...people, { id: 'w', name: 'Watcher' }].map((p) => ({ ...p, color: '', look: '', x: 0, z: 0, ry: 0, seat: null }) as PlayerInfo);
  const sent: { to: string; view: ReturnType<typeof tlView> }[] = [];
  const notices: string[] = [];
  let broadcasts = 0;
  const io: GameIO = {
    players: () => room,
    send: (to, view) => sent.push({ to, view: view as ReturnType<typeof tlView> }),
    broadcast: () => broadcasts++,
    notice: (t) => notices.push(t),
    emote: () => {},
    put: () => {},
    nudge: () => {},
    resetBall: () => {},
    setScore: () => {},
  };
  const s = create(io);
  for (const p of room.slice(0, 4)) s.onAction(p, { k: 'join' }, 0);
  s.onAction(room[4], { k: 'deal' }, 0); // a watcher cannot deal
  expect(sent.every((m) => m.view.phase === 'lobby')).toBe(true);
  s.onAction(room[0], { k: 'deal' }, 0);
  const last = () => Object.fromEntries(room.map((p) => [p.id, sent.filter((m) => m.to === p.id).at(-1)!.view]));
  let v = last();
  const hands = people.map((p) => v[p.id].hand!);
  expect(new Set(hands.flat()).size).toBe(52);
  expect(v.w.hand).toBeNull();
  // Every message ever sent carries at most the receiver's own hand.
  for (const m of sent) if (m.view.hand) expect(m.view.hand).toEqual(v[m.to].hand);

  // Hostile actions change nothing.
  const count = sent.length;
  const opener = room.find((p) => p.id === v.a.turn)!;
  const other = room.find((p) => p.id !== opener.id && p.id !== 'w')!;
  s.onAction(other, { k: 'play', cards: [v[other.id].hand![0]] }, 1); // out of turn
  s.onAction(opener, { k: 'play', cards: [v[other.id].hand![0]] }, 1); // someone else's card
  s.onAction(opener, { k: 'play', cards: 'all of them' }, 1);
  s.onAction(opener, { k: 'play' }, 1);
  s.onAction(opener, { k: 'pass' }, 1);
  s.onAction(room[4], { k: 'pass' }, 1);
  s.onAction(opener, { k: 'nonsense' }, 1);
  expect(sent.length).toBe(count);

  s.onAction(opener, { k: 'play', cards: [0] }, 1);
  v = last();
  expect(v.w.table?.cards).toEqual([0]);
  expect(v[opener.id].hand).toHaveLength(12);

  // A latecomer gets the public view only.
  sent.length = 0;
  s.onJoin!({ ...room[4], id: 'late' }, 2);
  expect(sent).toHaveLength(1);
  expect(sent[0].view.hand).toBeNull();

  // Let the clock play the hand out: it ends, and the room is told once.
  let now = 2;
  for (let i = 0; i < 400 && notices.length === 0; i++) s.tick!((now += 30_000));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('won the hand');
  expect(last().w.reveal).toHaveLength(4);
  expect(broadcasts).toBe(0);
});
