import { expect, test } from 'vitest';
import { FIND_RADIUS, HIDE_MAX, HIDING_MS, SEEKING_MS, type HideGame, type HideSpot, hideHidden, hideJoin, hideLeave, hideStart, hideSummary, hideTick, hideView, newHide } from '../../shared/minigames/hide';

const ann = { id: 'a', name: 'Ann' };
const bao = { id: 'b', name: 'Bao' };
const chi = { id: 'c', name: 'Chi' };
const spot = (id: string, x: number, z: number, seat: string | null = null): HideSpot => ({ id, x, z, seat });
/** Ann at the origin, Bao 10 m east, Chi 20 m east. */
const apart = () => [spot('a', 0, 0), spot('b', 10, 0), spot('c', 20, 0)];
/** Three players, Ann seeking, already in the seeking phase at time HIDING_MS. */
const seeking = (): HideGame => {
  const g = newHide();
  for (const p of [ann, bao, chi]) hideJoin(g, p);
  hideStart(g, 'a', 0, () => 0);
  hideTick(g, HIDING_MS, apart());
  return g;
};

test('joining twice does nothing, it takes two to start, and only a player can start', () => {
  const g = newHide();
  expect(hideJoin(g, ann)).toBe(true);
  expect(hideJoin(g, ann)).toBe(false);
  expect(hideStart(g, 'a', 0)).toBe(false);
  hideJoin(g, bao);
  expect(hideStart(g, 'zed', 0)).toBe(false);
  expect(hideStart(g, 'b', 0, () => 0.99)).toBe(true);
  expect(g.seeker).toBe('b');
  expect(g.phase).toBe('hiding');
});

test('nobody joins or restarts mid-round, and the game is capped at twenty', () => {
  const g = newHide();
  for (let i = 0; i < HIDE_MAX + 3; i++) hideJoin(g, { id: `p${i}`, name: `P${i}` });
  expect(g.players.length).toBe(HIDE_MAX);
  expect(hideStart(g, 'p0', 0, () => 0)).toBe(true);
  expect(hideStart(g, 'p1', 1)).toBe(false);
  hideLeave(g, 'p19');
  expect(hideJoin(g, chi)).toBe(false);
});

test('nobody is found while the seeker is counting, even standing next to them', () => {
  const g = newHide();
  for (const p of [ann, bao]) hideJoin(g, p);
  hideStart(g, 'a', 0, () => 0);
  const close = [spot('a', 0, 0), spot('b', 0.5, 0)];
  expect(hideTick(g, HIDING_MS - 1, close)).toEqual({ changed: false, found: [], result: null });
  expect(g.phase).toBe('hiding');
  // The moment the count ends they are within reach.
  expect(hideTick(g, HIDING_MS, close).result?.winner).toBe('seeker');
});

test('the seeking phase starts after thirty seconds and lasts three minutes', () => {
  const g = seeking();
  expect(g.phase).toBe('seeking');
  expect(hideView(g, HIDING_MS + 1000).left).toBe(SEEKING_MS - 1000);
});

test('a hider is found inside two metres, by real distance, and not outside it', () => {
  const g = seeking();
  const at = (x: number, z: number) => [spot('a', 0, 0), spot('b', x, z), spot('c', 20, 0)];
  expect(hideTick(g, HIDING_MS + 100, at(FIND_RADIUS + 0.1, 0)).found).toEqual([]);
  expect(hideTick(g, HIDING_MS + 200, at(1.9, 1.9)).found).toEqual([]); // 2.7 m on the diagonal
  const ev = hideTick(g, HIDING_MS + 300, at(1.2, 1.2));
  expect(ev.found).toEqual(['b']);
  expect(ev.changed).toBe(true);
  expect(ev.result).toBeNull();
  expect(g.news).toBe('Bao was found!');
  expect(hideHidden(g).map((p) => p.id)).toEqual(['c']);
  // Already found: not announced twice.
  expect(hideTick(g, HIDING_MS + 400, at(1.2, 1.2)).found).toEqual([]);
});

test('finding everyone wins it for the seeker and names the last one found', () => {
  const g = seeking();
  hideTick(g, HIDING_MS + 100, [spot('a', 0, 0), spot('b', 1, 0), spot('c', 20, 0)]);
  const ev = hideTick(g, HIDING_MS + 200, [spot('a', 19, 0), spot('b', 1, 0), spot('c', 20, 0)]);
  expect(ev.result).toEqual({ winner: 'seeker', seeker: 'Ann', hidden: [], lastFound: 'Chi' });
  expect(hideSummary(ev.result!)).toContain('Ann found everyone');
  expect(hideSummary(ev.result!)).toContain('Chi was the last one found');
  // Back in the lobby with the same people, ready to go again.
  expect(g.phase).toBe('lobby');
  expect(g.seeker).toBeNull();
  expect(g.found).toEqual([]);
  expect(g.players.length).toBe(3);
  expect(hideStart(g, 'c', 0, () => 0)).toBe(true);
  expect(g.result).toBeNull();
});

