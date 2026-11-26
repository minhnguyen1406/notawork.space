// Hand ranking, betting flow and side pots.
import { expect, test } from 'vitest';
import { SKIP_AFTER_MS } from '../shared/cards';
import {
  BIG_BLIND,
  compareScores,
  newPoker,
  pokerAct as act,
  pokerLeave as leave,
  pokerSkip,
  pokerSkipIn,
  pokerStart as start,
  potOf,
  raiseRange,
  scoreHand,
  type PokerAction,
  type PokerGame,
} from '../shared/poker';

// The older checks below do not care about time: they all happen at the same instant.
const pokerStart = (g: PokerGame, who: { id: string; name: string }[]) => start(g, who, 0);
const pokerAct = (g: PokerGame, pid: string, a: PokerAction) => act(g, pid, a, 0);
const pokerLeave = (g: PokerGame, pid: string) => leave(g, pid, 0);

// Each check becomes its own named test.
const check = (label: string, ok: boolean) => test(label, () => expect(ok).toBe(true));
const cat = (s: string) => scoreHand(s.split(' '))[0];
const beats = (a: string, b: string) => compareScores(scoreHand(a.split(' ')), scoreHand(b.split(' '))) > 0;

check('straight flush', cat('9H TH JH QH KH 2C 3D') === 8);
check('wheel straight flush', cat('AH 2H 3H 4H 5H KC KD') === 8 && scoreHand('AH 2H 3H 4H 5H KC KD'.split(' '))[1] === 5);
check('four of a kind', cat('9H 9S 9D 9C KH 2C 3D') === 7);
check('full house', cat('9H 9S 9D KC KH 2C 3D') === 6);
check('full house from two sets of trips', cat('9H 9S 9D KC KH KD 3D') === 6 && scoreHand('9H 9S 9D KC KH KD 3D'.split(' '))[1] === 13);
check('flush', cat('2H 7H JH QH KH 2C 3D') === 5);
check('straight', cat('5H 6S 7D 8C 9H 2C KD') === 4);
check('wheel straight is five-high', scoreHand('AH 2S 3D 4C 5H 9C KD'.split(' '))[1] === 5);
check('three of a kind', cat('9H 9S 9D 4C KH 2C 3D') === 3);
check('two pair', cat('9H 9S 4D 4C KH 2C 3D') === 2);
check('pair', cat('9H 9S 5D 4C KH 2C 3D') === 1);
check('high card', cat('9H 7S 5D 4C KH 2C 3D') === 0);
check('six-card straight uses the top', scoreHand('5H 6S 7D 8C 9H TC KD'.split(' '))[1] === 10);
check('flush beats straight', beats('2H 7H JH QH KH 2C 3D', '5H 6S 7D 8C 9H 2C KD'));
check('kicker decides equal pairs', beats('9H 9S AD 4C 7H 2C 3D', '9D 9C KD 4C 7H 2C 3D'));
check('higher two pair wins', beats('KH KS 4D 4C 7H 2C 3D', 'QH QS JD JC 7H 2C 3D'));
check('identical boards tie', compareScores(scoreHand('2H 3S AD KC QH JC TD'.split(' ')), scoreHand('4H 5S AD KC QH JC TD'.split(' '))) === 0);

const players = (n: number) => 'Ann Bao Chi Dung'.split(' ').slice(0, n).map((name) => ({ id: name.toLowerCase(), name }));
const total = (g: PokerGame) => g.seats.reduce((s, p) => s + p.chips, 0) + (g.phase === 'showdown' ? 0 : potOf(g));
const cur = (g: PokerGame) => g.seats[g.turn].id;

// Everyone folds to the big blind
{
  const g = newPoker();
  check('cannot start alone', !pokerStart(g, players(1)));
  pokerStart(g, players(3));
  check('three-handed: dealer, blinds and first to act', g.dealer === 0 && g.seats[1].bet === 10 && g.seats[2].bet === 20 && cur(g) === 'ann');
  check('out-of-turn action refused', !pokerAct(g, 'bao', { k: 'fold' }));
  check('raise below the minimum refused', !pokerAct(g, 'ann', { k: 'raise', to: 30 }));
  pokerAct(g, 'ann', { k: 'fold' });
  pokerAct(g, 'bao', { k: 'fold' });
  check('last player standing takes the blinds unseen', g.phase === 'showdown' && !g.shown && g.seats[2].chips === 1010 && g.results[0] === 'Chi wins 30');
  check('chips are conserved', total(g) === 3000);
  pokerStart(g, players(3));
  check('button moves on next hand', g.dealer === 1);
}

