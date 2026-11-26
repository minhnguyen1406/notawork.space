import { expect, test } from 'vitest';
import { BOARD_CAP, FLUSH_MS, FULL_N, NAME_MAX, TOP_N, boardApply, boardFlush, boardRows, boardView, cleanName, lapText, newTallies } from '../../shared/minigames/board';
import type { GameIO, RoomEvent } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/board';
import type { PlayerInfo } from '../../shared/protocol';

test('a duel counts a win for one and a loss for the other', () => {
  const t = newTallies();
  expect(boardApply(t, { kind: 'duel', winner: 'Ann', loser: 'Bao' })).toBe(true);
  expect(boardView(t).duel).toEqual([
    { name: 'Ann', w: 1, l: 0 },
    { name: 'Bao', w: 0, l: 1 },
  ]);
});

test('duels order by more wins, then fewer losses, then name', () => {
  const t = newTallies();
  const duel = (winner: string, loser: string) => boardApply(t, { kind: 'duel', winner, loser });
  duel('Chi', 'Zed');
  duel('Chi', 'Zed');
  duel('Bao', 'Zed');
  duel('Ann', 'Zed');
  duel('Dan', 'Zed');
  duel('Chi', 'Dan'); // Dan: 1 win, 1 loss, so below Ann and Bao who have 1 win and none lost
  expect(boardView(t, 10).duel.map((r) => r.name)).toEqual(['Chi', 'Ann', 'Bao', 'Dan', 'Zed']);
});

test('a duel with oneself, or with nobody named, counts nothing', () => {
  const t = newTallies();
  expect(boardApply(t, { kind: 'duel', winner: 'Ann', loser: 'Ann' })).toBe(false);
  expect(boardApply(t, { kind: 'duel', winner: 'Someone', loser: '' })).toBe(false);
  expect(boardApply(t, { kind: 'duel', winner: 'Ann', loser: 'Someone' })).toBe(true);
  expect(boardView(t).duel).toEqual([{ name: 'Ann', w: 1, l: 0 }]);
});

test('goals count for the kicker, and a goal by nobody is ignored', () => {
  const t = newTallies();
  expect(boardApply(t, { kind: 'goal', side: 'red', by: 'Ann' } as RoomEvent)).toBe(true);
  boardApply(t, { kind: 'goal', by: 'Ann' });
  boardApply(t, { kind: 'goal', by: 'Bao' });
  expect(boardApply(t, { kind: 'goal', by: '' })).toBe(false);
  expect(boardApply(t, { kind: 'goal', by: '   ' })).toBe(false);
  expect(boardView(t).goal).toEqual([
    { name: 'Ann', n: 2 },
    { name: 'Bao', n: 1 },
  ]);
});

test('chess wins and dishes served are counted, ties going by name', () => {
  const t = newTallies();
  boardApply(t, { kind: 'chess', winner: 'Bao' });
  boardApply(t, { kind: 'chess', winner: 'Ann' });
  boardApply(t, { kind: 'serve', id: 'x', name: 'Chi', dish: 'pho' } as RoomEvent);
  boardApply(t, { kind: 'serve', name: 'Chi' });
  boardApply(t, { kind: 'serve', name: 'Ann' });
  const v = boardView(t);
  expect(v.chess).toEqual([
    { name: 'Ann', n: 1 },
    { name: 'Bao', n: 1 },
  ]);
  expect(v.serve).toEqual([
    { name: 'Chi', n: 2 },
    { name: 'Ann', n: 1 },
  ]);
});

test('a lap keeps the best time per name, quickest first', () => {
  const t = newTallies();
  expect(boardApply(t, { kind: 'lap', name: 'Ann', ms: 20_000 })).toBe(true);
  expect(boardApply(t, { kind: 'lap', name: 'Ann', ms: 25_000 })).toBe(false); // slower: nothing changes
  expect(boardApply(t, { kind: 'lap', name: 'Ann', ms: 18_456 })).toBe(true);
  boardApply(t, { kind: 'lap', name: 'Bao', ms: 17_000 });
  boardApply(t, { kind: 'lap', name: 'Abe', ms: 18_456 });
  expect(boardView(t).lap).toEqual([
    { name: 'Bao', ms: 17_000 },
    { name: 'Abe', ms: 18_456 },
    { name: 'Ann', ms: 18_456 },
  ]);
});

test('nonsense lap times and unknown events are ignored', () => {
  const t = newTallies();
  for (const ms of [0, -5, NaN, Infinity, '12', undefined]) expect(boardApply(t, { kind: 'lap', name: 'Ann', ms })).toBe(false);
  expect(boardApply(t, { kind: 'dance', name: 'Ann' })).toBe(false);
  expect(boardApply(t, { kind: 'chess', winner: 42 })).toBe(false);
  expect(t.dirty).toBe(false);
  expect(boardView(t)).toEqual({ n: TOP_N, duel: [], goal: [], lap: [], chess: [], serve: [] });
});

