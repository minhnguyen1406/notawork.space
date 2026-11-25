import { expect, test } from 'vitest';
import { DICE_MAX, DICE_START, REVEAL_MS, TURN_MS, diceBid, diceJoin, diceLeave, diceLegal, diceLiar, diceLowest, diceStart, diceTick, diceView, diceViewFor, newDice, type DiceView } from '../../shared/minigames/dice';
import { create } from '../../worker/src/minigames/dice';
import type { GameIO } from '../../worker/src/minigames/api';
import type { PlayerInfo } from '../../shared/protocol';

const ann = { id: 'a', name: 'Ann' };
const bao = { id: 'b', name: 'Bao' };
const chi = { id: 'c', name: 'Chi' };
/** A `rnd` that rolls these faces in order, round and round. */
const rolls = (...faces: number[]) => {
  let i = 0;
  return () => (faces[i++ % faces.length] - 0.5) / 6;
};
/** Three players, started. Ann holds five 1s, Bao five 2s, Chi five 3s. */
const three = () => {
  const g = newDice();
  for (const p of [ann, bao, chi]) diceJoin(g, p);
  diceStart(g, 'a', 0, rolls(1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3));
  return g;
};
const count = (g: ReturnType<typeof newDice>, id: string) => g.players.find((p) => p.id === id)?.count;
/** Every array of numbers anywhere inside a value: that is what a hand of dice looks like. */
const numberArrays = (v: unknown): number[][] => {
  if (Array.isArray(v)) return v.length && v.every((x) => typeof x === 'number') ? [v as number[]] : v.flatMap(numberArrays);
  return v && typeof v === 'object' ? Object.values(v).flatMap(numberArrays) : [];
};

test('joining: once each, eight at most, and not during a game', () => {
  const g = newDice();
  expect(diceJoin(g, ann)).toBe(true);
  expect(diceJoin(g, ann)).toBe(false);
  for (let i = 0; i < DICE_MAX - 1; i++) expect(diceJoin(g, { id: `p${i}`, name: `P${i}` })).toBe(true);
  expect(diceJoin(g, { id: 'late', name: 'Late' })).toBe(false);
  const h = three();
  expect(diceJoin(h, { id: 'late', name: 'Late' })).toBe(false);
});

test('it takes two to start, and only someone in the game can', () => {
  const g = newDice();
  diceJoin(g, ann);
  expect(diceStart(g, 'a', 0)).toBe(false);
  diceJoin(g, bao);
  expect(diceStart(g, 'zed', 0)).toBe(false);
  expect(diceStart(g, 'b', 0)).toBe(true);
  expect(g.phase).toBe('bid');
  expect(g.turn).toBe('a'); // first to join opens
  for (const p of g.players) {
    expect(p.count).toBe(DICE_START);
    expect(p.dice).toHaveLength(DICE_START);
    expect(p.dice.every((d) => d >= 1 && d <= 6)).toBe(true);
  }
  expect(diceStart(g, 'a', 0)).toBe(false); // already going
});

test('a bid must beat the last: more dice of any face, or the same number of a higher face', () => {
  const bid = { n: 3, face: 4 };
  expect(diceLegal(bid, 10, 3, 5)).toBe(true);
  expect(diceLegal(bid, 10, 4, 1)).toBe(true);
  expect(diceLegal(bid, 10, 3, 4)).toBe(false);
  expect(diceLegal(bid, 10, 3, 2)).toBe(false);
  expect(diceLegal(bid, 10, 2, 6)).toBe(false);
  expect(diceLegal(null, 10, 1, 1)).toBe(true);
  // Nonsense from a browser.
  for (const [n, f] of [[0, 3], [11, 3], [4, 0], [4, 7], [4.5, 3], ['4', 3], [4, null], [NaN, 1], [Infinity, 1]] as [unknown, unknown][]) expect(diceLegal(bid, 10, n, f)).toBe(false);
  expect(diceLowest(null, 10)).toEqual({ n: 1, face: 1 });
  expect(diceLowest(bid, 10)).toEqual({ n: 3, face: 5 });
  expect(diceLowest({ n: 3, face: 6 }, 10)).toEqual({ n: 4, face: 1 });
  expect(diceLowest({ n: 10, face: 6 }, 10)).toBeNull(); // nothing left but to call
});