// Check-down to showdown, with the big blind getting an option
{
  const g = newPoker();
  pokerStart(g, players(3));
  pokerAct(g, 'ann', { k: 'call' });
  pokerAct(g, 'bao', { k: 'call' });
  check('big blind gets the option before the flop', g.phase === 'preflop' && cur(g) === 'chi');
  pokerAct(g, 'chi', { k: 'call' });
  check('flop dealt, first to act is left of the dealer', g.phase === 'flop' && g.board.length === 3 && cur(g) === 'bao');
  for (let i = 0; i < 9 && g.phase !== 'showdown'; i++) pokerAct(g, cur(g), { k: 'call' });
  check('checks run it to a showdown with five cards', g.phase === 'showdown' && g.shown && g.board.length === 5 && g.results.length >= 1);
  check('chips are conserved at showdown', total(g) === 3000);
}

// Raise and re-raise rules
{
  const g = newPoker();
  pokerStart(g, players(3));
  check('legal raise accepted', pokerAct(g, 'ann', { k: 'raise', to: 60 }) && g.currentBet === 60 && g.minRaise === 40);
  check('re-raise must be at least the last raise', !pokerAct(g, 'bao', { k: 'raise', to: 80 }) && pokerAct(g, 'bao', { k: 'raise', to: 100 }));
  check('cannot raise more than you have', !pokerAct(g, 'chi', { k: 'raise', to: 5000 }));
  pokerAct(g, 'chi', { k: 'fold' });
  check('the raiser must respond to the re-raise', cur(g) === 'ann');
  pokerAct(g, 'ann', { k: 'call' });
  check('betting closes when everyone has matched', g.phase === 'flop');
}

// Heads-up order
{
  const g = newPoker();
  pokerStart(g, players(2));
  check('heads-up: dealer posts the small blind and acts first', g.seats[g.dealer].bet === 10 && g.turn === g.dealer);
  pokerAct(g, cur(g), { k: 'call' });
  pokerAct(g, cur(g), { k: 'call' });
  check('heads-up: the other player acts first after the flop', g.phase === 'flop' && g.turn !== g.dealer);
}

// Side pots with a short all-in, using fixed cards
{
  const g = newPoker();
  g.bank = { ann: 100, bao: 1000, chi: 1000 };
  pokerStart(g, players(3));
  // Ann (short) holds the best hand, Bao second, Chi worst.
  g.seats[0].hole = ['AS', 'AH'];
  g.seats[1].hole = ['KS', 'KH'];
  g.seats[2].hole = ['QS', 'QH'];
  g.deck = ['2C', '7D', '9H', '3S', '4C', ...g.deck.filter((c) => !['2C', '7D', '9H', '3S', '4C'].includes(c))];
  pokerAct(g, 'ann', { k: 'raise', to: 100 }); // all in
  pokerAct(g, 'bao', { k: 'raise', to: 300 });
  pokerAct(g, 'chi', { k: 'call' });
  check('all-in player is skipped; the others keep betting', g.phase === 'flop' && g.seats[0].allIn);
  while (g.phase !== 'showdown') pokerAct(g, cur(g), { k: 'call' });
  // Main pot 300 to Ann; side pot 400 to Bao.
  check(`main pot to the short stack, side pot to second best (${g.seats.map((s) => s.chips)})`, g.seats[0].chips === 300 && g.seats[1].chips === 1100 && g.seats[2].chips === 700);
  check('chips conserved with side pots', total(g) === 2100);
}

// Uncalled part of a bet comes back
{
  const g = newPoker();
  g.bank = { ann: 1000, bao: 200 };
  pokerStart(g, players(2));
  const big = g.seats.find((s) => s.id === 'ann')!;
  const small = g.seats.find((s) => s.id === 'bao')!;
  big.hole = ['2S', '3H'];
  small.hole = ['AS', 'AH'];
  g.deck = ['KC', '7D', '9H', 'JS', '4C', ...g.deck.filter((c) => !['KC', '7D', '9H', 'JS', '4C'].includes(c))];
  while (g.phase !== 'showdown') {
    const id = cur(g);
    if (id === 'ann' && !pokerAct(g, 'ann', { k: 'raise', to: 600 })) pokerAct(g, 'ann', { k: 'call' });
    else if (id === 'bao') pokerAct(g, 'bao', { k: 'call' });
  }
  check(`over-bet is refunded, both all-in runs to showdown (${big.chips}, ${small.chips})`, small.chips === 400 && big.chips === 800 && g.board.length === 5);
}