test('names are trimmed to 24 characters, and "Someone" is nobody', () => {
  const long = 'x'.repeat(40);
  expect(cleanName(`  ${long}  `)).toBe('x'.repeat(NAME_MAX));
  expect(cleanName('Someone')).toBe('');
  expect(cleanName(' Someone ')).toBe('');
  expect(cleanName(null)).toBe('');
  const t = newTallies();
  boardApply(t, { kind: 'goal', by: long });
  boardApply(t, { kind: 'goal', by: `${'x'.repeat(NAME_MAX)}yz` }); // the same person once trimmed
  expect(boardApply(t, { kind: 'goal', by: 'Someone' })).toBe(false);
  expect(boardApply(t, { kind: 'serve', name: 'Someone' })).toBe(false);
  expect(boardView(t).goal).toEqual([{ name: 'x'.repeat(NAME_MAX), n: 2 }]);
});

test('odd names cannot break the tables', () => {
  const t = newTallies();
  boardApply(t, { kind: 'goal', by: '__proto__' });
  boardApply(t, { kind: 'goal', by: 'constructor' });
  expect(boardView(t).goal.map((r) => r.name)).toEqual(['__proto__', 'constructor']);
});

test('a table holds at most 200 names, dropping the lowest', () => {
  const t = newTallies();
  const name = (i: number) => `p${String(i).padStart(3, '0')}`;
  for (let i = 0; i < BOARD_CAP; i++) boardApply(t, { kind: 'goal', by: name(i) });
  boardApply(t, { kind: 'goal', by: name(0) }); // p000 has two
  expect(t.goal.size).toBe(BOARD_CAP);
  boardApply(t, { kind: 'goal', by: 'aaa' });
  expect(t.goal.size).toBe(BOARD_CAP);
  expect(t.goal.has('aaa')).toBe(true);
  expect(t.goal.has(name(BOARD_CAP - 1))).toBe(false); // lowest: one goal, last by name
  expect(t.goal.has(name(0))).toBe(true);
  // Someone new who would themselves rank lowest still gets in; the lowest of the rest goes.
  boardApply(t, { kind: 'goal', by: 'zzz' });
  expect(t.goal.size).toBe(BOARD_CAP);
  expect(t.goal.has('zzz')).toBe(true);
  expect(t.goal.has(name(BOARD_CAP - 2))).toBe(false);
});

test('the lap and duel tables are capped too, dropping the slowest and the biggest loser', () => {
  const t = newTallies();
  for (let i = 0; i <= BOARD_CAP; i++) boardApply(t, { kind: 'lap', name: `r${i}`, ms: 10_000 + i });
  boardApply(t, { kind: 'lap', name: 'quick', ms: 5 });
  expect(t.lap.size).toBe(BOARD_CAP);
  expect(t.lap.has('quick')).toBe(true);
  expect(t.lap.has(`r${BOARD_CAP}`)).toBe(false);
  expect(t.lap.has(`r${BOARD_CAP - 1}`)).toBe(false);
  for (let i = 0; i < BOARD_CAP + 5; i++) boardApply(t, { kind: 'duel', winner: 'Champ', loser: `d${i}` });
  expect(t.duel.size).toBe(BOARD_CAP);
  expect(boardView(t).duel[0]).toEqual({ name: 'Champ', w: BOARD_CAP + 5, l: 0 });
});

test('views hold the top 5, or the top 20 when asked', () => {
  const t = newTallies();
  for (let i = 0; i < 30; i++) for (let k = 0; k <= i; k++) boardApply(t, { kind: 'serve', name: `cook${i}` });
  const v = boardView(t);
  expect(v.n).toBe(TOP_N);
  expect(v.serve).toHaveLength(TOP_N);
  expect(v.serve[0]).toEqual({ name: 'cook29', n: 30 });
  const f = boardView(t, FULL_N);
  expect(f.n).toBe(FULL_N);
  expect(f.serve).toHaveLength(FULL_N);
  expect(f.serve[19]).toEqual({ name: 'cook10', n: 11 });
});

test('lap times read as seconds with two decimals, and rows are ready to show', () => {
  expect(lapText(18_456)).toBe('18.46 s');
  expect(lapText(9_000)).toBe('9.00 s');
  const t = newTallies();
  boardApply(t, { kind: 'lap', name: 'Ann', ms: 12_340 });
  boardApply(t, { kind: 'duel', winner: 'Ann', loser: 'Bao' });
  boardApply(t, { kind: 'goal', by: 'Ann' });
  const v = boardView(t);
  expect(boardRows(v, 'lap')).toEqual([{ name: 'Ann', score: '12.34 s' }]);
  expect(boardRows(v, 'duel')[0]).toEqual({ name: 'Ann', score: '1 W · 0 L' });
  expect(boardRows(v, 'goal')).toEqual([{ name: 'Ann', score: '1' }]);
});

