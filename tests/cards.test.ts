// Last Card: the rules, and skipping a player who has wandered off.
import { expect, test } from 'vitest';
import {
  SKIP_AFTER_MS,
  canPlay,
  cardsSkipIn,
  currentPlayer,
  drawCard,
  playCard,
  removePlayer,
  skipTurn,
  startCards,
  topCard,
  type Card,
  type CardsGame,
  type Suit,
} from '../shared/cards';

const T0 = 5_000_000;
const everyone = ['ann', 'bao', 'chi'];

/** A game with known hands and a known pile, so each test reads like a hand of cards. */
function table(hands: Record<string, string>, top: Card, pile = '3C 4C 5C 6C 7C 9C TC', now = T0): CardsGame {
  const order = Object.keys(hands);
  return {
    phase: 'play',
    order,
    names: Object.fromEntries(order.map((id) => [id, id[0].toUpperCase() + id.slice(1)])),
    hands: Object.fromEntries(order.map((id) => [id, hands[id].split(' ')])),
    drawPile: pile ? pile.split(' ') : [],
    discard: [top],
    suit: top[1] as Suit,
    turn: 0,
    dir: 1,
    pending: 0,
    winner: null,
    turnSince: now,
  };
}
const count = (g: CardsGame) => g.drawPile.length + g.discard.length + Object.values(g.hands).flat().length;

test('a new game deals seven cards each from one full deck and opens on a plain card', () => {
  const g = startCards(everyone.map((id) => ({ id, name: id })), T0);
  expect(g.order.slice().sort()).toEqual(everyone);
  for (const id of everyone) expect(g.hands[id].length).toBe(7);
  const all = [...g.drawPile, ...g.discard, ...Object.values(g.hands).flat()];
  expect(all.length).toBe(52);
  expect(new Set(all).size).toBe(52);
  expect('28JA').not.toContain(topCard(g)[0]);
  expect(g.turnSince).toBe(T0);
  // Six or more players use two decks and five cards each.
  const big = startCards('abcdef'.split('').map((id) => ({ id, name: id })), T0);
  expect(count(big)).toBe(104);
  expect(big.hands.a.length).toBe(5);
});

test('follow suit or rank; an 8 is wild and names the suit', () => {
  const g = table({ ann: '5H KS 8D 9D', bao: 'QC 2C' }, 'KH');
  expect(canPlay(g, '5H') && canPlay(g, 'KS') && canPlay(g, '8D') && !canPlay(g, '9D')).toBe(true);
  expect(playCard(g, 'bao', 'QC', undefined, T0)).toBe(false); // not her turn
  expect(playCard(g, 'ann', '9D', undefined, T0)).toBe(false); // does not match
  expect(playCard(g, 'ann', 'AS', undefined, T0)).toBe(false); // not in her hand
  expect(playCard(g, 'ann', '8D', 'C', T0)).toBe(true);
  expect(g.suit).toBe('C');
  expect(currentPlayer(g)).toBe('bao');
  expect(playCard(g, 'bao', 'QC', undefined, T0)).toBe(true);
});

test('a 2 makes the next player draw two, or pass it on with another 2', () => {
  const g = table({ ann: '2H 5S', bao: '2S 9D KD', chi: 'QC 4D' }, 'KH');
  playCard(g, 'ann', '2H', undefined, T0);
  expect(g.pending).toBe(2);
  expect(playCard(g, 'bao', 'KD', undefined, T0)).toBe(false); // only a 2 will do
  expect(playCard(g, 'bao', '2S', undefined, T0)).toBe(true);
  expect(g.pending).toBe(4);
  expect(drawCard(g, 'chi', T0)).toBe(true);
  expect(g.hands.chi.length).toBe(6);
  expect(g.pending).toBe(0);
  expect(currentPlayer(g)).toBe('ann');
});

test('a Jack skips the next player; an Ace reverses, and with two players comes straight back', () => {
  const g = table({ ann: 'JH 5S AS', bao: '9D KD', chi: 'QC 4D' }, 'KH');
  playCard(g, 'ann', 'JH', undefined, T0);
  expect(currentPlayer(g)).toBe('chi');
  const h = table({ ann: 'AH 5S', bao: '9D KD', chi: 'QC 4D' }, 'KH');
  playCard(h, 'ann', 'AH', undefined, T0);
  expect(h.dir).toBe(-1);
  expect(currentPlayer(h)).toBe('chi');
  const two = table({ ann: 'AH 5H 3S', bao: '9D KD' }, 'KH');
  playCard(two, 'ann', 'AH', undefined, T0);
  expect(currentPlayer(two)).toBe('ann');
});

test('the last card wins, and nothing more can be done', () => {
  const g = table({ ann: '5H', bao: '9D KD' }, 'KH');
  expect(playCard(g, 'ann', '5H', undefined, T0)).toBe(true);
  expect(g.phase).toBe('over');
  expect(g.winner).toBe('ann');
  expect(drawCard(g, 'bao', T0)).toBe(false);
  expect(playCard(g, 'bao', '9D', undefined, T0)).toBe(false);
});