// Leaving mid-hand
{
  const g = newPoker();
  pokerStart(g, players(3));
  pokerLeave(g, 'ann'); // it was Ann's turn
  check('leaving on your turn folds you and passes the turn', g.seats[0].folded && cur(g) === 'bao');
  pokerLeave(g, 'chi');
  check('leaving down to one player ends the hand', g.phase === 'showdown' && g.results[0].startsWith('Bao wins'));
  check('chips conserved when players leave', total(g) === 3000);
  check('min raise constant', BIG_BLIND === 20);
}


test('chips are never created or lost, whatever people do (random play with folds and walk-outs)', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let hand = 0; hand < 3000; hand++) {
    const g = newPoker();
    const who = players(2 + Math.floor(rnd() * 3));
    // Uneven stacks so that side pots happen.
    for (const p of who) g.bank[p.id] = [60, 200, 1000, 1500][Math.floor(rnd() * 4)];
    pokerStart(g, who);
    const before = total(g);
    for (let step = 0; step < 200 && g.phase !== 'showdown'; step++) {
      const roll = rnd();
      if (roll < 0.06) {
        pokerLeave(g, who[Math.floor(rnd() * who.length)].id);
        continue;
      }
      const s = g.seats[g.turn];
      if (roll < 0.3) pokerAct(g, s.id, { k: 'fold' });
      else if (roll < 0.75 || !pokerAct(g, s.id, { k: 'raise', to: Math.min(s.bet + s.chips, g.currentBet + g.minRaise * (1 + Math.floor(rnd() * 5))) }))
        pokerAct(g, s.id, { k: 'call' });
    }
    expect(g.phase).toBe('showdown');
    expect(total(g)).toBe(before);
  }
});

test("a bet left behind by someone who walks out still goes to the winners", () => {
  const g = newPoker();
  const who = players(4); // Ann and Dung are deep, Bao and Chi are short
  Object.assign(g.bank, { ann: 1000, bao: 60, chi: 60, dung: 1000 });
  pokerStart(g, who);
  const before = total(g);
  // Before the flop everyone gets 60 in, which puts Bao and Chi all-in.
  for (let i = 0; i < 20 && g.phase === 'preflop'; i++) {
    const s = g.seats[g.turn];
    if (g.currentBet < 60) pokerAct(g, s.id, { k: 'raise', to: 60 });
    else pokerAct(g, s.id, { k: 'call' });
  }
  expect(g.phase).toBe('flop');
  // On the flop Dung bets 200 and walks away; Ann, facing the bet, folds.
  if (cur(g) === 'ann') pokerAct(g, 'ann', { k: 'call' });
  expect(pokerAct(g, 'dung', { k: 'raise', to: 200 })).toBe(true);
  pokerLeave(g, 'dung');
  expect(pokerAct(g, 'ann', { k: 'fold' })).toBe(true);
  expect(g.phase).toBe('showdown');
  expect(total(g)).toBe(before);
});

// ------------------------------------------------------------ skipping a player who has wandered off

const T0 = 5_000_000;
const everyone = ['ann', 'bao', 'chi'];

test('skip: refused until the turn has lasted 40 seconds, then allowed for anyone else at the table', () => {
  const g = newPoker();
  start(g, players(3), T0); // Ann is first to act and owes the big blind
  expect(SKIP_AFTER_MS).toBe(40_000);
  expect(g.turnSince).toBe(T0);
  expect(pokerSkipIn(g, T0)).toBe(40_000);
  expect(pokerSkipIn(g, T0 + 15_000)).toBe(25_000);
  expect(pokerSkip(g, 'bao', T0, everyone)).toBe(false);
  expect(pokerSkip(g, 'bao', T0 + 39_999, everyone)).toBe(false);
  expect(pokerSkipIn(g, T0 + 39_999)).toBe(1);
  expect(g.seats[0].folded).toBe(false);
  expect(pokerSkipIn(g, T0 + 40_000)).toBe(0);
  expect(pokerSkip(g, 'bao', T0 + 40_000, everyone)).toBe(true);
  // Ann was facing a bet, so she is folded; she keeps her seat and her chips.
  expect(g.seats[0]).toMatchObject({ id: 'ann', folded: true, chips: 1000 });
  expect(cur(g)).toBe('bao');
  // The clock starts again for the next player.
  expect(g.turnSince).toBe(T0 + 40_000);
  expect(pokerSkipIn(g, T0 + 41_000)).toBe(39_000);
  expect(pokerSkip(g, 'chi', T0 + 41_000, everyone)).toBe(false);
});

