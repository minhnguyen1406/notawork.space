import { expect, test } from 'vitest';
import { RECIPES } from '../../shared/kitchen';
import {
  COOKOFF_MAX,
  COUNTDOWN_MS,
  ORDER_MS,
  ROUND_MS,
  type CookoffGame,
  cookJoin,
  cookLeave,
  cookServe,
  cookStart,
  cookSwitch,
  cookTick,
  cookView,
  dishPoints,
  newCookoff,
  resultText,
  teamSize,
} from '../../shared/minigames/cookoff';

const names = ['Ann', 'Bao', 'Chi', 'Dung', 'Em', 'Fay'];
/** A lobby of n people; with rnd fixed at 0, odd joiners go red: a, c, e are red and b, d, f are blue. */
const lobby = (n: number) => {
  const g = newCookoff();
  for (let i = 0; i < n; i++) cookJoin(g, { id: 'abcdef'[i], name: names[i] }, () => 0);
  return g;
};
/** A contest that has just begun at time T0; rnd 0 makes both orders the first recipe. */
const T0 = COUNTDOWN_MS;
const playing = (n: number) => {
  const g = lobby(n);
  cookStart(g, 'a', 0);
  cookTick(g, T0, () => 0);
  return g;
};
const team = (g: CookoffGame, id: string) => g.players.find((p) => p.id === id)!.team;

test('dishes score by how many ingredients they have', () => {
  expect(dishPoints('Garden Salad')).toBe(1);
  expect(dishPoints('Burger')).toBe(2);
  expect(dishPoints('The Works')).toBe(3);
  expect(dishPoints('Mystery Plate')).toBe(1);
  expect(dishPoints('')).toBe(1);
  for (const r of RECIPES) expect(dishPoints(r.name)).toBe(Math.min(3, r.items.length - 1));
});

test('people are dealt evenly, nobody joins twice, and twenty is the limit', () => {
  const g = lobby(5);
  expect(teamSize(g, 'red')).toBe(3);
  expect(teamSize(g, 'blue')).toBe(2);
  expect(cookJoin(g, { id: 'a', name: 'Ann' })).toBe(false);
  const big = newCookoff();
  for (let i = 0; i < COOKOFF_MAX; i++) expect(cookJoin(big, { id: `p${i}`, name: `P${i}` })).toBe(true);
  expect(cookJoin(big, { id: 'late', name: 'Late' })).toBe(false);
  expect(teamSize(big, 'red')).toBe(10);
  expect(teamSize(big, 'blue')).toBe(10);
});

test('switching sides is allowed only while the sides stay within one of each other', () => {
  const g = lobby(2);
  expect(cookSwitch(g, 'a')).toBe(false); // would leave 0 against 2
  cookJoin(g, { id: 'c', name: 'Chi' }, () => 0); // red 2, blue 1
  expect(cookSwitch(g, 'b')).toBe(false); // would leave 3 against 0
  expect(cookSwitch(g, 'a')).toBe(true); // red 1, blue 2
  expect(team(g, 'a')).toBe('blue');
  expect(cookSwitch(g, 'zed')).toBe(false);
  cookStart(g, 'a', 0);
  expect(cookSwitch(g, 'c')).toBe(false); // not once it has started
});

test('it takes two to start, only someone taking part can, and lopsided sides are evened out', () => {
  const g = lobby(1);
  expect(cookStart(g, 'a', 0)).toBe(false);
  const h = lobby(4);
  expect(cookStart(h, 'zed', 0)).toBe(false);
  cookLeave(h, 'b');
  cookLeave(h, 'd'); // red 2, blue 0
  expect(cookStart(h, 'a', 0)).toBe(true);
  expect(teamSize(h, 'red')).toBe(1);
  expect(teamSize(h, 'blue')).toBe(1);
  expect(h.phase).toBe('countdown');
  expect(cookStart(h, 'a', 1)).toBe(false); // already going
});

test('a three-second countdown, then a three-minute clock and an order for each side', () => {
  const g = lobby(2);
  cookStart(g, 'a', 0);
  expect(cookServe(g, 'a', 'Burger', 100)).toBeNull(); // not during the countdown
  expect(cookTick(g, COUNTDOWN_MS - 1).changed).toBe(false);
  expect(cookTick(g, COUNTDOWN_MS, () => 0).go).toBe(true);
  expect(g.phase).toBe('play');
  const v = cookView(g, T0 + 1000);
  expect(v.left).toBe(ROUND_MS - 1000);
  expect(v.order.red).toEqual({ dish: RECIPES[0].name, pts: 2, left: ORDER_MS - 1000 });
  expect(v.order.blue?.dish).toBe(RECIPES[0].name);
});

test('a serve scores for the cook\'s side; outsiders and the lobby score nothing', () => {
  const g = lobby(2);
  expect(cookServe(g, 'a', 'Burger', 0)).toBeNull(); // lobby
  const p = playing(2);
  expect(cookServe(p, 'zed', 'Burger', T0 + 1)).toBeNull();
  expect(cookServe(p, 'a', 'Burger', T0 + 1)).toMatchObject({ team: 'red', pts: 2, bonus: false });
  expect(cookServe(p, 'b', 'The Works', T0 + 2)).toMatchObject({ team: 'blue', pts: 3 });
  expect(cookServe(p, 'b', 'Something Odd', T0 + 3)).toMatchObject({ pts: 1 });
  expect(p.score).toEqual({ red: 2, blue: 4 });
  expect(cookServe(p, 'a', 'Burger', T0 + ROUND_MS)).toBeNull(); // the clock has run out
});

