import { expect, test } from 'vitest';
import { COUNTDOWN_MS, GAME_MS, ROOT_MS, SAFE_MS, TAG_MAX, TAG_REACH, newTag, tagClock, tagJoin, tagLeave, tagStart, tagTick, tagView, type TagSpot } from '../../shared/minigames/tag';
import { create } from '../../worker/src/minigames/tag';
import type { GameIO } from '../../worker/src/minigames/api';
import type { PlayerInfo } from '../../shared/protocol';

const ann = { id: 'a', name: 'Ann' };
const bao = { id: 'b', name: 'Bao' };
const chi = { id: 'c', name: 'Chi' };
/** Everyone far apart unless a test moves them. */
const spots = (over: Record<string, Partial<TagSpot>> = {}): TagSpot[] =>
  [
    { id: 'a', x: 0, z: 0, seat: null },
    { id: 'b', x: 10, z: 0, seat: null },
    { id: 'c', x: 20, z: 0, seat: null },
  ].map((s) => ({ ...s, ...over[s.id] }));
const three = () => {
  const g = newTag();
  for (const p of [ann, bao, chi]) tagJoin(g, p);
  return g;
};
/** Three players, started at time 0, with Ann "it" from COUNTDOWN_MS. */
const playing = () => {
  const g = three();
  tagStart(g, 'a', 0);
  tagTick(g, COUNTDOWN_MS, spots(), () => 0);
  return g;
};
const T0 = COUNTDOWN_MS;
const kinds = (ev: { k: string }[]) => ev.map((e) => e.k);

test('joining twice does nothing, it takes two to start, and only a player can start', () => {
  const g = newTag();
  expect(tagJoin(g, ann)).toBe(true);
  expect(tagJoin(g, ann)).toBe(false);
  expect(tagStart(g, 'a', 0)).toBe(false);
  tagJoin(g, bao);
  expect(tagStart(g, 'zed', 0)).toBe(false);
  expect(tagStart(g, 'b', 0)).toBe(true);
  expect(tagStart(g, 'a', 1)).toBe(false); // already started
  expect(tagJoin(g, chi)).toBe(false); // no joining a game under way
});

test('it holds twenty players and no more', () => {
  const g = newTag();
  for (let i = 0; i < TAG_MAX; i++) expect(tagJoin(g, { id: `p${i}`, name: `P${i}` })).toBe(true);
  expect(tagJoin(g, ann)).toBe(false);
  expect(tagStart(g, 'p7', 0)).toBe(true);
});

test('after the countdown one random player is it and the two-minute clock starts', () => {
  const g = three();
  tagStart(g, 'a', 1000);
  expect(tagTick(g, 1000 + COUNTDOWN_MS - 1, spots())).toEqual([]);
  expect(g.it).toBeNull();
  expect(tagTick(g, 1000 + COUNTDOWN_MS, spots(), () => 0.5)).toEqual([{ k: 'go', it: 'b' }]);
  expect(g.phase).toBe('play');
  expect(tagView(g, 1000 + COUNTDOWN_MS).left).toBe(GAME_MS);
  // Nobody can be tagged during the countdown, however close they stand.
  const h = three();
  tagStart(h, 'a', 0);
  expect(tagTick(h, 100, spots({ b: { x: 0.2 } }))).toEqual([]);
});

test('a tag needs it to be within reach', () => {
  const g = playing();
  expect(tagTick(g, T0 + 100, spots({ b: { x: TAG_REACH + 0.05 } }))).toEqual([]);
  expect(g.it).toBe('a');
  expect(tagTick(g, T0 + 200, spots({ b: { x: TAG_REACH - 0.05 } }))).toEqual([{ k: 'tag', from: 'a', to: 'b' }]);
  expect(g.it).toBe('b');
});

test('the nearest player in reach is the one tagged, and outsiders are ignored', () => {
  const g = playing();
  const here = [...spots({ b: { x: 1.2 }, c: { x: 0.6 } }), { id: 'zed', x: 0.1, z: 0, seat: null }];
  expect(tagTick(g, T0 + 100, here)).toEqual([{ k: 'tag', from: 'a', to: 'c' }]);
});

test('the tagged player is rooted and cannot tag back; the tagger is safe for three seconds', () => {
  const g = playing();
  const close = spots({ b: { x: 1 }, c: { x: 1.2, z: 0.5 } }); // all three in a huddle
  tagTick(g, T0, close);
  expect(g.it).toBe('b');
  let v = tagView(g, T0 + 500);
  expect([v.root, v.rootLeft, v.safe]).toEqual(['b', ROOT_MS - 500, 'a']);
  // While rooted, the new "it" tags nobody: not the tagger, not a bystander in reach.
  expect(tagTick(g, T0 + ROOT_MS - 100, close)).toEqual([]);
  // Once free they can tag the bystander, but still not the player who tagged them.
  const pair = spots({ b: { x: 1 } });
  expect(tagTick(g, T0 + ROOT_MS, pair)).toEqual([]);
  expect(tagTick(g, T0 + SAFE_MS - 100, pair)).toEqual([]);
  expect(tagTick(g, T0 + SAFE_MS, pair)).toEqual([{ k: 'tag', from: 'b', to: 'a' }]);
  v = tagView(g, T0 + SAFE_MS);
  expect([v.it, v.root, v.safe]).toEqual(['a', 'a', 'b']);
});