test('skip: checks when checking is free, folds only when there is a bet to answer', () => {
  const g = newPoker();
  start(g, players(3), T0);
  act(g, 'ann', { k: 'call' }, T0 + 1000);
  act(g, 'bao', { k: 'call' }, T0 + 2000);
  // Chi is the big blind with nothing to call: a skip is a check, and the flop comes.
  expect(g.turnSince).toBe(T0 + 2000);
  expect(pokerSkip(g, 'ann', T0 + 41_999, everyone)).toBe(false);
  expect(pokerSkip(g, 'ann', T0 + 42_000, everyone)).toBe(true);
  expect(g.seats[2]).toMatchObject({ id: 'chi', folded: false, chips: 980 });
  expect(g.phase).toBe('flop');
  expect(cur(g)).toBe('bao');
  // Bao bets; Chi, still away, is skipped again and this time folds.
  act(g, 'bao', { k: 'raise', to: 40 }, T0 + 50_000);
  expect(cur(g)).toBe('chi');
  expect(pokerSkip(g, 'bao', T0 + 90_000, everyone)).toBe(true);
  expect(g.seats[2].folded).toBe(true);
  expect(g.phase).toBe('flop');
  expect(cur(g)).toBe('ann');
  expect(total(g)).toBe(3000);
});

test('skip: refused from the player themself, from someone not at the table, and when it is nobody\'s turn', () => {
  const g = newPoker();
  const late = T0 + 10 * SKIP_AFTER_MS;
  expect(pokerSkip(g, 'bao', late, everyone)).toBe(false); // no hand yet
  expect(pokerSkipIn(g, late)).toBe(0);
  start(g, players(3), T0);
  const before = JSON.stringify(g);
  expect(pokerSkip(g, 'ann', late, everyone)).toBe(false); // it is Ann's own turn
  expect(pokerSkip(g, 'dung', late, everyone)).toBe(false); // not sitting here
  expect(pokerSkip(g, 'bao', late, ['ann', 'chi'])).toBe(false); // dealt in, but has stood up
  expect(pokerSkip(g, 'bao', NaN, everyone)).toBe(false);
  expect(JSON.stringify(g)).toBe(before);
  // Someone who sat down mid-hand and is waiting for the next one may skip.
  expect(pokerSkip(g, 'dung', late, [...everyone, 'dung'])).toBe(true);
  leave(g, 'bao', late);
  expect(g.phase).toBe('showdown');
  expect(pokerSkip(g, 'chi', late * 2, everyone)).toBe(false); // the hand is over
  expect(pokerSkipIn(g, late * 2)).toBe(0);
});

test('skip: the wait restarts when the player to act leaves, but not when somebody else does', () => {
  const g = newPoker();
  start(g, players(4), T0); // Dung is first to act four-handed
  expect(cur(g)).toBe('dung');
  leave(g, 'bao', T0 + 30_000);
  expect(g.turnSince).toBe(T0);
  expect(pokerSkipIn(g, T0 + 30_000)).toBe(10_000);
  leave(g, 'dung', T0 + 35_000);
  expect(cur(g)).toBe('ann');
  expect(g.turnSince).toBe(T0 + 35_000);
  expect(pokerSkip(g, 'chi', T0 + 40_000, ['ann', 'chi'])).toBe(false);
  expect(pokerSkip(g, 'chi', T0 + 75_000, ['ann', 'chi'])).toBe(true);
});

// ------------------------------------------------------------ bugs found by the simulation (tests/sim/poker.sim.test.ts)