test('changes are flushed at most once a second', () => {
  const t = newTallies();
  expect(boardFlush(t, 0)).toBe(false); // nothing to say
  boardApply(t, { kind: 'goal', by: 'Ann' });
  expect(boardFlush(t, 100)).toBe(true); // the first change goes straight out
  expect(boardFlush(t, 200)).toBe(false);
  boardApply(t, { kind: 'goal', by: 'Ann' });
  boardApply(t, { kind: 'goal', by: 'Bao' });
  expect(boardFlush(t, 100 + FLUSH_MS - 1)).toBe(false); // too soon: it waits
  expect(boardFlush(t, 100 + FLUSH_MS)).toBe(true);
  expect(boardFlush(t, 100 + FLUSH_MS * 5)).toBe(false); // and only once
});

// The server side, with a pretend room that records what is sent.
const player = (id: string, name: string) => ({ id, name }) as unknown as PlayerInfo;
function room() {
  const sent: { to: string; view: unknown }[] = [];
  const io = {
    players: () => [],
    send: (to: string, view: unknown) => sent.push({ to, view }),
    broadcast: (view: unknown) => sent.push({ to: '*', view }),
    notice() {},
    emote() {},
    put() {},
    nudge() {},
    resetBall() {},
    setScore() {},
  } as unknown as GameIO;
  return { game: create(io), sent };
}

test('the server queues events and broadcasts the top five once a second', () => {
  const { game, sent } = room();
  game.tick!(0);
  expect(sent).toHaveLength(0);
  game.onEvent!({ kind: 'goal', side: 'red', by: 'Ann' }, 10);
  game.onEvent!({ kind: 'duel', winner: 'Ann', loser: 'Bao' }, 20);
  expect(sent).toHaveLength(0); // nothing until the next tick
  game.tick!(100);
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe('*');
  expect(sent[0].view).toMatchObject({ n: TOP_N, goal: [{ name: 'Ann', n: 1 }] });
  for (let i = 0; i < 8; i++) game.onEvent!({ kind: 'serve', id: 'a', name: 'Ann', dish: 'pho' }, 150 + i);
  for (let now = 200; now < 1100; now += 100) game.tick!(now);
  expect(sent).toHaveLength(1);
  game.tick!(1100);
  game.tick!(1200);
  expect(sent).toHaveLength(2);
  expect(sent[1].view).toMatchObject({ serve: [{ name: 'Ann', n: 8 }] });
});

test('a newcomer is sent the tables, and "full" sends the top 20 to the asker alone', () => {
  const { game, sent } = room();
  for (let i = 0; i < 12; i++) game.onEvent!({ kind: 'chess', winner: `c${i}` }, 0);
  game.tick!(0);
  sent.length = 0;
  game.onJoin!(player('n', 'New'), 5);
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe('n');
  expect((sent[0].view as { chess: unknown[] }).chess).toHaveLength(TOP_N);
  game.onAction(player('n', 'New'), { k: 'full' }, 6);
  expect(sent).toHaveLength(2);
  expect(sent[1].to).toBe('n');
  expect(sent[1].view).toMatchObject({ n: FULL_N });
  expect((sent[1].view as { chess: unknown[] }).chess).toHaveLength(12);
});

test('nothing a browser sends can change a tally', () => {
  const { game, sent } = room();
  game.onEvent!({ kind: 'goal', side: 'blue', by: 'Ann' }, 0);
  game.tick!(0);
  const cheat = player('x', 'Cheat');
  const hostile: Record<string, unknown>[] = [
    { k: 'goal', by: 'Cheat' },
    { kind: 'goal', by: 'Cheat' },
    { k: 'full', kind: 'duel', winner: 'Cheat', loser: 'Ann', n: 9999 },
    { k: 'set', goal: [{ name: 'Cheat', n: 100 }] },
    { k: 'lap', name: 'Cheat', ms: 1 },
    { k: null },
    {},
  ];
  for (const a of hostile) game.onAction(cheat, a, 10);
  game.onLeave('x', 20);
  for (let now = 100; now <= 3000; now += 100) game.tick!(now);
  // No new broadcast (nothing changed), and the one reply was the honest top 20 to the asker.
  expect(sent.filter((s) => s.to === '*')).toHaveLength(1);
  const replies = sent.filter((s) => s.to === 'x');
  expect(replies).toHaveLength(1);
  expect(replies[0].view).toEqual({ n: FULL_N, duel: [], goal: [{ name: 'Ann', n: 1 }], lap: [], chess: [], serve: [] });
});
