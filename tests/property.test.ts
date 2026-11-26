import { expect, test } from 'vitest';
import {
  LUCKY_COUNT,
  PASS_START,
  SPACES,
  START_CASH,
  canBuild,
  netWorth,
  newPho,
  phoBuild,
  phoBuy,
  phoCurrent,
  phoEnd,
  phoFinish,
  phoLeave,
  phoRoll,
  phoStart,
  rentFor,
  type PhoGame,
} from '../shared/property';

const people = (n: number) => ['Ann', 'Bao', 'Chi'].slice(0, n).map((name) => ({ id: name.toLowerCase(), name }));
const start = (n = 2) => {
  const g = newPho();
  phoStart(g, people(n));
  return g;
};
const at = (name: string) => SPACES.findIndex((s) => s.name === name);
/** Put the current player just before a space and roll onto it. */
const landOn = (g: PhoGame, space: number, lucky?: number) => {
  const pid = phoCurrent(g);
  g.pos[pid] = (space - 1 + SPACES.length) % SPACES.length;
  g.phase = 'roll';
  return phoRoll(g, pid, 1, lucky);
};
const totalCash = (g: PhoGame) => Object.values(g.cash).reduce((a, b) => a + b, 0);

test('the board is a loop of 24 with eight colour pairs', () => {
  expect(SPACES).toHaveLength(24);
  const cities = SPACES.filter((s) => s.kind === 'city');
  expect(cities).toHaveLength(16);
  for (let group = 0; group < 8; group++) expect(cities.filter((c) => c.group === group)).toHaveLength(2);
  expect([0, 6, 12, 18].map((i) => SPACES[i].kind)).toEqual(['start', 'rest', 'jam', 'festival']);
});

test('needs two to six players', () => {
  expect(phoStart(newPho(), people(1))).toBe(false);
  const g = start();
  expect(g.phase).toBe('roll');
  expect(g.cash).toEqual({ ann: START_CASH, bao: START_CASH });
  expect(phoStart(g, people(2))).toBe(false); // already running
});

test('only the current player may act, and only in the right phase', () => {
  const g = start();
  expect(phoRoll(g, 'bao', 1)).toBe(false);
  expect(phoEnd(g, 'ann')).toBe(false); // must roll first
  expect(phoBuy(g, 'ann', true)).toBe(false);
  expect(phoRoll(g, 'ann', 1)).toBe(true);
  expect(phoRoll(g, 'ann', 1)).toBe(false); // one roll a turn
});

test('landing on an unowned city offers it; buying takes the price', () => {
  const g = start();
  phoRoll(g, 'ann', 1); // Hà Giang, 60
  expect(g.phase).toBe('buy');
  expect(phoEnd(g, 'ann')).toBe(false); // must decide first
  phoBuy(g, 'ann', true);
  expect(g.owner[1]).toBe('ann');
  expect(g.cash.ann).toBe(START_CASH - 60);
  expect(g.phase).toBe('end');
  expect(phoEnd(g, 'ann')).toBe(true);
  expect(phoCurrent(g)).toBe('bao');
});

test('declining leaves the city unowned', () => {
  const g = start();
  phoRoll(g, 'ann', 1);
  phoBuy(g, 'ann', false);
  expect(g.owner[1]).toBeUndefined();
  expect(g.cash.ann).toBe(START_CASH);
});

test('rent goes to the owner, doubles with the pair, and rises with buildings', () => {
  const g = start();
  g.owner[1] = 'ann';
  expect(rentFor(g, 1)).toBe(6);
  phoRoll(g, 'ann', 3, 0); // lucky space, with the card fixed to the first one (+100)
  g.cash.ann = START_CASH;
  phoEnd(g, 'ann');
  landOn(g, 1);
  expect(g.cash.bao).toBe(START_CASH - 6);
  expect(g.cash.ann).toBe(START_CASH + 6);
  expect(g.phase).toBe('end');

  g.owner[2] = 'ann';
  expect(rentFor(g, 1)).toBe(12);
  g.level[1] = 1;
  expect(rentFor(g, 1)).toBe(18);
  g.level[1] = 3;
  expect(rentFor(g, 1)).toBe(60);
});

test('you pay nothing on your own city', () => {
  const g = start();
  g.owner[1] = 'ann';
  phoRoll(g, 'ann', 1);
  expect(g.cash.ann).toBe(START_CASH);
  expect(g.phase).toBe('end');
});

