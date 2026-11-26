import { expect, test, vi } from 'vitest';
import {
  RANKS,
  TURN_MS,
  beats,
  cardName,
  cardOf,
  classify,
  instantWin,
  isRed,
  newTienlen,
  tlBegin,
  tlDeal,
  tlIllegal,
  tlJoin,
  tlLeave,
  tlPass,
  tlPlay,
  tlThoi,
  tlTick,
  tlVariant,
  tlView,
  type TlGame,
  type Variant,
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
const kind = (text: string, v: Variant = 'nam') => classify(cs(text), v)?.kind ?? null;
/** Does play `a` beat `b` on the table? */
const wins = (a: string, b: string, v: Variant = 'nam') => beats(classify(cs(a), v)!, classify(cs(b), v)!, v);
const north = (a: string, b: string) => wins(a, b, 'bac');

const people = [
  { id: 'a', name: 'Ann' },
  { id: 'b', name: 'Bao' },
  { id: 'c', name: 'Chi' },
  { id: 'd', name: 'Dung' },
];
/** A hand in progress with exactly these cards (no need for 13 each). The first hand of a session unless `lastWinner` is given. */
const seat = (variant: Variant, hands: string[], lastWinner: string | null = null): TlGame => {
  const g = newTienlen();
  g.variant = variant;
  hands.forEach((h, i) => {
    tlJoin(g, people[i]);
    g.hands[people[i].id] = cs(h);
  });
  g.lastWinner = lastWinner;
  tlBegin(g, 0);
  return g;
};
const nam = (...hands: string[]) => seat('nam', hands);
const bac = (...hands: string[]) => seat('bac', hands);
const places = (g: TlGame) => g.results!.map((r) => `${r.place} ${r.name}`);
const seeded = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const RUN3 = '3S 3C 4D 4H 5S 5H';
const RUN4 = '3S 3C 4D 4H 5S 5H 6C 6D';
const RUN5 = '3S 3C 4D 4H 5S 5H 6C 6D 7S 7H';

// ---- cards -------------------------------------------------------------------------------------

test('cards order by rank 3..2 first, then suit spades < clubs < diamonds < hearts', () => {
  const order = cs('3S 3C 3D 3H 4S 10H JS KH AS AH 2S 2C 2D 2H');
  expect([...order].sort((x, y) => x - y)).toEqual(order);
  expect(cs('3S')[0]).toBe(0);
  expect(cs('2H')[0]).toBe(51);
  expect(cardName(cs('10D')[0])).toBe('10♦');
  expect(cs('3S 3C 3D 3H').map(isRed)).toEqual([false, false, true, true]);
});

// ---- Miền Nam: classification ------------------------------------------------------------------

test('nam: singles, pairs, triples and four of a kind go by rank only', () => {
  expect(classify(cs('7D'), 'nam')).toEqual({ kind: 'single', n: 1, top: cs('7D')[0] });
  expect(classify(cs('7D 7S'), 'nam')).toEqual({ kind: 'pair', n: 2, top: cs('7D')[0] }); // mixed colours are fine
  expect(kind('2S 2H')).toBe('pair');
  expect(kind('9S 9C 9H')).toBe('triple');
  expect(kind('2S 2C 2H')).toBe('triple');
  expect(kind('JS JC JD JH')).toBe('quad');
  expect(kind('7D 8D')).toBeNull();
  expect(kind('7D 7S 8D')).toBeNull();
  expect(kind('7D 7S 7C 8D')).toBeNull();
});

test('nam: straights need three or more consecutive ranks, in any suits, and never a 2', () => {
  expect(classify(cs('5H 3S 4D'), 'nam')).toEqual({ kind: 'straight', n: 3, top: cs('5H')[0] });
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

test('nam: runs of pairs need three or more consecutive pairs and never 2s', () => {
  expect(classify(cs(RUN3), 'nam')).toEqual({ kind: 'pairs', n: 6, top: cs('5H')[0] });
  expect(kind('3S 3C 4D 4H')).toBeNull(); // two pairs is not a play
  expect(kind('3S 3C 4D 4H 6S 6H')).toBeNull();
  expect(kind('3S 3C 4D 4H 5S 6H')).toBeNull();
  expect(kind(RUN4)).toBe('pairs');
  expect(kind(RUN5)).toBe('pairs');
  expect(kind('KS KC AD AH 2S 2H')).toBeNull();
  expect(kind('QS QC KS KC AD AH')).toBe('pairs');
  expect(kind('3S 3C 3D 4S 4C 4D')).toBeNull();
});

test('classify rejects rubbish from a browser, in both versions', () => {
  for (const v of ['nam', 'bac'] as const)
    for (const bad of [undefined, null, 'x', 5, {}, [], [1.5], [-1], [52], ['3'], [NaN], [4, 4], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]]) expect(classify(bad, v)).toBeNull();
});

// Found by tests/sim/tienlen.sim.test.ts: sorting the cards before checking them subtracted objects, which throws for these.
test('regression: a play containing objects that cannot be turned into numbers is refused, not thrown on', () => {
  const nasty = JSON.parse('[{"valueOf":0,"toString":0}, 1]');
  for (const v of ['nam', 'bac'] as const) {
    expect(classify(nasty, v)).toBeNull();
    expect(classify([Object.create(null), 0], v)).toBeNull();
    expect(classify(new Array(1), v)).toBeNull();
    const g = seat(v, ['3S 4S', '5S 6S']);
    const before = JSON.stringify(g);
    expect(tlPlay(g, 'a', nasty, 0)).toBe(false);
    expect(typeof tlIllegal(v, g.hands.a, null, null, nasty)).toBe('string');
    expect(JSON.stringify(g)).toBe(before);
  }
});

// ---- Miền Bắc: classification ------------------------------------------------------------------

test('bac: a pair must be the same rank and the same colour', () => {
  expect(kind('7S 7C', 'bac')).toBe('pair'); // two blacks
  expect(kind('7D 7H', 'bac')).toBe('pair'); // two reds
  expect(kind('7S 7D', 'bac')).toBeNull();
  expect(kind('7C 7H', 'bac')).toBeNull();
  expect(kind('2S 2C', 'bac')).toBe('pair');
  expect(kind('2S 2H', 'bac')).toBeNull();
});

test('bac: triples and four of a kind go by rank only', () => {
  expect(kind('9S 9C 9H', 'bac')).toBe('triple');
  expect(kind('2S 2D 2H', 'bac')).toBe('triple');
  expect(kind('JS JC JD JH', 'bac')).toBe('quad');
});

test('bac: a straight is three or more consecutive ranks all of one suit, never a 2', () => {
  expect(classify(cs('5S 3S 4S'), 'bac')).toEqual({ kind: 'straight', n: 3, top: cs('5S')[0] });
  expect(kind('3S 4S 5H', 'bac')).toBeNull();
  expect(kind('3S 4C 5S', 'bac')).toBeNull(); // same colour is not enough
  expect(kind('QH KH AH', 'bac')).toBe('straight');
  expect(kind('KH AH 2H', 'bac')).toBeNull();
  expect(kind('3D 4D', 'bac')).toBeNull();
  expect(kind('3D 4D 5D 6D 7D 8D 9D 10D JD QD KD AD', 'bac')).toBe('straight');
});

test('bac: there are no consecutive pairs', () => {
  expect(kind('3S 3C 4S 4C 5S 5C', 'bac')).toBeNull();
  expect(kind('3S 3C 4S 4C 5S 5C 6S 6C', 'bac')).toBeNull();
  expect(kind('3S 3C 4S 4C 5S 5C', 'nam')).toBe('pairs');
});

// ---- Miền Nam: beating -------------------------------------------------------------------------

test('nam: a higher single wins on rank, then on suit, whatever the suits', () => {
  expect(wins('4S', '3H')).toBe(true);
  expect(wins('3H', '3D')).toBe(true);
  expect(wins('3S', '3C')).toBe(false);
  expect(wins('2S', 'AH')).toBe(true);
  expect(wins('AH', '2S')).toBe(false);
  expect(wins('2H', '2D')).toBe(true);
  expect(wins('7D', '7D')).toBe(false);
});

test('nam: pairs, triples, straights and pair runs are compared by their highest card', () => {
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

test('nam: the kind and the number of cards must match', () => {
  expect(wins('9S 9C', '3S')).toBe(false);
  expect(wins('3S', '3C 3D')).toBe(false);
  expect(wins('9S 9C 9D', '3S 3C')).toBe(false);
  expect(wins('9S 10S JS QS', '3S 4S 5S')).toBe(false); // a longer straight does not beat a shorter one
  expect(wins('9S 10S JS', '3S 4S 5S 6S')).toBe(false);
  expect(wins('2S 2H', '2D')).toBe(false);
  expect(wins('2S', 'KS KH')).toBe(false);
  // Bombs only work against 2s and against each other.
  expect(wins('KS KC KD KH', 'AS')).toBe(false);
  expect(wins('KS KC KD KH', 'AS AH')).toBe(false);
  expect(wins('KS KC KD KH', '3S 4S 5S 6S')).toBe(false);
  expect(wins(RUN3, 'AS')).toBe(false);
  expect(wins(RUN4, 'AS AH')).toBe(false);
  expect(wins(RUN5, 'AS AC AH')).toBe(false);
});

test('nam chop: a single 2 falls to three consecutive pairs, four of a kind, or a longer run', () => {
  expect(wins(RUN3, '2H')).toBe(true);
  expect(wins('3S 3C 3D 3H', '2H')).toBe(true);
  expect(wins(RUN4, '2S')).toBe(true);
  expect(wins(RUN5, '2S')).toBe(true);
  expect(wins('AS AC AH', '2S')).toBe(false);
  expect(wins('3S 4S 5S', '2S')).toBe(false);
});

test('nam chop: a pair of 2s falls to four of a kind or to four or five consecutive pairs, not to three', () => {
  expect(wins('3S 3C 3D 3H', '2D 2H')).toBe(true);
  expect(wins(RUN4, '2D 2H')).toBe(true);
  expect(wins(RUN5, '2D 2H')).toBe(true);
  expect(wins(RUN3, '2S 2C')).toBe(false);
});

test('nam chop: three 2s fall only to five consecutive pairs', () => {
  expect(wins(RUN5, '2S 2C 2D')).toBe(true);
  expect(wins(RUN4, '2S 2C 2D')).toBe(false);
  expect(wins('AS AC AD AH', '2S 2C 2D')).toBe(false);
});

test('nam chop: three consecutive pairs fall to four of a kind, to four or five pairs, or to a higher three', () => {
  expect(wins('3S 3C 3D 3H', 'QS QC KS KC AD AH')).toBe(true);
  expect(wins(RUN4, 'QS QC KS KC AD AH')).toBe(true);
  expect(wins(RUN5, 'QS QC KS KC AD AH')).toBe(true);
  expect(wins('4S 4C 5D 5H 6S 6H', RUN3)).toBe(true);
  expect(wins(RUN3, '4S 4C 5D 5C 6S 6D')).toBe(false);
  expect(wins('QS QC KS KC AD AH', '3S 3C 3D 3H')).toBe(false); // but not the other way round
});

test('nam chop: four of a kind falls to a higher four of a kind or to four or five consecutive pairs', () => {
  expect(wins('4S 4C 4D 4H', '3S 3C 3D 3H')).toBe(true);
  expect(wins('3S 3C 3D 3H', '4S 4C 4D 4H')).toBe(false);
  expect(wins(RUN4, '2S 2C 2D 2H')).toBe(true);
  expect(wins(RUN5, 'AS AC AD AH')).toBe(true);
  expect(wins(RUN3, '9S 9C 9D 9H')).toBe(false);
});

test('nam chop: four consecutive pairs fall to five, or to a higher four; nothing but a higher five beats five', () => {
  expect(wins(RUN5, '10S 10C JD JH QS QH KC KD')).toBe(true);
  expect(wins('4S 4C 5D 5H 6S 6H 7C 7D', RUN4)).toBe(true);
  expect(wins('2S 2C 2D 2H', RUN4)).toBe(false);
  expect(wins('4S 4C 5D 5H 6S 6H 7C 7D 8S 8C', RUN5)).toBe(true);
  expect(wins('2S 2C 2D 2H', RUN5)).toBe(false);
  expect(wins(RUN4, RUN5)).toBe(false);
});

test('nam: a chop works in play, and can itself be chopped', () => {
  const g = nam('3S 2H 9D', '4S 4C 5S 5C 6S 6C 9S', '7S 7C 7D 7H KS', '8S 8C');
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

test('nam: four of a kind chops a pair of 2s in play', () => {
  const g = seat('nam', ['2S 2C 9D', '7S 7C 7D 7H KS'], 'a');
  expect(tlPlay(g, 'a', cs('2S 2C'), 0)).toBe('play');
  expect(tlPlay(g, 'b', cs('7S 7C 7D 7H'), 0)).toBe('chop');
});

// ---- Miền Bắc: beating -------------------------------------------------------------------------

test('bac: a single needs a higher card of the same suit', () => {
  expect(north('5S', '4S')).toBe(true);
  expect(north('AS', '4S')).toBe(true);
  expect(north('4S', '5S')).toBe(false);
  expect(north('5H', '4S')).toBe(false); // higher, but the wrong suit
  expect(north('5C', '4S')).toBe(false); // same colour is not enough
  expect(north('AH', 'KD')).toBe(false);
});

test('bac: any 2 beats any other single, and a 2 falls only to a higher-suited 2', () => {
  expect(north('2S', 'AH')).toBe(true); // the lowest 2 over the highest ace, across suits
  expect(north('2S', '3D')).toBe(true);
  expect(north('2C', '2S')).toBe(true);
  expect(north('2H', '2D')).toBe(true);
  expect(north('2S', '2C')).toBe(false);
  expect(north('AH', '2S')).toBe(false);
  expect(north('AS', '2S')).toBe(false);
});

test('bac: a pair needs a higher pair of the same colour, but a pair of 2s beats any other pair', () => {
  expect(north('5S 5C', '4S 4C')).toBe(true);
  expect(north('5D 5H', '4D 4H')).toBe(true);
  expect(north('5D 5H', '4S 4C')).toBe(false); // red on black
  expect(north('5S 5C', '4D 4H')).toBe(false);
  expect(north('4S 4C', '5S 5C')).toBe(false);
  expect(north('2S 2C', 'AD AH')).toBe(true); // black 2s over red aces
  expect(north('2D 2H', 'AS AC')).toBe(true);
  expect(north('AD AH', '2S 2C')).toBe(false);
  expect(north('2D 2H', '2S 2C')).toBe(true); // the red 2s are the higher pair of 2s
  expect(north('2S 2C', '2D 2H')).toBe(false);
});

test('bac: a triple needs a higher triple', () => {
  expect(north('9S 9C 9D', '8C 8D 8H')).toBe(true);
  expect(north('8C 8D 8H', '9S 9C 9D')).toBe(false);
  expect(north('2S 2C 2D', 'AC AD AH')).toBe(true);
});

test('bac: a straight needs the same suit and length with a higher top card', () => {
  expect(north('4S 5S 6S', '3S 4S 5S')).toBe(true);
  expect(north('3S 4S 5S', '4S 5S 6S')).toBe(false);
  expect(north('4H 5H 6H', '3S 4S 5S')).toBe(false); // the wrong suit
  expect(north('4S 5S 6S 7S', '3S 4S 5S')).toBe(false);
  expect(north('9S 10S JS', '3S 4S 5S 6S')).toBe(false);
});

test('bac chop: four of a kind chops a single 2 or a pair of 2s, a higher four beats a lower, and nothing else chops', () => {
  expect(north('3S 3C 3D 3H', '2H')).toBe(true);
  expect(north('3S 3C 3D 3H', '2D 2H')).toBe(true);
  expect(north('4S 4C 4D 4H', '3S 3C 3D 3H')).toBe(true);
  expect(north('3S 3C 3D 3H', '4S 4C 4D 4H')).toBe(false);
  expect(north('3S 3C 3D 3H', 'AH')).toBe(false);
  expect(north('3S 3C 3D 3H', 'AD AH')).toBe(false);
  expect(north('3S 3C 3D 3H', '2S 2C 2D')).toBe(false); // three 2s are safe
  expect(north('3S 3C 3D 3H', '5S 6S 7S 8S')).toBe(false);
  expect(north('9S 9C 9D', '2S')).toBe(false);
  expect(north('9S 9C', '2S')).toBe(false);
});

test('bac: the suit rule is enforced in play', () => {
  const g = bac('3S 5H 9S', '4H 6S 2C', '7S 8D KS');
  expect(tlPlay(g, 'a', cs('3S'), 0)).toBe('play');
  expect(tlPlay(g, 'b', cs('4H'), 0)).toBe(false); // higher, wrong suit
  expect(tlPlay(g, 'b', cs('6S'), 0)).toBe('play');
  expect(tlPlay(g, 'c', cs('8D'), 0)).toBe(false);
  expect(tlPlay(g, 'c', cs('7S'), 0)).toBe('play');
  expect(tlPlay(g, 'a', cs('5H'), 0)).toBe(false);
  expect(tlPlay(g, 'a', cs('9S'), 0)).toBe('play');
  expect(tlPlay(g, 'b', cs('2C'), 0)).toBe('play'); // a 2 goes on anything
  expect(tlPlay(g, 'c', cs('KS'), 0)).toBe(false);
});

// ---- the panel's reasons -----------------------------------------------------------------------

test('tlIllegal explains why Play is disabled', () => {
  const hand = cs('3S 5S 5C 9S');
  expect(tlIllegal('nam', hand, null, null, cs('5S 5C'))).toBeNull();
  expect(tlIllegal('nam', hand, null, 0, cs('5S 5C'))).toContain('3♠');
  expect(tlIllegal('nam', hand, null, 0, cs('3S'))).toBeNull();
  expect(tlIllegal('nam', hand, cs('4S'), null, cs('3S'))).toContain('beat');
  expect(tlIllegal('nam', hand, cs('4H'), null, cs('9S'))).toBeNull();
  expect(tlIllegal('nam', hand, null, null, cs('3S 9S'))).toContain('legal');
  expect(tlIllegal('nam', hand, null, null, cs('KH'))).toContain('hold');
});

test('tlIllegal gives the northern reason when it is the northern rules that say no', () => {
  const hand = cs('3S 4S 5H 7S 7D 7H 9S 9D 4C 5C 6C');
  expect(tlIllegal('bac', hand, null, null, cs('7S 7D'))).toBe('Miền Bắc: a pair must be the same colour.');
  expect(tlIllegal('nam', hand, null, null, cs('7S 7D'))).toBeNull();
  expect(tlIllegal('bac', hand, null, null, cs('7D 7H'))).toBeNull();
  expect(tlIllegal('bac', hand, null, null, cs('3S 4S 5H'))).toBe('Miền Bắc: a straight must be all one suit.');
  expect(tlIllegal('bac', hand, null, null, cs('4C 5C 6C'))).toBeNull();
  expect(tlIllegal('bac', hand, null, null, cs('3S 3C 4S 4C 5S 5C'))).toBe('Miền Bắc: there are no consecutive pairs.');
  expect(tlIllegal('bac', hand, null, null, cs('3S 9S'))).toBe('Not a legal set of cards.');
  expect(tlIllegal('bac', hand, cs('8D'), null, cs('9S'))).toBe('Miền Bắc: needs a higher diamond, or a 2.');
  expect(tlIllegal('bac', hand, cs('10D'), null, cs('9D'))).toBe('Miền Bắc: needs a higher diamond, or a 2.');
  expect(tlIllegal('bac', hand, cs('8D'), null, cs('9D'))).toBeNull();
  expect(tlIllegal('bac', hand, cs('2S'), null, cs('9D'))).toBe('Miền Bắc: only a higher 2 or four of a kind beats a 2.');
  expect(tlIllegal('bac', hand, cs('6S 6C'), null, cs('7D 7H'))).toBe('Miền Bắc: needs a higher black pair, or a pair of 2s.');
  expect(tlIllegal('bac', hand, cs('2S 2C'), null, cs('7D 7H'))).toContain('pair of 2s');
  expect(tlIllegal('bac', hand, cs('3H 4H 5H'), null, cs('4C 5C 6C'))).toBe('Miền Bắc: needs a higher straight in hearts.');
  expect(tlIllegal('bac', hand, cs('3H'), null, cs('7D 7H'))).toBe('That does not beat the table.');
  // No opening-card rule in the north, so nothing to complain about there.
  expect(tlIllegal('bac', hand, null, null, cs('9S'))).toBeNull();
});

// ---- joining, the version, dealing -------------------------------------------------------------

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
  expect(tlDeal(g, 'a', 0, seeded(7))).toBe(true);
  expect(tlDeal(g, 'a', 0)).toBe(false); // not in the middle of a hand
});

test('the version is southern by default, and only a seated player can switch it, only between hands', () => {
  const g = newTienlen();
  expect(g.variant).toBe('nam');
  expect(tlVariant(g, 'a', 'bac')).toBe(false); // not at the table
  tlJoin(g, people[0]);
  tlJoin(g, people[1]);
  expect(tlVariant(g, 'a', 'trung')).toBe(false);
  expect(tlVariant(g, 'a', undefined)).toBe(false);
  expect(tlVariant(g, 'b', 'bac')).toBe(true);
  expect(tlVariant(g, 'b', 'bac')).toBe(false); // already that
  expect(tlView(g, 'zed', 0).variant).toBe('bac'); // everyone is shown the choice
  g.hands = { a: cs('3S 4S'), b: cs('5S 6S') };
  tlBegin(g, 0);
  expect(tlVariant(g, 'a', 'nam')).toBe(false); // a hand is in progress
  expect(tlView(g, 'a', 0).variant).toBe('bac');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPass(g, 'b', 0);
  expect(tlPlay(g, 'a', cs('4S'), 0)).toBe('end');
  expect(tlVariant(g, 'a', 'nam')).toBe(true); // between hands again
});

test('a deal gives 13 different cards each, sorted, and the 3 of spades leads the first hand', () => {
  for (const v of ['nam', 'bac'] as const) {
    const g = newTienlen();
    for (const p of people) tlJoin(g, p);
    tlVariant(g, 'a', v);
    tlDeal(g, 'b', 1000, seeded(7));
    expect(g.phase).toBe('play');
    const all = people.flatMap((p) => g.hands[p.id]);
    expect(new Set(all).size).toBe(52);
    for (const p of people) {
      expect(g.hands[p.id]).toHaveLength(13);
      expect(g.hands[p.id]).toEqual([...g.hands[p.id]].sort((x, y) => x - y));
    }
    expect(g.hands[g.turn!]).toContain(0);
    expect(g.mustInclude).toBe(v === 'nam' ? 0 : null);
    expect(g.until).toBe(1000 + TURN_MS);
  }
});

test('nobody can sit down while a hand is being played', () => {
  const g = nam('3S 4S', '5S 6S');
  expect(tlJoin(g, people[2])).toBe(false);
});

// ---- the opening rule --------------------------------------------------------------------------

test('nam, first hand: the holder of the 3 of spades leads and the first play must include it', () => {
  const g = nam('4S 5S 6S', '3S 3C 4C 5C 9S', '7S 8S');
  expect(g.turn).toBe('b');
  expect(tlPlay(g, 'a', cs('4S'), 0)).toBe(false); // not their turn
  expect(tlPlay(g, 'b', cs('9S'), 0)).toBe(false); // leaves out the 3 of spades
  expect(tlPlay(g, 'b', cs('3C 4C 5C'), 0)).toBe(false);
  expect(tlPass(g, 'b', 0)).toBe(false); // the leader cannot pass
  expect(tlPlay(g, 'b', cs('3S 4C 5C'), 0)).toBe('play'); // any legal play containing it
  expect(g.mustInclude).toBeNull();
  expect(g.turn).toBe('c');
});

test('nam: the 3 of spades may open as part of a pair', () => {
  const g = nam('4S 5S', '3S 3C 9S');
  expect(tlPlay(g, 'b', cs('3S 3C'), 0)).toBe('play');
});

test('nam: if the 3 of spades was not dealt, the lowest card dealt opens instead and must be included', () => {
  const g = nam('4S 5S', '3C 9S');
  expect(g.turn).toBe('b');
  expect(g.mustInclude).toBe(cs('3C')[0]);
  expect(tlPlay(g, 'b', cs('9S'), 0)).toBe(false);
  expect(tlPlay(g, 'b', cs('3C'), 0)).toBe('play');
});

test('bac, first hand: the holder of the 3 of spades leads but need not play it', () => {
  const g = bac('4S 5S 6S', '3S 3C 9S JS', '7S 8S');
  expect(g.turn).toBe('b');
  expect(g.mustInclude).toBeNull();
  expect(tlView(g, 'b', 0).mustInclude).toBeNull();
  expect(tlPlay(g, 'b', cs('9S'), 0)).toBe('play');
  // And with no 3 of spades dealt, the lowest card's holder leads.
  expect(bac('4S 5S', '3C 9S').turn).toBe('b');
});

test('later hands: the previous winner leads, with any play, in both versions', () => {
  for (const v of ['nam', 'bac'] as const) {
    const g = seat(v, ['4S 9S', '3S']);
    expect(tlPlay(g, 'b', cs('3S'), 0)).toBe('end');
    expect(g.lastWinner).toBe('b');
    // Deal again by hand: the 3 of spades is now with Ann, but Bao won, so Bao leads anything.
    g.hands = { a: cs('3S 4S'), b: cs('8S 9S') };
    tlBegin(g, 0);
    expect(g.turn).toBe('b');
    expect(g.mustInclude).toBeNull();
    expect(tlPlay(g, 'b', cs('9S'), 0)).toBe('play');
  }
});

// ---- playing, passing and tricks ---------------------------------------------------------------

test('a play must be cards you hold, a legal set, and must beat the table', () => {
  const g = nam('3S 5S 5C 9S KD', '4S 6S 6C 8D 2S', '7S 7C 10S');
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
  const g = nam('3S 5S KD AD', '4S 6S 2S', '7S 7C 10S', '8S 8C 9C');
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
  const g = nam('3S 5S 5C 8D', '4S 6S 6C 9S', '7S 7C 10S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPass(g, 'b', 0);
  tlPass(g, 'c', 0);
  expect(tlPlay(g, 'a', cs('5S 5C'), 0)).toBe('play');
});

test('with two players, one pass hands the lead straight back', () => {
  const g = nam('3S 9S KD', '4S 6S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPlay(g, 'b', cs('4S'), 0);
  tlPlay(g, 'a', cs('9S'), 0);
  tlPass(g, 'b', 0);
  expect(g.turn).toBe('a');
  expect(g.table).toBeNull();
});

// ---- going out, places and hưởng sái -----------------------------------------------------------

test('with two players the first out wins and the hand ends', () => {
  const g = nam('3S 2S', '4S 5S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPlay(g, 'b', cs('4S'), 0);
  expect(tlPlay(g, 'a', cs('2S'), 0)).toBe('end'); // going out on a 2 is fine in the south
  expect(g.phase).toBe('ended');
  expect(places(g)).toEqual(['Nhất Ann', 'Bét Bao']);
  expect(g.results![1].cards).toEqual(cs('5S'));
  expect(g.winner).toEqual({ id: 'a', name: 'Ann' });
});

test('play goes on after the first player is out, ranking nhất, nhì, ba, bét; the last unbeaten play passes its lead on (hưởng sái)', () => {
  for (const v of ['nam', 'bac'] as const) {
    const g = seat(v, ['3S 9S 10C', '4S JS QC', '5S KS AS 2S', '6S 2H']);
    for (const [who, card] of [['a', '3S'], ['b', '4S'], ['c', '5S'], ['d', '6S'], ['a', '9S'], ['b', 'JS'], ['c', 'KS']]) expect(tlPlay(g, who, cs(card), 0)).toBe('play');
    // Dung plays her last card in the south; in the north a 2 would be thối, so there she is given a plain last card.
    if (v === 'bac') g.hands.d = cs('AS');
    expect(tlPlay(g, 'd', v === 'bac' ? cs('AS') : cs('2H'), 0)).toBe('out');
    expect(g.phase).toBe('play');
    expect(tlView(g, 'a', 0).players.map((p) => p.out)).toEqual([false, false, false, true]);
    expect(tlView(g, 'd', 0).hand).toEqual([]);
    // The others may still try to beat it.
    expect(g.turn).toBe('a');
    expect(g.table?.by).toBe('d');
    expect(tlPass(g, 'a', 0)).toBe(true);
    expect(tlPass(g, 'b', 0)).toBe(true);
    expect(tlPass(g, 'c', 0)).toBe(true);
    // Nobody did, and Dung is gone: the next player still in after her leads.
    expect(g.turn).toBe('a');
    expect(g.table).toBeNull();
    expect(g.passed).toEqual([]);
    expect(g.note).toContain('hưởng sái');
    expect(tlPlay(g, 'd', cs('3S'), 0)).toBe(false); // someone who is out cannot play
    expect(tlPlay(g, 'a', cs('10C'), 0)).toBe('out');
    expect(g.turn).toBe('b');
    expect(tlPlay(g, 'b', cs('QC'), 0)).toBe('end'); // one player left with cards: over
    expect(g.phase).toBe('ended');
    expect(places(g)).toEqual(['Nhất Dung', 'Nhì Ann', 'Ba Bao', 'Bét Chi']);
    expect(g.results![3].cards).toEqual(cs('AS 2S'));
    expect(g.results![3].note).toBe('Thối heo: left holding a 2.');
    expect(g.results!.slice(0, 3).every((r) => r.note === null && r.cards.length === 0)).toBe(true);
    expect(g.winner).toEqual({ id: 'd', name: 'Dung' });
    expect(g.lastWinner).toBe('d');
    // The view shows the same to anyone, and the winner leads the next hand with anything.
    expect(tlView(g, 'zed', 0).results).toEqual(g.results);
    expect(tlPlay(g, 'c', cs('AS'), 0)).toBe(false);
    expect(tlTick(g, TURN_MS * 9)).toBe(false);
    g.hands = { a: cs('3S 4D'), b: cs('5D 6D'), c: cs('7D 8D'), d: cs('9D 10D') };
    tlBegin(g, 0);
    expect(g.turn).toBe('d');
    expect(g.mustInclude).toBeNull();
    expect(g.results).toBeNull();
  }
});

test('a player who is out is skipped, and whoever beats the last play of someone out leads on normally', () => {
  const g = nam('3S KS', '4S 5S 6S', '7S 8S 9S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPlay(g, 'b', cs('4S'), 0);
  tlPlay(g, 'c', cs('7S'), 0);
  expect(tlPlay(g, 'a', cs('KS'), 0)).toBe('out');
  tlPass(g, 'b', 0);
  tlPass(g, 'c', 0);
  expect(g.turn).toBe('b'); // hưởng sái: next after Ann
  tlPlay(g, 'b', cs('5S'), 0);
  tlPlay(g, 'c', cs('8S'), 0);
  expect(g.turn).toBe('b'); // Ann is skipped
  tlPass(g, 'b', 0);
  expect(g.turn).toBe('c'); // an ordinary trick win, not hưởng sái
  expect(g.note).not.toContain('hưởng sái');
  expect(tlPlay(g, 'c', cs('9S'), 0)).toBe('end');
  expect(places(g)).toEqual(['Nhất Ann', 'Nhì Chi', 'Bét Bao']);
  expect(g.results![2].note).toBeNull(); // no 2s left, so no thối heo
});

test('hưởng sái at once: going out when everyone else has already passed hands the lead to the next player in', () => {
  const g = nam('3S 6S', '4S 7S 8S', '5S 9S 10S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPass(g, 'b', 0);
  tlPass(g, 'c', 0);
  expect(tlPlay(g, 'a', cs('6S'), 0)).toBe('out');
  tlPass(g, 'b', 0);
  tlPlay(g, 'c', cs('9S'), 0);
  expect(g.turn).toBe('c'); // Bao passed, Ann is out: Chi's own trick
  tlPlay(g, 'c', cs('5S'), 0);
  tlPlay(g, 'b', cs('7S'), 0);
  expect(tlPlay(g, 'c', cs('10S'), 0)).toBe('end');
  expect(places(g)).toEqual(['Nhất Ann', 'Nhì Chi', 'Bét Bao']);
});

test('thối heo counts the 2s the last player is left holding', () => {
  const g = nam('3S', '4S 2S 2H');
  expect(tlPlay(g, 'a', cs('3S'), 0)).toBe('end');
  expect(g.results![1].note).toBe('Thối heo: left holding 2 2s.');
  expect(g.note).toContain('Ann wins');
});

// ---- Miền Bắc: no finishing on a 2 or on four of a kind ----------------------------------------

test('bac: going out on a 2 puts you last instead of where you finished', () => {
  const g = bac('3S 2S', '4S 5S 6S 9S', '7S 8S 10S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPlay(g, 'b', cs('4S'), 0);
  tlPlay(g, 'c', cs('7S'), 0);
  expect(tlThoi('bac', g.hands.a, cs('2S'))).toBe('finished on a 2'); // what the panel warns about
  expect(tlPlay(g, 'a', cs('2S'), 0)).toBe('out');
  expect(g.note).toContain('thối');
  tlPass(g, 'b', 0);
  tlPass(g, 'c', 0);
  expect(g.turn).toBe('b');
  tlPlay(g, 'b', cs('5S'), 0);
  tlPlay(g, 'c', cs('8S'), 0);
  tlPlay(g, 'b', cs('9S'), 0);
  expect(tlPlay(g, 'c', cs('10S'), 0)).toBe('end');
  // Ann was out first but is placed last; Chi, out second, wins and leads the next hand.
  expect(places(g)).toEqual(['Nhất Chi', 'Nhì Bao', 'Bét Ann']);
  expect(g.results![2].note).toBe('Thối: finished on a 2, so placed last.');
  expect(g.results![1].cards).toEqual(cs('6S'));
  expect(g.lastWinner).toBe('c');
});

test('bac: going out on four of a kind puts you last too, even with two players', () => {
  const g = bac('3S 5S 5C 5D 5H', '4S 6S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPass(g, 'b', 0);
  expect(tlPlay(g, 'a', cs('5S 5C 5D 5H'), 0)).toBe('end');
  expect(places(g)).toEqual(['Nhất Bao', 'Bét Ann']);
  expect(g.results![1].note).toBe('Thối: finished on four of a kind, so placed last.');
  expect(g.winner?.id).toBe('b');
});

test('tlThoi: only a northern final play made of 2s or of four of a kind is penalised', () => {
  expect(tlThoi('bac', cs('2S 2C'), cs('2S 2C'))).toBe('finished on a 2');
  expect(tlThoi('bac', cs('2S 2C 2H'), cs('2S 2C 2H'))).toBe('finished on a 2');
  expect(tlThoi('bac', cs('9S 9C 9D 9H'), cs('9S 9C 9D 9H'))).toBe('finished on four of a kind');
  expect(tlThoi('bac', cs('2S 9C'), cs('2S'))).toBeNull(); // not the final play
  expect(tlThoi('bac', cs('9S 9C 9D 9H 3S'), cs('9S 9C 9D 9H'))).toBeNull();
  expect(tlThoi('bac', cs('AS'), cs('AS'))).toBeNull();
  expect(tlThoi('bac', cs('3S 4S 5S'), cs('3S 4S 5S'))).toBeNull();
  expect(tlThoi('nam', cs('2S'), cs('2S'))).toBeNull();
  expect(tlThoi('nam', cs('9S 9C 9D 9H'), cs('9S 9C 9D 9H'))).toBeNull();
});

test('bac: an idle player whose last card is a 2 is played out and placed last', () => {
  const g = bac('3S 2S', '4H 5H');
  expect(tlTick(g, TURN_MS)).toBe(true); // Ann leads her lowest
  expect(tlTick(g, TURN_MS * 2)).toBe(true); // Bao passes
  expect(tlTick(g, TURN_MS * 3)).toBe(true); // Ann leads her 2 and is out
  expect(places(g)).toEqual(['Nhất Bao', 'Bét Ann']);
});

// ---- Miền Nam: instant wins (tới trắng) --------------------------------------------------------

test('instantWin recognises each winning hand', () => {
  expect(instantWin(cs('2S 2C 2D 2H 3C 5S 6C 8D 9H JS QC KD AH'), false)).toBe('four 2s');
  expect(instantWin(cs('3S 4C 5D 6H 7S 8C 9D 10H JS QC KD AH 2S'), false)).toBe('a dragon straight, 3 to ace');
  expect(instantWin(cs('3S 4C 5D 6H 7S 8C 9D 10H JS QC KD AH AS'), false)).toBe('a dragon straight, 3 to ace');
  expect(instantWin(cs('3S 4C 5D 6H 7S 8C 9D 10H JS QC KD 2H 2S'), false)).toBeNull(); // no ace
  expect(instantWin(cs('3S 3C 5D 5H 7S 7C 9D 9H JS JC KD KH 2S'), false)).toBe('six pairs');
  expect(instantWin(cs('4S 4C 4D 4H 7S 7C 9D 9H JS JC KD KH 2S'), false)).toBe('six pairs'); // four of a kind is two pairs
  expect(instantWin(cs('3S 3C 5D 5H 7S 7C 9D 9H JS JC KD AH 2S'), false)).toBeNull(); // five pairs
  expect(instantWin(cs('4S 4C 5D 5H 6S 6C 7D 7H 8S 8C KD AH 2S'), false)).toBe('five consecutive pairs');
  expect(instantWin(cs('JS JC QD QH KS KC AD AH 2S 2C 3S 4S 5S'), false)).toBeNull(); // 2s do not extend a run
  expect(instantWin(cs('4S 4C 5D 5H 6S 6C 7D 7H 9S 9C KD AH 2S'), false)).toBeNull(); // a gap
  const threes = cs('3S 3C 3D 3H 5S 6C 8D 9H JS QC KD AH 2S');
  expect(instantWin(threes, true)).toBe('four 3s');
  expect(instantWin(threes, false)).toBeNull(); // only in the first hand of a session
  expect(instantWin(cs('3S 3C 3D 5H 5S 6C 8D 9H JS QC KD AH 2S'), true)).toBeNull();
});

const FOUR_TWOS = '3S 2S 2C 2D 2H 4S 5S 6S 7S 8S 9S 10S JS';
const SIX_PAIRS = '3C 3D 5D 5H 7C 7D 9D 9H JC JD KD KH AS';
const FOUR_THREES = '3S 3C 3D 3H 5S 6C 8D 9H JS QC KD AH 2S';
const PLAIN = '4S 4C 5C 6D 7S 8C 9D 10H JC QD KS AS 2C';

test('nam: an instant win ends the hand right after the deal, with that player first and every hand shown', () => {
  const g = nam(PLAIN, FOUR_THREES, '4D 5D 6H 7H 8H 10D JD QH KC AC 2D 9C 10C');
  expect(g.phase).toBe('ended');
  expect(g.winner).toEqual({ id: 'b', name: 'Bao' });
  expect(g.lastWinner).toBe('b');
  expect(g.note).toContain('tới trắng');
  expect(g.results!.map((r) => [r.id, r.place, r.cards.length])).toEqual([['b', 'Nhất', 13], ['a', '', 13], ['c', '', 13]]);
  expect(g.results![0].note).toBe('Tới trắng: four 3s.');
  expect(g.turn).toBeNull();
  expect(g.table).toBeNull();
  expect(tlView(g, 'a', 0).hand).toBeNull();
  expect(tlPlay(g, 'b', cs('3S'), 0)).toBe(false);
  expect(tlTick(g, TURN_MS * 3)).toBe(false);
  expect(tlDeal(g, 'a', 0, seeded(7))).toBe(true); // anyone can deal again
});

test('nam: four 3s only wins in the first hand of a session', () => {
  const g = seat('nam', [PLAIN, FOUR_THREES], 'a');
  expect(g.phase).toBe('play');
  expect(g.turn).toBe('a');
});

test('nam: if two players hold an instant win, the earlier in turn order takes it', () => {
  // First hand: Bao holds the 3 of spades, so the order starts with him.
  let g = nam(SIX_PAIRS, FOUR_TWOS);
  expect(g.results![0]).toMatchObject({ id: 'b', note: 'Tới trắng: four 2s.' });
  // Later hand led by Ann: she comes first.
  g = seat('nam', [SIX_PAIRS, FOUR_TWOS], 'a');
  expect(g.results![0]).toMatchObject({ id: 'a', note: 'Tới trắng: six pairs.' });
  // Three players, led by Chi: Chi has nothing, Ann is next round the table.
  g = seat('nam', [SIX_PAIRS, FOUR_TWOS, '4D 4H 6D 6H 8D 10D QD QH AD 3H 5C 6C 8C'], 'c');
  expect(g.results![0].id).toBe('a');
});

test('bac: there are no instant wins', () => {
  const g = bac(SIX_PAIRS, FOUR_TWOS);
  expect(g.phase).toBe('play');
  expect(g.turn).toBe('b');
  expect(bac(PLAIN, FOUR_THREES).phase).toBe('play');
});

// ---- time-outs ---------------------------------------------------------------------------------

test('time-out: a player who could pass passes', () => {
  const g = nam('3S 9S', '4S 6S', '7S 8S');
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
  const g = nam('5S 5C 9S', '4S 6S', '7S 8S');
  // Bao holds the lowest card dealt and idles on the opening lead.
  expect(g.turn).toBe('b');
  expect(tlTick(g, TURN_MS)).toBe(true);
  expect(g.table).toEqual({ by: 'b', name: 'Bao', cards: cs('4S') });
  expect(g.turn).toBe('c');
  // Everyone idles: two passes, then Bao leads again and his last card goes.
  expect(tlTick(g, TURN_MS * 2)).toBe(true);
  expect(tlTick(g, TURN_MS * 3)).toBe(true);
  expect(g.turn).toBe('b');
  expect(g.table).toBeNull();
  expect(tlTick(g, TURN_MS * 4)).toBe(true);
  expect(g.out.map((o) => o.id)).toEqual(['b']);
  expect(g.phase).toBe('play'); // the other two play on for second place
  expect(g.turn).toBe('c');
  let now = TURN_MS * 4;
  for (let i = 0; i < 50 && g.phase === 'play'; i++) expect(tlTick(g, (now += TURN_MS))).toBe(true);
  expect(places(g)).toEqual(['Nhất Bao', 'Nhì Chi', 'Bét Ann']);
});

test('an abandoned table always finishes: idle players alone play a full deal out, in both versions', () => {
  for (const v of ['nam', 'bac'] as const) {
    const g = newTienlen();
    for (const p of people) tlJoin(g, p);
    tlVariant(g, 'a', v);
    tlDeal(g, 'a', 0, seeded(3));
    expect(g.phase).toBe('play');
    let now = 0;
    for (let i = 0; i < 600 && g.phase === 'play'; i++) expect(tlTick(g, (now += TURN_MS))).toBe(true);
    expect(g.phase).toBe('ended');
    expect(g.results).toHaveLength(4);
    expect(g.results!.filter((r) => r.cards.length)).toHaveLength(1); // exactly one player left holding cards
  }
});

test('the view counts down the time left in the turn', () => {
  const g = nam('3S 9S', '4S 6S');
  expect(tlView(g, 'a', 4000).left).toBe(TURN_MS - 4000);
  expect(tlView(g, 'a', TURN_MS * 3).left).toBe(0);
});

// ---- leaving -----------------------------------------------------------------------------------

test('a player who leaves on their turn is removed and the turn moves on', () => {
  const g = nam('3S 9S', '4S 6S', '7S 8S', '10S JS');
  tlPlay(g, 'a', cs('3S'), 0);
  expect(tlLeave(g, 'b', 50)).toBe(true);
  expect(g.players.map((p) => p.id)).toEqual(['a', 'c', 'd']);
  expect(g.hands.b).toBeUndefined();
  expect(g.turn).toBe('c');
  expect(g.until).toBe(50 + TURN_MS);
  expect(tlLeave(g, 'b', 60)).toBe(false);
});

test('a player who leaves out of turn does not disturb the turn', () => {
  const g = nam('3S 9S', '4S 6S', '7S 8S', '10S JS');
  tlPlay(g, 'a', cs('3S'), 0);
  tlLeave(g, 'd', 0);
  expect(g.turn).toBe('b');
  tlPlay(g, 'b', cs('4S'), 0);
  tlPlay(g, 'c', cs('7S'), 0);
  expect(g.turn).toBe('a');
});

test('if the player who owns the table leaves, the trick still ends once the rest have passed', () => {
  const g = nam('3S 9S', '4S 6S', '7S 8S', '10S JS');
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
  const g = nam('3S 9S', '4S 6S', '7S 8S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPass(g, 'b', 0);
  tlLeave(g, 'a', 0);
  expect(tlPlay(g, 'c', cs('7S'), 0)).toBe('play');
  expect(g.turn).toBe('c');
  expect(g.table).toBeNull();
});

test('if the opener leaves before playing, the lowest card still at the table opens', () => {
  const g = nam('3S 9S', '4S 6S', '5S 8S');
  expect(g.turn).toBe('a');
  tlLeave(g, 'a', 0);
  expect(g.turn).toBe('b');
  expect(g.mustInclude).toBe(cs('4S')[0]);
  expect(tlPlay(g, 'b', cs('6S'), 0)).toBe(false);
  expect(tlPlay(g, 'b', cs('4S'), 0)).toBe('play');
  // In the north the new opener leads, with anything.
  const n = bac('3S 9S', '5S 6S', '4S 8S');
  tlLeave(n, 'a', 0);
  expect(n.turn).toBe('c');
  expect(n.mustInclude).toBeNull();
  expect(tlPlay(n, 'c', cs('8S'), 0)).toBe('play');
});

test('with one player left holding cards the hand ends and they win it', () => {
  const g = nam('3S 9S', '4S 6S', '7S 8S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlLeave(g, 'b', 0);
  expect(g.phase).toBe('play');
  tlLeave(g, 'c', 0);
  expect(g.phase).toBe('ended');
  expect(g.winner).toEqual({ id: 'a', name: 'Ann' });
  expect(places(g)).toEqual(['Nhất Ann']);
  expect(g.note).toContain('Chi left');
  expect(g.turn).toBeNull();
  expect(tlTick(g, TURN_MS * 5)).toBe(false);
  expect(tlDeal(g, 'a', 0)).toBe(false); // needs a second player again
  tlLeave(g, 'a', 0);
  expect(g).toEqual(newTienlen()); // an empty table starts a new session
});

test('someone who had gone out keeps their place if they then leave, and a quitter with cards is not ranked', () => {
  const g = nam('3S', '4S 6S', '7S 8S', '9S 10S');
  expect(tlPlay(g, 'a', cs('3S'), 0)).toBe('out');
  tlLeave(g, 'a', 0);
  expect(g.phase).toBe('play');
  expect(g.turn).toBe('b');
  tlPlay(g, 'b', cs('4S'), 0);
  tlLeave(g, 'd', 0); // still held cards
  tlPlay(g, 'c', cs('7S'), 0);
  tlPass(g, 'b', 0);
  expect(tlPlay(g, 'c', cs('8S'), 0)).toBe('end');
  expect(places(g)).toEqual(['Nhất Ann', 'Nhì Chi', 'Bét Bao']);
  // The winner has gone, so the next hand opens with the lowest card again.
  expect(tlDeal(g, 'b', 0, seeded(11))).toBe(true);
  expect(g.phase).toBe('play');
  expect(g.mustInclude).not.toBeNull();
  expect(g.hands[g.turn!]).toContain(g.mustInclude);
});

test('a leaver who leaves one player with cards ends the hand behind those already out', () => {
  const g = nam('3S', '4S 6S', '7S 8S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlLeave(g, 'b', 0);
  expect(g.phase).toBe('ended');
  expect(places(g)).toEqual(['Nhất Ann', 'Bét Chi']);
});

// ---- what the browser may know -----------------------------------------------------------------

test('no view contains another player’s hand, in either version', () => {
  for (const variant of ['nam', 'bac'] as const) {
    const g = seat(variant, ['3S 5S 5C 9S', '4S 6S 6C 8D', '7S 7C 10S JD', 'QS KS AS 2S']);
    tlPlay(g, 'a', cs('3S'), 0);
    tlPass(g, 'b', 0);
    const shown = cs('3S'); // the only card anyone has seen
    for (const viewer of ['a', 'b', 'c', 'd', 'zed', null]) {
      const v = tlView(g, viewer, 0);
      const mine = viewer && g.hands[viewer] ? g.hands[viewer] : null;
      expect(v.hand).toEqual(mine);
      expect(v.results).toBeNull();
      expect(v.players.map((p) => p.count)).toEqual([3, 4, 4, 4]);
      expect(v.players.every((p) => Object.keys(p).sort().join() === 'count,id,name,out,passed')).toBe(true);
      // Apart from the card counts and the clock, the only numbers in the view are the viewer's cards and the table's.
      const nums: number[] = [];
      JSON.stringify({ ...v, left: undefined, players: [] }, (_k, x) => (typeof x === 'number' ? (nums.push(x), x) : x));
      expect(nums.sort((x, y) => x - y)).toEqual([...shown, ...(mine ?? [])].sort((x, y) => x - y));
    }
  }
});

test('leftover cards are only revealed once the hand is over', () => {
  const g = nam('3S KS', '4S 5S 6S', '7S 8S 9S');
  tlPlay(g, 'a', cs('3S'), 0);
  tlPlay(g, 'b', cs('4S'), 0);
  tlPlay(g, 'c', cs('7S'), 0);
  tlPlay(g, 'a', cs('KS'), 0); // Ann is out, the hand goes on
  const v = tlView(g, 'a', 0);
  expect(v.results).toBeNull();
  expect(v.hand).toEqual([]);
  expect(JSON.stringify(v)).not.toContain(JSON.stringify(g.hands.b));
});

// ---- the server --------------------------------------------------------------------------------

test('the server never broadcasts, sends each person only their own hand, and announces the winner once', () => {
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
  const last = () => Object.fromEntries(room.map((p) => [p.id, sent.filter((m) => m.to === p.id).at(-1)!.view]));
  for (const p of room.slice(0, 4)) s.onAction(p, { k: 'join' }, 0);
  s.onAction(room[4], { k: 'deal' }, 0); // a watcher cannot deal
  expect(sent.every((m) => m.view.phase === 'lobby')).toBe(true);
  // Version: the watcher cannot switch it, a seated player can, and everyone is told. (Northern also keeps
  // this test free of the rare southern instant win.)
  let count = sent.length;
  s.onAction(room[4], { k: 'variant', v: 'bac' }, 0);
  s.onAction(room[0], { k: 'variant', v: 'east' }, 0);
  s.onAction(room[0], { k: 'variant' }, 0);
  expect(sent.length).toBe(count);
  s.onAction(room[1], { k: 'variant', v: 'bac' }, 0);
  expect(last().w.variant).toBe('bac');

  s.onAction(room[0], { k: 'deal' }, 0);
  let v = last();
  const hands = people.map((p) => v[p.id].hand!);
  expect(new Set(hands.flat()).size).toBe(52);
  expect(v.w.hand).toBeNull();
  // Every message ever sent carries at most the receiver's own hand.
  for (const m of sent) if (m.view.hand) expect(m.view.hand).toEqual(v[m.to].hand);

  // Hostile actions change nothing.
  count = sent.length;
  const opener = room.find((p) => p.id === v.a.turn)!;
  const other = room.find((p) => p.id !== opener.id && p.id !== 'w')!;
  s.onAction(other, { k: 'play', cards: [v[other.id].hand![0]] }, 1); // out of turn
  s.onAction(opener, { k: 'play', cards: [v[other.id].hand![0]] }, 1); // someone else's card
  s.onAction(opener, { k: 'play', cards: 'all of them' }, 1);
  s.onAction(opener, { k: 'play' }, 1);
  s.onAction(opener, { k: 'pass' }, 1);
  s.onAction(room[4], { k: 'pass' }, 1);
  s.onAction(opener, { k: 'variant', v: 'nam' }, 1); // not during a hand
  s.onAction(opener, { k: 'nonsense' }, 1);
  expect(sent.length).toBe(count);

  s.onAction(opener, { k: 'play', cards: [0] }, 1);
  v = last();
  expect(v.w.table?.cards).toEqual([0]);
  expect(v.w.variant).toBe('bac');
  expect(v[opener.id].hand).toHaveLength(12);

  // A latecomer gets the public view only.
  sent.length = 0;
  s.onJoin!({ ...room[4], id: 'late' }, 2);
  expect(sent).toHaveLength(1);
  expect(sent[0].view.hand).toBeNull();

  // Let the clock play the hand out, through all four places: it ends, and the room is told once.
  let now = 2;
  for (let i = 0; i < 600 && notices.length === 0; i++) s.tick!((now += 30_000));
  for (let i = 0; i < 5; i++) s.tick!((now += 30_000));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('won the hand of Tiến lên Miền Bắc');
  const results = last().w.results!;
  expect(results).toHaveLength(4);
  expect(notices[0]).toContain(results[0].name);
  expect(broadcasts).toBe(0);
});

// Found by tests/sim/tienlen.sim.test.ts: the winner can go out first, leave the room, and only then does the hand end.
test('regression: the server does not put a trophy over a winner who has already left the room', () => {
  const room = people.slice(0, 3).map((p) => ({ ...p, color: '', look: '', x: 0, z: 0, ry: 0, seat: null }) as PlayerInfo);
  const views = new Map<string, ReturnType<typeof tlView>>();
  const notices: string[] = [];
  const emotes: { id: string; k: string; here: boolean }[] = [];
  const io: GameIO = {
    players: () => room,
    send: (to, view) => views.set(to, view as ReturnType<typeof tlView>),
    broadcast: () => {},
    notice: (t) => notices.push(t),
    emote: (id, k) => emotes.push({ id, k, here: room.some((p) => p.id === id) }),
    put: () => {},
    nudge: () => {},
    resetBall: () => {},
    setScore: () => {},
  };
  // A fixed shuffle, so the same hand is played every time (and it is not an instant win).
  const spy = vi.spyOn(Math, 'random').mockImplementation(seeded(11));
  try {
    const s = create(io);
    for (const p of room) s.onAction(p, { k: 'join' }, 0);
    s.onAction(room[0], { k: 'deal' }, 0);
    expect(views.get('a')!.phase).toBe('play');
    // The clock plays until someone is out of cards; they walk out of the room while the other two play on.
    let now = 0;
    const first = () => views.get(room[0].id)!.players.find((p) => p.out);
    for (let i = 0; i < 600 && !first(); i++) s.tick!((now += 30_000));
    const gone = first()!;
    expect(views.get(room[0].id)!.phase).toBe('play');
    room.splice(room.findIndex((p) => p.id === gone.id), 1);
    s.onLeave(gone.id, now);
    for (let i = 0; i < 600 && !notices.length; i++) s.tick!((now += 30_000));
    expect(notices).toEqual([`${gone.name} won the hand of Tiến lên Miền Nam`]);
    expect(views.get(room[0].id)!.results![0].id).toBe(gone.id);
    expect(emotes.filter((e) => !e.here)).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});
