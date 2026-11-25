import { expect, test } from 'vitest';
import {
  BAUCUA_MAX,
  BET_MS,
  SHOW_MS,
  START_CHIPS,
  baucuaBet,
  baucuaClear,
  baucuaGone,
  baucuaJoin,
  baucuaLeave,
  baucuaTick,
  baucuaView,
  chipsOf,
  newBauCua,
  payout,
  settle,
} from '../../shared/minigames/baucua';

const ann = { id: 'a', name: 'Ann' };
const bao = { id: 'b', name: 'Bao' };
const two = () => {
  const g = newBauCua();
  baucuaJoin(g, ann, 0);
  baucuaJoin(g, bao, 0);
  return g;
};
/** A `rnd` that makes the three dice land on these faces. */
const faces = (...f: number[]) => {
  let i = 0;
  return () => (f[i++ % f.length] + 0.5) / 6;
};
const CRAB = 4;
const SHRIMP = 5;
const DEER = 0;

test('payout is the stake back plus one stake per matching die, or nothing', () => {
  expect(payout(50, 0)).toBe(0);
  expect(payout(50, 1)).toBe(100);
  expect(payout(50, 2)).toBe(150);
  expect(payout(50, 3)).toBe(200);
  // 10 on deer (no match), 50 on crab (two dice), 100 on shrimp (one die).
  expect(settle([10, 0, 0, 0, 50, 100], [CRAB, CRAB, SHRIMP])).toEqual({ staked: 160, back: 350, net: 190 });
});

test('the first to join starts a betting round; joining twice or a full table is refused', () => {
  const g = newBauCua();
  expect(g.phase).toBe('idle');
  expect(baucuaJoin(g, ann, 100)).toBe(true);
  expect(baucuaJoin(g, ann, 100)).toBe(false);
  expect(g.phase).toBe('bet');
  expect(baucuaView(g, 100).left).toBe(BET_MS);
  expect(baucuaView(g, 100).players[0].chips).toBe(START_CHIPS);
  for (let i = 1; i < BAUCUA_MAX; i++) expect(baucuaJoin(g, { id: `p${i}`, name: `P${i}` }, 100)).toBe(true);
  expect(baucuaJoin(g, bao, 100)).toBe(false);
});

test.each([
  [[DEER, DEER, DEER], -100],
  [[CRAB, DEER, DEER], 100],
  [[CRAB, CRAB, DEER], 200],
  [[CRAB, CRAB, CRAB], 300],
])('a 100 bet on crab with dice %j changes chips by %i', (dice, change) => {
  const g = two();
  expect(baucuaBet(g, 'a', CRAB, 100, 0)).toBe(true);
  expect(chipsOf(g, 'a')).toBe(START_CHIPS - 100); // the stake leaves the hand at once
  expect(baucuaTick(g, BET_MS - 1, faces(...dice))).toBeNull();
  expect(baucuaTick(g, BET_MS, faces(...dice))).toBe('roll');
  expect(g.phase).toBe('show');
  expect(g.dice).toEqual(dice);
  expect(chipsOf(g, 'a')).toBe(START_CHIPS + change);
  const v = baucuaView(g, BET_MS);
  expect(v.players[0].net).toBe(change);
  expect(v.players[1].net).toBeNull(); // Bao had no bet down
  expect(v.players[1].chips).toBe(START_CHIPS);
});

test('bets stack across symbols and everyone sees them as they are placed', () => {
  const g = two();
  baucuaBet(g, 'a', CRAB, 50, 0);
  baucuaBet(g, 'a', CRAB, 10, 0);
  baucuaBet(g, 'a', SHRIMP, 100, 0);
  const v = baucuaView(g, 0);
  expect(v.players[0].bets).toEqual([0, 0, 0, 0, 60, 100]);
  expect(v.players[0].chips).toBe(840);
  expect(v.players[0].worth).toBe(START_CHIPS); // chips on the board still count on the leaderboard
});

test('bad bets are refused: wrong symbol, wrong chip size, outsiders, more than you hold, after betting closes', () => {
  const g = two();
  expect(baucuaBet(g, 'zed', CRAB, 10, 0)).toBe(false);
  for (const sym of [-1, 6, 1.5, '4', null, undefined, NaN]) expect(baucuaBet(g, 'a', sym, 10, 0)).toBe(false);
  for (const chip of [0, -10, 25, 1000, '10', null, Infinity]) expect(baucuaBet(g, 'a', CRAB, chip, 0)).toBe(false);
  for (let i = 0; i < 10; i++) expect(baucuaBet(g, 'a', CRAB, 100, 0)).toBe(true);
  expect(chipsOf(g, 'a')).toBe(0);
  expect(baucuaBet(g, 'a', CRAB, 10, 0)).toBe(false); // nothing left
  baucuaTick(g, BET_MS, faces(CRAB, DEER, DEER));
  expect(baucuaBet(g, 'b', CRAB, 10, BET_MS)).toBe(false); // dice are showing
  expect(baucuaClear(g, 'a')).toBe(false);
});