test('when time runs out the hiders still hidden win', () => {
  const g = seeking();
  hideTick(g, HIDING_MS + 100, [spot('a', 0, 0), spot('b', 1, 0), spot('c', 20, 0)]);
  expect(hideTick(g, HIDING_MS + SEEKING_MS - 1, apart()).result).toBeNull();
  const ev = hideTick(g, HIDING_MS + SEEKING_MS, apart());
  expect(ev.result).toEqual({ winner: 'hiders', seeker: 'Ann', hidden: ['Chi'], lastFound: 'Bao' });
  expect(hideSummary(ev.result!)).toContain('Chi stayed hidden from Ann and wins');
  expect(hideSummary(ev.result!)).toContain('Bao was the last one found');
  expect(g.phase).toBe('lobby');
});

test('a hider who sits down counts as found', () => {
  const g = seeking();
  const ev = hideTick(g, HIDING_MS + 100, [spot('a', 0, 0), spot('b', 10, 0, 'lounge-1'), spot('c', 20, 0)]);
  expect(ev.found).toEqual(['b']);
});

test('a hider who leaves is removed, and the round ends if that settles it', () => {
  const g = seeking();
  expect(hideLeave(g, 'zed').changed).toBe(false);
  // Bao is found, then Chi (the only one still hidden) walks out: the seeker has found everyone left.
  hideTick(g, HIDING_MS + 100, [spot('a', 0, 0), spot('b', 1, 0), spot('c', 20, 0)]);
  const ev = hideLeave(g, 'c');
  expect(ev.result?.winner).toBe('seeker');
  expect(g.players.map((p) => p.id)).toEqual(['a', 'b']);

  // A hidden hider leaving with another still hidden changes nothing else.
  const h = seeking();
  expect(hideLeave(h, 'b')).toEqual({ changed: true, found: [], result: null });
  expect(h.phase).toBe('seeking');
  // The last hider leaving calls the round off.
  expect(hideLeave(h, 'c').result?.winner).toBe('none');
  expect(h.phase).toBe('lobby');
});

test('the seeker leaving ends the game, in either phase', () => {
  const g = seeking();
  const ev = hideLeave(g, 'a');
  expect(ev.result).toMatchObject({ winner: 'none', seeker: 'Ann' });
  expect(g.phase).toBe('lobby');
  expect(g.players.map((p) => p.id)).toEqual(['b', 'c']);

  const h = newHide();
  for (const p of [ann, bao, chi]) hideJoin(h, p);
  hideStart(h, 'a', 0, () => 0);
  expect(hideLeave(h, 'a').result?.winner).toBe('none');
  expect(h.phase).toBe('lobby');
});

test('players who vanish from the room without a goodbye are dropped by the next tick', () => {
  const g = seeking();
  const ev = hideTick(g, HIDING_MS + 100, [spot('a', 0, 0), spot('c', 20, 0)]);
  expect(ev.changed).toBe(true);
  expect(g.players.map((p) => p.id)).toEqual(['a', 'c']);
  // And a vanished seeker ends it rather than leaving everyone hiding for ever.
  expect(hideTick(g, HIDING_MS + 200, [spot('c', 20, 0)]).result?.winner).toBe('none');
  expect(g.phase).toBe('lobby');
});

test('leaving in the lobby just removes the player, and ticks in the lobby do nothing', () => {
  const g = newHide();
  hideJoin(g, ann);
  hideJoin(g, bao);
  expect(hideTick(g, 999_999, [])).toEqual({ changed: false, found: [], result: null });
  expect(hideLeave(g, 'a')).toEqual({ changed: true, found: [], result: null });
  expect(g.players).toEqual([bao]);
});

test('the view says who is found but never where anyone is', () => {
  const g = seeking();
  hideTick(g, HIDING_MS + 100, [spot('a', 0, 0), spot('b', 1.25, 0.75), spot('c', 17.5, 3.25)]);
  const v = hideView(g, HIDING_MS + 100);
  expect(v.found).toEqual(['b']);
  expect(v.seeker).toBe('a');
  const json = JSON.stringify(v);
  for (const secret of ['17.5', '3.25', '1.25', '"x"', '"z"', 'seat']) expect(json).not.toContain(secret);
  expect(Object.keys(v).sort()).toEqual(['found', 'left', 'news', 'phase', 'players', 'result', 'seeker']);
});