test('the order scores double, once, and is then replaced by a different dish', () => {
  const g = playing(2);
  const order = g.order.red!.dish; // Garden Salad, worth 1
  expect(cookServe(g, 'a', order, T0 + 10, () => 0)).toMatchObject({ pts: 2, bonus: true });
  expect(g.order.red!.dish).not.toBe(order);
  expect(g.order.red!.until).toBe(T0 + 10 + ORDER_MS);
  expect(cookServe(g, 'a', order, T0 + 20)).toMatchObject({ pts: 1, bonus: false });
  // The other side's order is its own: red serving did not use it up.
  expect(g.order.blue!.dish).toBe(order);
  expect(g.score.red).toBe(3);
});

test('serving something else leaves the order standing', () => {
  const g = playing(2);
  const order = g.order.red!;
  cookServe(g, 'a', 'Burger', T0 + 10);
  expect(g.order.red).toBe(order);
});

test('an order nobody fills is swapped after 45 seconds', () => {
  const g = playing(2);
  const first = g.order.red!.dish;
  expect(cookTick(g, T0 + ORDER_MS - 1).changed).toBe(false);
  expect(cookTick(g, T0 + ORDER_MS, () => 0).changed).toBe(true);
  expect(g.order.red!.dish).not.toBe(first);
  expect(g.order.blue!.dish).not.toBe(first);
  expect(g.order.red!.until).toBe(T0 + ORDER_MS * 2);
});

test('orders are always real recipes, whatever the dice say', () => {
  for (const r of [0, 0.3, 0.999, 1]) {
    const g = lobby(2);
    cookStart(g, 'a', 0);
    cookTick(g, T0, () => r);
    expect(RECIPES.map((x) => x.name)).toContain(g.order.red!.dish);
  }
});

test('when time is up the higher score wins and the top cook is named', () => {
  const g = playing(4); // a, c red; b, d blue
  cookServe(g, 'a', 'Burger', T0 + 1); // red 2
  cookServe(g, 'c', 'The Works', T0 + 2); // red 5
  cookServe(g, 'b', 'Cheeseburger', T0 + 3); // blue 2
  expect(cookTick(g, T0 + ROUND_MS - 1).ended).toBeUndefined();
  const end = cookTick(g, T0 + ROUND_MS).ended!;
  expect(end).toEqual({ red: 5, blue: 2, winner: 'red', forfeit: false, top: { name: 'Chi', pts: 3 } });
  expect(resultText(end)).toBe('Cook-off: Red wins 5–2! Top cook: Chi (3).');
  expect(g.phase).toBe('lobby');
  expect(g.last).toBe(end);
  expect(g.players).toHaveLength(4); // everyone is still signed up for another go
  expect(cookView(g, T0 + ROUND_MS + 5).order).toEqual({ red: null, blue: null });
});

test('level scores are a draw, and nobody is top cook if nothing was served', () => {
  const g = playing(2);
  const end = cookTick(g, T0 + ROUND_MS).ended!;
  expect(end.winner).toBe('draw');
  expect(end.top).toBeNull();
  expect(resultText(end)).toBe('Cook-off: a 0–0 draw.');
});

test('a new contest starts from nothing', () => {
  const g = playing(2);
  cookServe(g, 'a', 'Burger', T0 + 1);
  cookTick(g, T0 + ROUND_MS);
  expect(cookStart(g, 'b', T0 + ROUND_MS + 10)).toBe(true);
  expect(g.score).toEqual({ red: 0, blue: 0 });
  expect(g.players.every((p) => p.pts === 0)).toBe(true);
  expect(g.feed).toEqual([]);
  expect(g.last).toBeNull();
});

test('a side with nobody left forfeits, even if it was ahead', () => {
  const g = playing(3); // a, c red; b blue
  cookServe(g, 'b', 'The Works', T0 + 1);
  expect(cookLeave(g, 'a')).toEqual({ ended: null }); // red still has c
  expect(g.phase).toBe('play');
  const out = cookLeave(g, 'b')!;
  expect(out.ended).toMatchObject({ winner: 'red', forfeit: true, red: 0, blue: 3 });
  expect(resultText(out.ended!)).toContain('Red wins by forfeit');
  expect(g.phase).toBe('lobby');
  expect(cookLeave(g, 'zed')).toBeNull();
});

test('a side emptying during the countdown, or everyone going, just returns to the lobby', () => {
  const g = lobby(2);
  cookStart(g, 'a', 0);
  expect(cookLeave(g, 'b')).toEqual({ ended: null });
  expect(g.phase).toBe('lobby');
  expect(cookTick(g, COUNTDOWN_MS).changed).toBe(false);
  const h = playing(2);
  h.players.pop(); // both vanish at once
  expect(cookLeave(h, 'a')).toEqual({ ended: null });
  expect(h.phase).toBe('lobby');
  expect(h.last).toBeNull();
});

test('someone can join a contest in progress, on the smaller side, and score at once', () => {
  const g = playing(3); // red 2, blue 1
  expect(cookJoin(g, { id: 'd', name: 'Dung' })).toBe(true);
  expect(team(g, 'd')).toBe('blue');
  expect(cookServe(g, 'd', 'Burger', T0 + 5)).toMatchObject({ team: 'blue', pts: 2 });
});

test('the view keeps only the last few serves, newest last', () => {
  const g = playing(2);
  for (let i = 0; i < 7; i++) cookServe(g, 'a', i === 6 ? 'Cheeseburger' : 'Burger', T0 + 1 + i);
  const v = cookView(g, T0 + 10);
  expect(v.feed).toHaveLength(4);
  expect(v.feed[3].dish).toBe('Cheeseburger');
  expect(v.score.red).toBe(14);
  expect(v.players.find((p) => p.id === 'a')!.pts).toBe(14);
});