test('regression: when everyone else is all-in and there is nothing to call, the board runs out without asking for a check', () => {
  const g = newPoker();
  Object.assign(g.bank, { ann: 20, bao: 1000 });
  pokerStart(g, players(2)); // Ann has the button and the small blind
  expect(cur(g)).toBe('ann');
  expect(pokerAct(g, 'ann', { k: 'call' })).toBe(true); // all-in for her last 10
  // Bao has matched the bet and nobody is left to bet against: no pointless "check" turn.
  expect(g.phase).toBe('showdown');
  expect(g.shown).toBe(true);
  expect(g.board.length).toBe(5);
  expect(total(g)).toBe(1020);
});

test('regression: someone else walking out can leave the player to act with nobody to bet against; the hand moves on', () => {
  const g = newPoker();
  Object.assign(g.bank, { ann: 20, bao: 1000, chi: 1000 });
  pokerStart(g, players(3));
  pokerAct(g, 'ann', { k: 'call' }); // all-in
  pokerAct(g, 'bao', { k: 'call' });
  expect(cur(g)).toBe('chi'); // the big blind's option
  pokerLeave(g, 'bao');
  // Only Chi has chips, and she owes nothing: straight to the showdown against Ann.
  expect(g.phase).toBe('showdown');
  expect(g.board.length).toBe(5);
  expect(total(g)).toBe(2020);
});

test('regression: an all-in for less than a full raise does not let players who already acted raise again', () => {
  const g = newPoker();
  Object.assign(g.bank, { ann: 1000, bao: 1000, chi: 70 });
  pokerStart(g, players(3));
  pokerAct(g, 'ann', { k: 'raise', to: 60 }); // a raise of 40
  pokerAct(g, 'bao', { k: 'call' });
  expect(pokerAct(g, 'chi', { k: 'raise', to: 70 })).toBe(true); // all-in, only 10 more
  expect(cur(g)).toBe('ann');
  expect(raiseRange(g, g.seats[0])).toBe(null);
  expect(pokerAct(g, 'ann', { k: 'raise', to: 110 })).toBe(false);
  expect(pokerAct(g, 'ann', { k: 'raise', to: 1000 })).toBe(false);
  expect(pokerAct(g, 'ann', { k: 'call' })).toBe(true);
  expect(pokerAct(g, 'bao', { k: 'raise', to: 200 })).toBe(false);
  expect(pokerAct(g, 'bao', { k: 'call' })).toBe(true);
  expect(g.phase).toBe('flop');
});

test('a full all-in raise, or short all-ins adding up to one, does reopen the betting', () => {
  const g = newPoker();
  Object.assign(g.bank, { ann: 1000, bao: 1000, chi: 200 });
  pokerStart(g, players(3));
  pokerAct(g, 'ann', { k: 'raise', to: 60 });
  pokerAct(g, 'bao', { k: 'call' });
  pokerAct(g, 'chi', { k: 'raise', to: 200 }); // all-in, 140 more: a full raise
  expect(raiseRange(g, g.seats[0])).toEqual({ min: 340, max: 1000 });
  expect(pokerAct(g, 'ann', { k: 'raise', to: 340 })).toBe(true);

  const h = newPoker();
  Object.assign(h.bank, { ann: 1000, bao: 80, chi: 100 });
  pokerStart(h, players(3));
  pokerAct(h, 'ann', { k: 'raise', to: 60 }); // a raise of 40
  expect(pokerAct(h, 'bao', { k: 'raise', to: 80 })).toBe(true); // all-in, 20 more
  expect(pokerAct(h, 'chi', { k: 'raise', to: 100 })).toBe(true); // all-in, 20 more again
  // Ann now faces 40 more than she bet, which is a full raise.
  expect(raiseRange(h, h.seats[0])).toEqual({ min: 140, max: 1000 });
});

test('regression: garbage actions are refused instead of throwing or being read as numbers', () => {
  const g = newPoker();
  pokerStart(g, players(3));
  const before = JSON.stringify(g);
  for (const bad of [null, undefined, 7, 'fold', {}, { k: 'deal' }, { k: 'skip' }, { k: 'raise' }, { k: 'raise', to: '60' }, { k: 'raise', to: NaN }, { k: 'raise', to: Infinity }]) {
    expect(pokerAct(g, 'ann', bad as unknown as PokerAction)).toBe(false);
  }
  expect(JSON.stringify(g)).toBe(before);
  const h = newPoker();
  expect(pokerStart(h, [players(2)[0], players(2)[0]])).toBe(false); // the same person twice
});