test('turns go round in join order, and only the player whose turn it is may act', () => {
  const g = three();
  expect(diceLiar(g, 'a', 1)).toBe(false); // nothing to call yet
  expect(diceBid(g, 'b', 1, 1, 1)).toBe(false); // not their turn
  expect(diceBid(g, 'zed', 1, 1, 1)).toBe(false);
  expect(diceBid(g, 'a', 2, 1, 1)).toBe(true);
  expect(g.turn).toBe('b');
  expect(diceBid(g, 'b', 2, 1, 2)).toBe(false); // not a raise
  expect(diceBid(g, 'b', 2, 3, 2)).toBe(true);
  expect(g.turn).toBe('c');
  expect(diceBid(g, 'c', 3, 1, 3)).toBe(true);
  expect(g.turn).toBe('a');
  expect(g.bid).toMatchObject({ n: 3, face: 1, by: 'c' });
  expect(g.until).toBe(3 + TURN_MS);
});

test('Liar! on a true bid costs the caller a die, and the caller opens the next round', () => {
  const g = three();
  diceBid(g, 'a', 5, 1, 0); // true: Ann holds five 1s
  expect(diceLiar(g, 'c', 1)).toBe(false);
  expect(diceLiar(g, 'b', 1)).toBe(true);
  expect(g.phase).toBe('reveal');
  expect(g.reveal).toMatchObject({ count: 5, truth: true, loser: bao, caller: bao });
  expect(g.reveal!.hands.map((h) => h.dice.length)).toEqual([5, 5, 5]); // shown as they were rolled
  expect([count(g, 'a'), count(g, 'b'), count(g, 'c')]).toEqual([5, 4, 5]);
  // Nothing can be done during the pause.
  expect(diceBid(g, 'b', 1, 1, 2)).toBe(false);
  expect(diceLiar(g, 'b', 2)).toBe(false);
  expect(diceTick(g, 1 + REVEAL_MS - 1)).toBe(false);
  expect(diceTick(g, 1 + REVEAL_MS)).toBe(true);
  expect(g.phase).toBe('bid');
  expect(g.round).toBe(2);
  expect(g.turn).toBe('b');
  expect(g.bid).toBeNull();
  expect(g.players.map((p) => p.dice.length)).toEqual([5, 4, 5]);
});

test('Liar! on a false bid costs the bidder a die', () => {
  const g = three();
  diceBid(g, 'a', 6, 1, 0); // false: there are only five 1s
  diceLiar(g, 'b', 1);
  expect(g.reveal).toMatchObject({ count: 5, truth: false, loser: ann });
  expect([count(g, 'a'), count(g, 'b'), count(g, 'c')]).toEqual([4, 5, 5]);
  diceTick(g, 1 + REVEAL_MS);
  expect(g.turn).toBe('a');
});

test('no wild dice: only the face that was bid counts', () => {
  const g = newDice();
  diceJoin(g, ann);
  diceJoin(g, bao);
  diceStart(g, 'a', 0, rolls(1, 1, 1, 1, 1, 4, 4, 4, 4, 4));
  diceBid(g, 'a', 6, 4, 0); // would be true if 1s were wild
  diceLiar(g, 'b', 1);
  expect(g.reveal).toMatchObject({ count: 5, truth: false });
});

test('a player with no dice is out, the next one still in opens, and the last with dice wins', () => {
  const g = three();
  // Ann keeps bidding six 1s and being called, until she has nothing left.
  let now = 0;
  for (let left = DICE_START; left > 0; left--) {
    expect(g.turn).toBe('a');
    g.players[0].dice = Array(left).fill(1);
    g.players[1].dice = Array(5).fill(2);
    g.players[2].dice = Array(5).fill(3);
    expect(diceBid(g, 'a', 6, 1, now)).toBe(true);
    expect(diceLiar(g, 'b', now)).toBe(true);
    expect(diceTick(g, (now += REVEAL_MS))).toBe(true);
  }
  expect(count(g, 'a')).toBe(0);
  expect(g.phase).toBe('bid');
  expect(g.turn).toBe('b'); // Ann is out, so the next player opens
  expect(g.players[0].dice).toEqual([]);
  expect(diceBid(g, 'a', 1, 1, now)).toBe(false);
  // Turns skip Ann.
  diceBid(g, 'b', 1, 2, now);
  expect(g.turn).toBe('c');
  diceBid(g, 'c', 1, 3, now);
  expect(g.turn).toBe('b');
  // Now Chi loses everything by calling true bids.
  for (let left = DICE_START; left > 0; left--) {
    g.players[1].dice = Array(5).fill(2);
    g.players[2].dice = Array(left).fill(3);
    if (g.turn === 'c') diceBid(g, 'c', 1, 3, now);
    expect(diceBid(g, 'b', 5, 2, now)).toBe(true);
    expect(diceLiar(g, 'c', now)).toBe(true);
    expect(diceTick(g, (now += REVEAL_MS))).toBe(true);
  }
  expect(g.phase).toBe('lobby');
  expect(g.winner).toEqual(bao);
  expect(diceView(g, now).winner).toBe('Bao');
  expect(g.players).toHaveLength(3); // everyone stays for a rematch
  expect(diceStart(g, 'a', now)).toBe(true);
  expect(g.winner).toBeNull();
  expect(count(g, 'a')).toBe(DICE_START);
});