test('a bet is limited by the chips left, whatever the chip size', () => {
  const g = two();
  g.bank.set('a', 60);
  expect(baucuaBet(g, 'a', DEER, 100, 0)).toBe(false);
  expect(baucuaBet(g, 'a', DEER, 50, 0)).toBe(true);
  expect(baucuaBet(g, 'a', DEER, 50, 0)).toBe(false);
  expect(baucuaBet(g, 'a', DEER, 10, 0)).toBe(true);
  expect(chipsOf(g, 'a')).toBe(0);
});

test('clear returns every stake, and does nothing with no bets down', () => {
  const g = two();
  expect(baucuaClear(g, 'a')).toBe(false);
  baucuaBet(g, 'a', CRAB, 100, 0);
  baucuaBet(g, 'a', DEER, 50, 0);
  expect(baucuaClear(g, 'a')).toBe(true);
  expect(chipsOf(g, 'a')).toBe(START_CHIPS);
  expect(baucuaView(g, 0).players[0].bets).toEqual([0, 0, 0, 0, 0, 0]);
});

test('rounds run by themselves: bet, show, then a fresh betting round', () => {
  const g = two();
  baucuaBet(g, 'a', CRAB, 10, 0);
  expect(baucuaTick(g, BET_MS, faces(CRAB, CRAB, CRAB))).toBe('roll');
  expect(baucuaView(g, BET_MS + 1000).left).toBe(SHOW_MS - 1000);
  expect(baucuaTick(g, BET_MS + SHOW_MS - 1)).toBeNull();
  expect(baucuaTick(g, BET_MS + SHOW_MS)).toBe('round');
  expect(g.phase).toBe('bet');
  expect(g.round).toBe(2);
  expect(g.dice).toBeNull();
  const v = baucuaView(g, BET_MS + SHOW_MS);
  expect(v.players[0].bets).toEqual([0, 0, 0, 0, 0, 0]);
  expect(v.players[0].net).toBeNull();
  expect(v.players[0].chips).toBe(START_CHIPS + 30);
});

test('with no bets down the roll is skipped and the table waits for a bet', () => {
  const g = two();
  let rolls = 0;
  const rnd = () => (rolls++, 0);
  expect(baucuaTick(g, BET_MS, rnd)).toBe('skip');
  expect(g.phase).toBe('wait');
  expect(g.dice).toBeNull();
  expect(rolls).toBe(0);
  // However long it waits, nothing happens by itself.
  for (let t = BET_MS; t < BET_MS * 50; t += 1000) expect(baucuaTick(g, t, rnd)).toBeNull();
  expect(baucuaView(g, BET_MS * 50).left).toBe(0);
  // The first bet starts a full countdown.
  const t = BET_MS * 50;
  expect(baucuaBet(g, 'b', DEER, 10, t)).toBe(true);
  expect(g.phase).toBe('bet');
  expect(baucuaView(g, t).left).toBe(BET_MS);
  expect(baucuaTick(g, t + BET_MS, faces(DEER, CRAB, CRAB))).toBe('roll');
  expect(chipsOf(g, 'b')).toBe(START_CHIPS + 10);
});

test('a bet placed and then cleared still counts as no bet', () => {
  const g = two();
  baucuaBet(g, 'a', CRAB, 10, 0);
  baucuaClear(g, 'a');
  expect(baucuaTick(g, BET_MS)).toBe('skip');
});

test('a player who reaches 0 is topped back up at the start of the next round', () => {
  const g = two();
  for (let i = 0; i < 10; i++) baucuaBet(g, 'a', CRAB, 100, 0);
  baucuaTick(g, BET_MS, faces(DEER, DEER, DEER));
  expect(chipsOf(g, 'a')).toBe(0);
  expect(baucuaView(g, BET_MS).topped).toEqual([]); // not until the next round starts
  baucuaTick(g, BET_MS + SHOW_MS);
  expect(chipsOf(g, 'a')).toBe(START_CHIPS);
  expect(baucuaView(g, BET_MS + SHOW_MS).topped).toEqual(['a']);
  expect(chipsOf(g, 'b')).toBe(START_CHIPS); // untouched
  // The message lasts one round only.
  baucuaBet(g, 'a', CRAB, 10, BET_MS + SHOW_MS);
  baucuaTick(g, 2 * BET_MS + SHOW_MS, faces(CRAB, DEER, DEER));
  baucuaTick(g, 2 * BET_MS + 2 * SHOW_MS);
  expect(g.topped).toEqual([]);
});