test('building needs the whole pair, your turn, the cash, and stops at a tower', () => {
  const g = start();
  g.owner[1] = 'ann';
  phoRoll(g, 'ann', 6); // Tea break
  expect(canBuild(g, 'ann', 1)).toBe(false); // only one of the pair
  g.owner[2] = 'ann';
  expect(phoBuild(g, 'bao', 1)).toBe(false);
  expect(phoBuild(g, 'ann', 1)).toBe(true);
  expect(g.cash.ann).toBe(START_CASH - 30);
  phoBuild(g, 'ann', 1);
  phoBuild(g, 'ann', 1);
  expect(g.level[1]).toBe(3);
  expect(phoBuild(g, 'ann', 1)).toBe(false);
  g.cash.ann = 10;
  expect(phoBuild(g, 'ann', 2)).toBe(false);
  expect(phoBuild(g, 'ann', 99)).toBe(false);
});

test('passing Start pays out', () => {
  const g = start();
  g.pos.ann = 22;
  phoRoll(g, 'ann', 4); // to space 2
  expect(g.pos.ann).toBe(2);
  expect(g.cash.ann).toBe(START_CASH + PASS_START);
});

test('toll, tax and festival move the right amounts', () => {
  const g = start();
  landOn(g, at('Road toll'));
  expect(g.cash.ann).toBe(START_CASH - 100);
  g.cash.ann = 1000;
  landOn(g, at('Market tax'));
  expect(g.cash.ann).toBe(900);
  landOn(g, at('Festival'));
  expect(g.cash.ann).toBe(1000);
});

test('a traffic jam costs exactly one turn', () => {
  const g = start();
  landOn(g, at('Traffic jam'));
  phoEnd(g, 'ann');
  expect(phoCurrent(g)).toBe('bao');
  phoRoll(g, 'bao', 6);
  phoEnd(g, 'bao');
  expect(phoCurrent(g)).toBe('bao'); // Ann is skipped
  phoRoll(g, 'bao', 6);
  if (g.phase === 'buy') phoBuy(g, 'bao', false);
  phoEnd(g, 'bao');
  expect(phoCurrent(g)).toBe('ann'); // and is back the turn after
});

test('every lucky envelope resolves and leaves the game in a sane state', () => {
  for (let card = 0; card < LUCKY_COUNT; card++) {
    const g = start(3);
    landOn(g, at('Lucky envelope'), card);
    expect(g.phase).toBe('end');
    expect(Object.values(g.cash).every((c) => c >= 0)).toBe(true);
  }
});

test('lucky envelopes between players conserve money', () => {
  for (const card of [5, 6]) {
    const g = start(3);
    landOn(g, at('Lucky envelope'), card);
    expect(totalCash(g)).toBe(START_CASH * 3);
    expect(g.cash.ann).toBe(START_CASH + (card === 5 ? 50 : -50));
  }
});

test("if you can't pay, buildings then cities are sold before you go bust", () => {
  const g = start();
  // Bao owns the dearest pair with towers; Ann has little cash but owns a pair with a building.
  g.owner[22] = g.owner[23] = 'bao';
  g.level[23] = 3; // rent 400
  g.owner[1] = g.owner[2] = 'ann';
  g.level[2] = 1;
  g.cash.ann = 300;
  landOn(g, 23);
  // Ann sold the building (+20), then Cao Bằng (+40), then Hà Giang (+30): 390, still short of 400.
  expect(g.owner[1]).toBeUndefined();
  expect(g.owner[2]).toBeUndefined();
  expect(g.cash.bao).toBe(START_CASH + 390);
  expect(g.phase).toBe('over');
  expect(g.winner).toBe('bao');
});

test('selling just enough keeps you in the game', () => {
  const g = start();
  g.owner[23] = 'bao'; // rent 40
  g.owner[1] = 'ann';
  g.cash.ann = 20;
  landOn(g, 23);
  expect(g.owner[1]).toBeUndefined(); // sold for 30
  expect(g.cash.ann).toBe(10);
  expect(g.order).toContain('ann');
  expect(g.phase).toBe('end');
});