test('time-out: the lowest bid if there is none, otherwise Liar!', () => {
  const g = three();
  expect(diceTick(g, TURN_MS - 1)).toBe(false);
  expect(diceTick(g, TURN_MS)).toBe(true);
  expect(g.bid).toMatchObject({ n: 1, face: 1, by: 'a' });
  expect(g.turn).toBe('b');
  expect(diceTick(g, TURN_MS * 2 - 1)).toBe(false);
  expect(diceTick(g, TURN_MS * 2)).toBe(true);
  expect(g.phase).toBe('reveal');
  expect(g.reveal).toMatchObject({ caller: bao, truth: true, loser: bao });
});

test('leaving on your turn passes it on, and your dice go with you', () => {
  const g = three();
  diceBid(g, 'a', 1, 1, 0);
  expect(diceLeave(g, 'b', 5)).toBe(true);
  expect(g.turn).toBe('c');
  expect(g.until).toBe(5 + TURN_MS);
  expect(diceView(g, 5).total).toBe(10);
  expect(diceLeave(g, 'b', 5)).toBe(false);
  // Bao's 2s no longer count.
  diceBid(g, 'c', 1, 2, 6);
  diceLiar(g, 'a', 7);
  expect(g.reveal).toMatchObject({ count: 0, truth: false, loser: chi });
});

test('the last player in the order leaving on their turn wraps round to the first', () => {
  const g = three();
  diceBid(g, 'a', 1, 1, 0);
  diceBid(g, 'b', 1, 2, 0);
  diceLeave(g, 'c', 0);
  expect(g.turn).toBe('a');
});

test('leaving when it is not your turn leaves the turn alone', () => {
  const g = three();
  diceLeave(g, 'c', 9);
  expect(g.turn).toBe('a');
  expect(g.until).toBe(TURN_MS);
});

test('if the bidder has left, a false bid costs nobody, and the caller opens', () => {
  const g = three();
  diceBid(g, 'a', 9, 1, 0);
  diceLeave(g, 'a', 1);
  expect(diceLiar(g, 'b', 2)).toBe(true);
  expect(g.reveal).toMatchObject({ truth: false, loser: null });
  expect([count(g, 'b'), count(g, 'c')]).toEqual([5, 5]);
  diceTick(g, 2 + REVEAL_MS);
  expect(g.turn).toBe('b');
});

test('when leaving leaves one player with dice, they win at once', () => {
  const g = newDice();
  diceJoin(g, ann);
  diceJoin(g, bao);
  diceStart(g, 'a', 0);
  diceLeave(g, 'a', 1);
  expect(g.phase).toBe('lobby');
  expect(g.winner).toEqual(bao);
  expect(diceTick(g, 10 * TURN_MS)).toBe(false); // nothing is left waiting
});

test('leaving during the reveal: the game ends, or goes on without them, when the pause is over', () => {
  const g = three();
  diceBid(g, 'a', 6, 1, 0);
  diceLiar(g, 'b', 0); // Ann lost a die and should open
  diceLeave(g, 'a', 1);
  expect(g.phase).toBe('reveal');
  diceTick(g, REVEAL_MS);
  expect(g.phase).toBe('bid');
  expect(g.turn).toBe('b'); // the next one along opens instead
  diceBid(g, 'b', 1, 1, REVEAL_MS);
  diceLiar(g, 'c', REVEAL_MS);
  diceLeave(g, 'c', REVEAL_MS);
  diceTick(g, 2 * REVEAL_MS);
  expect(g.phase).toBe('lobby');
  expect(g.winner).toEqual(bao);
});