test('time as it is added up by the server, and the least time wins', () => {
  const g = playing();
  tagTick(g, T0 + 30_000, spots({ b: { x: 1 } })); // Ann was it for 30 s, then Bao
  tagTick(g, T0 + 50_000, spots({ b: { x: 20.5 } })); // Bao for 20 s, then Chi to the end
  expect(g.it).toBe('c');
  const ev = tagTick(g, T0 + GAME_MS + 250, spots()); // a late tick must not add extra time
  expect(kinds(ev)).toEqual(['end']);
  const end = ev[0] as Extract<(typeof ev)[number], { k: 'end' }>;
  expect(end.results.map((r) => [r.id, r.itMs])).toEqual([['b', 20_000], ['a', 30_000], ['c', 70_000]]);
  expect(end.winners).toEqual(['b']);
  expect(g.phase).toBe('lobby');
  expect(g.it).toBeNull();
  // Back in the lobby with everyone still in, the ranking on show, and ready to go again.
  const v = tagView(g, T0 + GAME_MS + 300);
  expect([v.phase, v.left, v.players.length, v.results?.length, v.winners]).toEqual(['lobby', 0, 3, 3, ['b']]);
  expect(tagStart(g, 'c', T0 + GAME_MS + 400)).toBe(true);
  expect(g.players.every((p) => p.itMs === 0)).toBe(true);
  expect(g.results).toBeNull();
});

test('players who were never it share the win', () => {
  const g = playing();
  const ev = tagTick(g, T0 + GAME_MS, spots());
  expect(ev).toMatchObject([{ k: 'end', winners: ['b', 'c'] }]);
});

test('sitting down takes a player out, and cannot be used to dodge', () => {
  const g = playing();
  const ev = tagTick(g, T0 + 100, spots({ b: { x: 1, seat: 'lounge-1' } }));
  expect(ev).toEqual([{ k: 'out', id: 'b' }]);
  expect(g.players.map((p) => p.id)).toEqual(['a', 'c']);
  expect(g.it).toBe('a');
});

test('if it leaves, someone else is picked at random and the old time still counts for nobody else', () => {
  const g = playing();
  expect(tagLeave(g, 'a', T0 + 5000, () => 0.99)).toEqual([{ k: 'out', id: 'a' }, { k: 'it', id: 'c' }]);
  expect(g.phase).toBe('play');
  const ev = tagTick(g, T0 + GAME_MS, spots());
  expect(ev).toMatchObject([{ k: 'end', winners: ['b'], results: [{ id: 'b', itMs: 0 }, { id: 'c', itMs: GAME_MS - 5000 }] }]);
});

test('it sitting down or vanishing from the room also passes it on', () => {
  const g = playing();
  expect(kinds(tagTick(g, T0 + 100, spots({ a: { seat: 'bar-2' } }), () => 0))).toEqual(['out', 'it']);
  expect(g.it).toBe('b');
  expect(kinds(tagTick(g, T0 + 200, spots().filter((s) => s.id !== 'b')))).toEqual(['out', 'stop']);
});

test('fewer than two left ends the game, in the countdown too', () => {
  const g = playing();
  tagLeave(g, 'c', T0 + 100);
  expect(g.phase).toBe('play');
  expect(tagLeave(g, 'b', T0 + 200)).toEqual([{ k: 'out', id: 'b' }, { k: 'stop' }]);
  expect([g.phase, g.it]).toEqual(['lobby', null]);
  expect(tagTick(g, T0 + GAME_MS, spots())).toEqual([]);

  const h = newTag();
  tagJoin(h, ann);
  tagJoin(h, bao);
  tagStart(h, 'a', 0);
  expect(kinds(tagLeave(h, 'a', 100))).toEqual(['out', 'stop']);
  expect(tagTick(h, COUNTDOWN_MS, spots())).toEqual([]); // nobody becomes it afterwards
  expect(tagLeave(h, 'nobody', 0)).toEqual([]);
});

test('leaving clears a root or a safe spell held by the leaver', () => {
  const g = playing();
  tagTick(g, T0, spots({ b: { x: 1 } })); // Ann tags Bao: Bao rooted, Ann safe
  tagLeave(g, 'a', T0 + 100);
  expect(g.safe).toBeNull();
  expect(g.root?.id).toBe('b');
  tagLeave(g, 'b', T0 + 200, () => 0);
  expect(g.phase).toBe('lobby');
  expect(g.root).toBeNull();
});

test('the clock reads minutes and seconds', () => {
  expect([tagClock(GAME_MS), tagClock(61_000), tagClock(900), tagClock(-5)]).toEqual(['2:00', '1:01', '0:01', '0:00']);
});