test('going bust mid-turn passes play on cleanly with three players', () => {
  const g = start(3);
  g.owner[23] = 'bao';
  g.cash.ann = 5;
  landOn(g, 23);
  expect(g.order).toEqual(['bao', 'chi']);
  expect(g.phase).toBe('roll');
  expect(phoCurrent(g)).toBe('bao');
  expect(g.cash.bao).toBe(START_CASH + 5);
});

test('leaving returns your cities to the bank and keeps the turn order right', () => {
  const g = start(3);
  g.owner[1] = 'ann';
  phoRoll(g, 'ann', 6);
  phoEnd(g, 'ann'); // Bao's turn
  phoLeave(g, 'ann');
  expect(g.owner[1]).toBeUndefined();
  expect(phoCurrent(g)).toBe('bao');
  phoLeave(g, 'bao');
  expect(g.phase).toBe('over');
  expect(g.winner).toBe('chi');
});

test('ending early crowns the richest by cash plus property', () => {
  const g = start();
  g.owner[23] = 'bao';
  g.level[23] = 1;
  g.cash.bao = 1000; // 1000 + 400 + 200
  expect(netWorth(g, 'bao')).toBe(1600);
  expect(phoFinish(g, 'chi')).toBe(false); // not in the game
  expect(phoFinish(g, 'ann')).toBe(true);
  expect(g.winner).toBe('bao');
});

test('a long random game never breaks the books', () => {
  const g = start(3);
  for (let i = 0; i < 3000 && g.phase !== 'over'; i++) {
    const pid = phoCurrent(g);
    if (g.phase === 'roll') phoRoll(g, pid);
    else if (g.phase === 'buy') phoBuy(g, pid, true);
    else {
      for (let s = 0; s < SPACES.length; s++) while (canBuild(g, pid, s)) phoBuild(g, pid, s);
      phoEnd(g, pid);
    }
    expect(Object.values(g.cash).every((c) => c >= 0 && Number.isFinite(c))).toBe(true);
    expect(g.order.includes(phoCurrent(g)) || (g.phase as string) === 'over').toBe(true);
    for (const owner of Object.values(g.owner)) expect(g.order).toContain(owner);
  }
});

test('a jammed player still misses their turn when it reaches them because someone left', () => {
  const g = start(3);
  g.skip.bao = true;
  phoLeave(g, 'ann'); // Ann held the turn; Bao would be next but is stuck in traffic
  expect(phoCurrent(g)).toBe('chi');
  expect(g.skip.bao).toBe(false);
  expect(g.phase).toBe('roll');
});

// ---- regressions found by tests/sim/property.sim.test.ts

test('regression: when everyone is stuck in traffic at once, each jam still costs exactly one turn', () => {
  const g = start(2);
  landOn(g, at('Traffic jam')); // Ann is jammed
  phoEnd(g, 'ann');
  landOn(g, at('Traffic jam')); // and now so is Bao
  phoEnd(g, 'bao');
  // Ann misses her turn, Bao misses his, so it is Ann's go again (not Bao playing twice in a row).
  expect(phoCurrent(g)).toBe('ann');
  expect(g.skip).toEqual({ ann: false, bao: false });
});

test('regression: the turn points at the winner when the game ends because the others left', () => {
  const g = start(3);
  g.turn = 2; // Chi's turn
  phoLeave(g, 'ann');
  phoLeave(g, 'bao');
  expect(g.phase).toBe('over');
  expect(phoCurrent(g)).toBe('chi');
});

test('regression: only a real "yes" buys the city', () => {
  const g = start();
  phoRoll(g, 'ann', 1);
  expect(phoBuy(g, 'ann', 'no' as never)).toBe(true);
  expect(g.owner[1]).toBeUndefined();
  expect(g.cash.ann).toBe(START_CASH);
});

test('regression: a nonsense die or lucky card is refused and changes nothing', () => {
  const g = start();
  const before = JSON.stringify(g);
  for (const die of [0, 7, -1, 1.5, NaN, Infinity, '3' as never]) expect(phoRoll(g, 'ann', die)).toBe(false);
  expect(phoRoll(g, 'ann', 3, LUCKY_COUNT)).toBe(false);
  expect(phoRoll(g, 'ann', 3, -1)).toBe(false);
  expect(JSON.stringify(g)).toBe(before);
  expect(phoRoll(g, 'ann', 3, 0)).toBe(true);
});