test('the view counts down, and shows dice counts but no dice', () => {
  const g = three();
  const v = diceView(g, 4000);
  expect(v.left).toBe(TURN_MS - 4000);
  expect(diceView(g, TURN_MS * 3).left).toBe(0);
  expect(v.players).toEqual([{ ...ann, count: 5 }, { ...bao, count: 5 }, { ...chi, count: 5 }]);
  expect(v.total).toBe(15);
  expect(numberArrays(v)).toEqual([]);
});

test('secrecy: during bidding a player is sent their own dice and nobody else\'s', () => {
  const g = three();
  diceBid(g, 'a', 1, 1, 0);
  expect(numberArrays(diceView(g, 0))).toEqual([]);
  expect(JSON.stringify(diceView(g, 0))).not.toContain('dice');
  expect(numberArrays(diceViewFor(g, 0, 'a'))).toEqual([[1, 1, 1, 1, 1]]);
  expect(numberArrays(diceViewFor(g, 0, 'b'))).toEqual([[2, 2, 2, 2, 2]]);
  expect(numberArrays(diceViewFor(g, 0, 'zed'))).toEqual([]); // a bystander gets none
  // Once called, everything is public.
  diceLiar(g, 'b', 0);
  expect(diceView(g, 0).reveal!.hands.map((h) => h.dice[0])).toEqual([1, 2, 3]);
});

test('secrecy on the wire: a whole game through the server never sends anyone another hand before the reveal', () => {
  const sent: { to: string; v: DiceView }[] = []; // to '*' is a broadcast
  const notices: string[] = [];
  const info = (p: { id: string; name: string }): PlayerInfo => ({ ...p, color: '#fff', look: 'a', x: 0, z: 0, ry: 0, seat: null });
  const io: GameIO = {
    players: () => [ann, bao, chi].map(info),
    send: (id, v) => sent.push({ to: id, v: v as DiceView }),
    broadcast: (v) => sent.push({ to: '*', v: v as DiceView }),
    notice: (t) => notices.push(t),
    emote() {},
    put() {},
    nudge() {},
    resetBall() {},
    setScore() {},
  };
  const s = create(io);
  for (const p of [ann, bao, chi]) s.onAction(info(p), { k: 'join' }, 0);
  s.onAction(info({ id: 'zed', name: 'Zed' }), { k: 'start' }, 0); // not in the game
  expect(sent.at(-1)!.v.phase).toBe('lobby');
  s.onAction(info(ann), { k: 'start' }, 0);
  // Nobody touches anything: every turn times out, so the game plays itself to the end.
  let now = 0;
  for (; now < 200 * TURN_MS && !notices.length; now += 100) s.tick!(now);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatch(/^(Ann|Bao|Chi) won/);
  expect(sent.at(-1)!.v.phase).toBe('lobby');

  const hands = new Map<string, number[]>(); // "round:id" -> the dice that player was sent
  let bidding = 0;
  for (const { to, v } of sent) {
    if (v.phase === 'reveal') {
      // The dice shown are the ones each player was privately told about.
      for (const h of v.reveal!.hands) expect(hands.get(`${v.round}:${h.id}`)).toEqual(h.dice);
      continue;
    }
    expect(v.reveal).toBeNull();
    const { mine, ...rest } = v;
    expect(numberArrays(rest)).toEqual([]);
    if (to === '*') expect(mine).toBeUndefined();
    else if (mine?.length) {
      expect(v.phase).toBe('bid');
      expect(mine).toHaveLength(v.players.find((p) => p.id === to)!.count);
      const key = `${v.round}:${to}`;
      if (hands.has(key)) expect(mine).toEqual(hands.get(key)); // no re-roll mid-round
      hands.set(key, mine);
      bidding++;
    }
  }
  expect(bidding).toBeGreaterThan(10);
  // A newcomer mid-game gets the public view only.
  s.onAction(info(ann), { k: 'start' }, now);
  sent.length = 0;
  s.onJoin!(info({ id: 'new', name: 'New' }), now);
  expect(sent).toHaveLength(1);
  expect(sent[0].v.mine).toBeUndefined();
  expect(numberArrays(sent[0].v)).toEqual([]);
  // Rubbish actions change nothing and send nothing.
  sent.length = 0;
  s.onAction(info(ann), { k: 'bid', n: '2', face: 9 }, now);
  s.onAction(info(bao), { k: 'liar' }, now);
  s.onAction(info(chi), { k: 'bid', n: 1, face: 1 }, now);
  s.onAction(info(ann), {}, now);
  expect(sent).toHaveLength(0);
});