test('an empty draw pile is refilled from under the top card', () => {
  const g = table({ ann: '9D', bao: 'KD' }, 'KH', '');
  g.discard = ['3C', '4C', '5C', 'KH'];
  expect(drawCard(g, 'ann', T0)).toBe(true);
  expect(g.hands.ann.length).toBe(2);
  expect(g.discard).toEqual(['KH']);
  expect(g.drawPile.length).toBe(2);
  expect(count(g)).toBe(6);
});

test('someone leaving: their cards go under the pile and the turn carries on in the same direction', () => {
  const g = table({ ann: '5H 6H', bao: '9D KD', chi: 'QC 4D', dung: '7S 8S' }, 'KH');
  const before = count(g);
  g.turn = 1;
  expect(removePlayer(g, 'ann', T0 + 5)).toBe(true); // someone before the player to act
  expect(currentPlayer(g)).toBe('bao');
  expect(g.turnSince).toBe(T0); // Bao's wait is not restarted
  expect(topCard(g)).toBe('KH');
  expect(count(g)).toBe(before);
  g.dir = -1;
  expect(removePlayer(g, 'bao', T0 + 9)).toBe(true); // the player to act, going backwards
  expect(currentPlayer(g)).toBe('dung');
  expect(g.turnSince).toBe(T0 + 9);
  expect(removePlayer(g, 'chi', T0 + 10)).toBe(false); // one player left: the game cannot go on
  expect(count(g)).toBe(before);
});

// ------------------------------------------------------------ skipping a player who has wandered off

test('skip: refused until the turn has lasted 40 seconds, then the absent player draws one and the turn passes', () => {
  const g = table({ ann: '5H 6D', bao: '9D KD', chi: 'QC 4D' }, 'KH');
  expect(SKIP_AFTER_MS).toBe(40_000);
  expect(cardsSkipIn(g, T0)).toBe(40_000);
  expect(cardsSkipIn(g, T0 + 15_000)).toBe(25_000);
  expect(skipTurn(g, 'bao', T0, everyone)).toBe(false);
  expect(skipTurn(g, 'bao', T0 + 39_999, everyone)).toBe(false);
  expect(g.hands.ann.length).toBe(2);
  expect(cardsSkipIn(g, T0 + 40_000)).toBe(0);
  expect(skipTurn(g, 'bao', T0 + 40_000, everyone)).toBe(true);
  // Ann drew a card and is still in the game; it is Bao's turn and the wait starts again.
  expect(g.hands.ann.length).toBe(3);
  expect(g.order).toEqual(everyone);
  expect(currentPlayer(g)).toBe('bao');
  expect(g.turnSince).toBe(T0 + 40_000);
  expect(cardsSkipIn(g, T0 + 41_000)).toBe(39_000);
  expect(skipTurn(g, 'chi', T0 + 41_000, everyone)).toBe(false);
  expect(count(g)).toBe(14);
});

test('skip: an absent player who owes cards for 2s takes them all', () => {
  const g = table({ ann: '2H 5S', bao: '2S 9D', chi: 'QC 4D' }, 'KH');
  playCard(g, 'ann', '2H', undefined, T0 + 1000);
  playCard(g, 'bao', '2S', undefined, T0 + 2000);
  expect(g.pending).toBe(4);
  expect(skipTurn(g, 'ann', T0 + 41_999, everyone)).toBe(false);
  expect(skipTurn(g, 'ann', T0 + 42_000, everyone)).toBe(true);
  expect(g.hands.chi.length).toBe(6);
  expect(g.pending).toBe(0);
  expect(currentPlayer(g)).toBe('ann');
});

test("skip: refused from the player themself, from someone not at the table, and when it is nobody's turn", () => {
  const g = table({ ann: '5H', bao: '9D KD', chi: 'QC 4D' }, 'KH');
  const late = T0 + 10 * SKIP_AFTER_MS;
  const before = JSON.stringify(g);
  expect(skipTurn(g, 'ann', late, everyone)).toBe(false); // it is Ann's own turn
  expect(skipTurn(g, 'dung', late, everyone)).toBe(false); // not sitting here
  expect(skipTurn(g, 'bao', late, ['ann', 'chi'])).toBe(false); // has stood up
  expect(skipTurn(g, 'bao', NaN, everyone)).toBe(false);
  expect(JSON.stringify(g)).toBe(before);
  // Someone who sat down mid-game and is waiting for the next one may skip.
  const waiting = table({ ann: '5H', bao: '9D KD' }, 'KH');
  expect(skipTurn(waiting, 'dung', late, ['ann', 'bao', 'dung'])).toBe(true);
  // Once somebody has won it is nobody's turn.
  playCard(g, 'ann', '5H', undefined, late);
  expect(g.phase).toBe('over');
  expect(cardsSkipIn(g, late * 2)).toBe(0);
  expect(skipTurn(g, 'bao', late * 2, everyone)).toBe(false);
});

test('skip: every play and draw restarts the wait', () => {
  const g = table({ ann: '5H 6D', bao: '9H KD', chi: 'QC 4D' }, 'KH');
  playCard(g, 'ann', '5H', undefined, T0 + 30_000);
  expect(g.turnSince).toBe(T0 + 30_000);
  expect(skipTurn(g, 'ann', T0 + 60_000, everyone)).toBe(false);
  drawCard(g, 'bao', T0 + 60_000);
  expect(g.turnSince).toBe(T0 + 60_000);
  expect(cardsSkipIn(g, T0 + 70_000)).toBe(30_000);
});