// ---- the server side, driven through a fake room

function room() {
  const people: PlayerInfo[] = [ann, bao, chi].map((p, i) => ({ ...p, color: '#fff', look: 'a', x: i * 10, z: 0, ry: 0, seat: null }));
  const log = { views: [] as unknown[], sent: [] as [string, unknown][], notices: [] as string[], emotes: [] as [string, string][], puts: [] as [string, number, number][] };
  const io: GameIO = {
    players: () => people,
    send: (id, v) => log.sent.push([id, structuredClone(v)]),
    broadcast: (v) => log.views.push(structuredClone(v)),
    notice: (t) => log.notices.push(t),
    emote: (id, k) => log.emotes.push([id, k]),
    put: (id, x, z) => log.puts.push([id, x, z]),
    nudge() {},
    resetBall() {},
    setScore() {},
  };
  const game = create(io);
  const who = (id: string) => people.find((p) => p.id === id)!;
  const last = () => log.views.at(-1) as ReturnType<typeof tagView>;
  return { game, people, log, who, last };
}

test('server: hostile or out-of-place actions change nothing', () => {
  const r = room();
  r.game.onAction(r.who('a'), { k: 'start' }, 0); // not in the game
  r.game.onAction(r.who('a'), { k: 'nonsense' }, 0);
  r.game.onAction(r.who('a'), {}, 0);
  r.game.onAction(r.who('a'), { k: 'tag', to: 'b', it: 'b', itMs: -5 }, 0); // browsers cannot claim tags
  expect(r.log.views).toEqual([]);
  r.who('c').seat = 'lounge-1';
  r.game.onAction(r.who('c'), { k: 'join' }, 0); // seated players cannot join
  r.game.onAction(r.who('a'), { k: 'join' }, 0);
  r.game.onAction(r.who('a'), { k: 'start' }, 0); // alone
  expect(r.last().players.map((p) => p.id)).toEqual(['a']);
  expect(r.last().phase).toBe('lobby');
});

test('server: a whole game from real positions, with a notice for the winner', () => {
  const r = room();
  for (const id of ['a', 'b', 'c']) r.game.onAction(r.who(id), { k: 'join' }, 0);
  r.game.onAction(r.who('b'), { k: 'start' }, 0);
  expect(r.last().phase).toBe('countdown');
  r.game.tick!(COUNTDOWN_MS);
  const first = r.last().it!;
  expect(r.last().phase).toBe('play');
  const quiet = r.log.views.length;
  r.game.tick!(T0 + 100);
  expect(r.log.views.length).toBe(quiet); // nothing happened, nothing sent

  // "It" walks up to someone: the server sees it and passes it on.
  const target = r.people.find((p) => p.id !== first)!;
  const it = r.who(first);
  it.x = target.x + 1;
  r.game.tick!(T0 + 10_000);
  expect(r.last().it).toBe(target.id);
  expect(r.last().root).toBe(target.id);
  expect(r.log.emotes).toContainEqual([target.id, '🔥']);
  // A rooted player whose browser lets them wander is put back where they were tagged.
  const [x0, z0] = [target.x, target.z];
  target.x += 5;
  r.game.tick!(T0 + 10_200);
  expect(r.log.puts).toEqual([[target.id, x0, z0]]);
  target.x = x0;
  it.x = 100;

  // A newcomer is shown the game as it stands.
  r.game.onJoin!({ ...r.who('a'), id: 'n', name: 'New' }, T0 + 20_000);
  expect(r.log.sent.at(-1)).toMatchObject(['n', { phase: 'play', it: target.id, left: GAME_MS - 20_000 }]);

  r.game.tick!(T0 + GAME_MS);
  const v = r.last();
  expect(v.phase).toBe('lobby');
  expect(v.results!.at(-1)).toMatchObject({ id: target.id, itMs: GAME_MS - 10_000 });
  expect(v.results!.find((x) => x.id === first)!.itMs).toBe(10_000);
  const third = r.people.find((p) => p.id !== first && p.id !== target.id)!;
  expect(v.winners).toEqual([third.id]);
  expect(r.log.notices.at(-1)).toContain(`${third.name} won at tag`);
});

test('server: someone leaving the room mid-game is removed, and the last pair breaking up stops it', () => {
  const r = room();
  for (const id of ['a', 'b', 'c']) r.game.onAction(r.who(id), { k: 'join' }, 0);
  r.game.onAction(r.who('a'), { k: 'start' }, 0);
  r.game.tick!(COUNTDOWN_MS);
  const it = r.last().it!;
  r.game.onLeave(it, T0 + 1000);
  expect(r.last().players.some((p) => p.id === it)).toBe(false);
  expect(r.last().it).not.toBe(it);
  expect(r.last().it).not.toBeNull();
  r.game.onAction(r.who(r.last().players[0].id), { k: 'leave' }, T0 + 2000);
  expect(r.last()).toMatchObject({ phase: 'lobby', it: null, results: null });
  expect(r.log.notices.at(-1)).toContain('not enough players');
});