test('leaving the table during betting returns the stake and keeps the chips for later', () => {
  const g = two();
  baucuaBet(g, 'a', CRAB, 100, 0);
  expect(baucuaLeave(g, 'a')).toBe(true);
  expect(baucuaLeave(g, 'a')).toBe(false);
  expect(chipsOf(g, 'a')).toBe(START_CHIPS);
  expect(baucuaBet(g, 'a', CRAB, 10, 0)).toBe(false); // no longer playing
  // Their bet is gone, so with nobody else betting the roll is skipped.
  expect(baucuaTick(g, BET_MS)).toBe('skip');
});

test('chips are remembered across leaving and rejoining the table, but not across leaving the room', () => {
  const g = two();
  baucuaBet(g, 'a', CRAB, 100, 0);
  baucuaTick(g, BET_MS, faces(CRAB, CRAB, CRAB));
  expect(chipsOf(g, 'a')).toBe(1300);
  baucuaLeave(g, 'a'); // during the show: already settled, nothing to refund
  expect(chipsOf(g, 'a')).toBe(1300);
  baucuaJoin(g, ann, BET_MS + 10);
  expect(baucuaView(g, BET_MS + 10).players.find((p) => p.id === 'a')!.chips).toBe(1300);
  expect(baucuaGone(g, 'a')).toBe(true);
  expect(baucuaGone(g, 'a')).toBe(false);
  baucuaJoin(g, ann, BET_MS + 20);
  expect(chipsOf(g, 'a')).toBe(START_CHIPS);
});

test('someone who left broke and rejoins mid-round is topped up on the spot', () => {
  const g = two();
  for (let i = 0; i < 10; i++) baucuaBet(g, 'a', CRAB, 100, 0);
  baucuaTick(g, BET_MS, faces(DEER, DEER, DEER));
  baucuaLeave(g, 'a');
  baucuaTick(g, BET_MS + SHOW_MS);
  expect(chipsOf(g, 'a')).toBe(0);
  baucuaJoin(g, ann, BET_MS + SHOW_MS + 5);
  expect(chipsOf(g, 'a')).toBe(START_CHIPS);
  expect(g.topped).toEqual(['a']);
});

test('when the last player leaves the table goes idle, and the next to join starts a new round', () => {
  const g = two();
  baucuaBet(g, 'a', CRAB, 100, 0);
  baucuaTick(g, BET_MS, faces(CRAB, DEER, DEER));
  baucuaGone(g, 'a');
  baucuaLeave(g, 'b');
  expect(g.phase).toBe('idle');
  expect(g.dice).toBeNull();
  for (let t = 0; t < 100_000; t += 5000) expect(baucuaTick(g, BET_MS + t)).toBeNull();
  baucuaJoin(g, bao, 200_000);
  expect(g.phase).toBe('bet');
  expect(baucuaView(g, 200_000).left).toBe(BET_MS);
});

test('a player leaving mid-show does not stop the next round for the others', () => {
  const g = two();
  baucuaBet(g, 'a', CRAB, 100, 0);
  baucuaBet(g, 'b', DEER, 50, 0);
  baucuaTick(g, BET_MS, faces(CRAB, DEER, DEER));
  baucuaGone(g, 'a');
  expect(g.phase).toBe('show');
  expect(baucuaTick(g, BET_MS + SHOW_MS)).toBe('round');
  expect(baucuaView(g, BET_MS + SHOW_MS).players.map((p) => p.id)).toEqual(['b']);
  expect(chipsOf(g, 'b')).toBe(START_CHIPS + 100);
});

test('the dice always land on a real face, even with a random source at its edges', () => {
  for (const r of [0, 0.9999999, 1]) {
    const g = two();
    baucuaBet(g, 'a', CRAB, 10, 0);
    baucuaTick(g, BET_MS, () => r);
    expect(g.dice).toHaveLength(3);
    for (const d of g.dice!) expect([0, 1, 2, 3, 4, 5]).toContain(d);
  }
});
