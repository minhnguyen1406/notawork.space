// Hand ranking, betting flow and side pots.
import { expect, test } from 'vitest';
import {
  BIG_BLIND,
  compareScores,
  newPoker,
  pokerAct,
  pokerLeave,
  pokerStart,
  potOf,
  scoreHand,
  type PokerGame,
} from '../shared/poker';

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

