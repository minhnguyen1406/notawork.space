import { expect, test } from 'vitest';
import {
  BARRIERS,
  BODY,
  BOARD_SIZE,
  COUNTDOWN_MS,
  FINISH_SLACK,
  FINISH_X,
  LANE,
  MAX_RUN_MS,
  MID_Z,
  MIN_RUN_MS,
  RUN_SPEED,
  START_X,
  barrierAt,
  barrierHit,
  newObstacle,
  obstacleFinish,
  obstacleRecord,
  obstacleStart,
  obstacleStop,
  obstacleTick,
  obstacleView,
} from '../../shared/minigames/obstacle';
import { create } from '../../worker/src/minigames/obstacle';
import type { PlayerInfo } from '../../shared/protocol';

const ann = { id: 'a', name: 'Ann' };
const bao = { id: 'b', name: 'Bao' };
const atStart = { x: START_X, z: MID_Z };
const atEnd = { x: FINISH_X + 0.2, z: MID_Z };

test('barriers are a pure function of time, stay in the lane and repeat every period', () => {
  expect(BARRIERS.filter((b) => b.axis === 'z').length).toBeGreaterThanOrEqual(5);
  expect(BARRIERS.filter((b) => b.axis === 'x').length).toBeGreaterThanOrEqual(1);
  for (const b of BARRIERS) {
    expect(barrierAt(b, 1.234)).toEqual(barrierAt(b, 1.234));
    const a = barrierAt(b, 0.7);
    const again = barrierAt(b, 0.7 + b.period);
    expect(again.x).toBeCloseTo(a.x, 6);
    expect(again.z).toBeCloseTo(a.z, 6);
    let moved = 0;
    for (let t = -COUNTDOWN_MS / 1000; t < 20; t += 0.05) {
      const c = barrierAt(b, t);
      expect(c.z - c.hd).toBeGreaterThanOrEqual(LANE.z1 - 1e-9);
      expect(c.z + c.hd).toBeLessThanOrEqual(LANE.z2 + 1e-9);
      // Never over the start or finish line, so a runner sent back to the start is safe there.
      expect(c.x - c.hw).toBeGreaterThan(START_X + BODY);
      expect(c.x + c.hw).toBeLessThan(FINISH_X - BODY);
      moved = Math.max(moved, Math.abs(c.x - a.x) + Math.abs(c.z - a.z));
    }
    expect(moved).toBeGreaterThan(1);
  }
  // They are not all in step.
  expect(new Set(BARRIERS.map((b) => `${b.period}/${b.phase}`)).size).toBe(BARRIERS.length);
});

test('touching is judged against where the barrier is at that moment', () => {
  const b = BARRIERS[0];
  const c = barrierAt(b, 2);
  expect(barrierHit(c.x, c.z, 2)).toBe(0);
  expect(barrierHit(c.x - c.hw - BODY + 0.01, c.z, 2)).toBe(0); // brushing its side
  expect(barrierHit(c.x - c.hw - BODY - 0.05, c.z + c.hd + 1, 2)).toBe(-1);
  // The same spot is clear once it has swept away.
  const top = barrierAt(b, b.period / 4 - b.phase * b.period); // at the far north of its sweep
  const bottom = barrierAt(b, (3 * b.period) / 4 - b.phase * b.period);
  expect(barrierHit(top.x, top.z + top.hd - 0.1, (3 * b.period) / 4 - b.phase * b.period)).toBe(-1);
  expect(bottom.z).toBeLessThan(top.z);
  for (let t = -3; t < 30; t += 0.05) expect(barrierHit(START_X, MID_Z, t)).toBe(-1);
});

test('the course can be run: a patient runner gets through without touching anything', () => {
  // Walk east in small steps, waiting whenever the next step would touch a barrier.
  let x = START_X;
  let t = 0;
  const dt = 0.02;
  while (x < FINISH_X && t < 120) {
    const nx = x + RUN_SPEED * dt;
    t += dt;
    // Only step if the stretch ahead is clear now and stays clear for a moment (no sitting in a sweeper's path).
    if (barrierHit(nx, LANE.z1 + 0.5, t) < 0 && barrierHit(x, LANE.z1 + 0.5, t) < 0) x = nx;
    else if (barrierHit(x, LANE.z1 + 0.5, t) >= 0) x = START_X; // caught: back to the start
  }
  expect(x).toBeGreaterThanOrEqual(FINISH_X);
});

test('a run starts once per player, and several people run at once', () => {
  const g = newObstacle();
  expect(obstacleStart(g, ann, 1000)).toBe(true);
  expect(obstacleStart(g, ann, 1500)).toBe(false);
  expect(obstacleStart(g, { ...bao, seat: 'chair-1' }, 1500)).toBe(false); // sitting down
  expect(obstacleStart(g, bao, 2000)).toBe(true);
  expect(g.runs.map((r) => r.go)).toEqual([1000 + COUNTDOWN_MS, 2000 + COUNTDOWN_MS]);
  expect(obstacleView(g).runners).toEqual(['a', 'b']);
});

test('the floor on times comes from the lane length and running speed', () => {
  expect(MIN_RUN_MS).toBe(Math.floor(((FINISH_X - START_X - FINISH_SLACK) / RUN_SPEED) * 1000));
  expect(MIN_RUN_MS).toBeGreaterThan(500);
  expect(FINISH_X - START_X).toBeLessThan(LANE.x2 - LANE.x1);
});

test('a finish needs a run the server started, the clock running, and the server to see you at the east end', () => {
  const g = newObstacle();
  expect(obstacleFinish(g, 'a', atEnd, 9999)).toBeNull(); // never started
  obstacleStart(g, ann, 0);
  const go = COUNTDOWN_MS;
  expect(obstacleFinish(g, 'a', atEnd, go - 1)).toBeNull(); // still counting down
  expect(obstacleFinish(g, 'a', atStart, go + 5000)).toBeNull(); // says so, but is at the start
  expect(obstacleFinish(g, 'a', { x: FINISH_X - FINISH_SLACK - 0.1, z: MID_Z }, go + 5000)).toBeNull();
  expect(obstacleFinish(g, 'a', { x: FINISH_X, z: LANE.z2 + 3 }, go + 5000)).toBeNull(); // past the line but beside the lane
  expect(obstacleFinish(g, 'a', null, go + 5000)).toBeNull();
  expect(g.runs.length).toBe(1); // none of that ended the run
  expect(obstacleFinish(g, 'b', atEnd, go + 5000)).toBeNull(); // someone who isn't running
  expect(obstacleFinish(g, 'a', atEnd, go + 5120)).toEqual({ why: 'finish', ms: 5120, rank: 1, record: true });
  expect(g.runs.length).toBe(0);
  expect(obstacleFinish(g, 'a', atEnd, go + 6000)).toBeNull(); // one finish per run
});

test('the time is measured from "go" on the server clock, and an impossible one is thrown out', () => {
  const g = newObstacle();
  obstacleStart(g, ann, 10_000);
  expect(obstacleFinish(g, 'a', atEnd, 10_000 + COUNTDOWN_MS + MIN_RUN_MS - 1)).toEqual({ why: 'too-fast' });
  expect(g.runs.length).toBe(0);
  expect(g.best).toEqual([]);
  obstacleStart(g, ann, 20_000);
  expect(obstacleFinish(g, 'a', atEnd, 20_000 + COUNTDOWN_MS + MIN_RUN_MS)).toMatchObject({ why: 'finish', ms: MIN_RUN_MS });
});

test('the board keeps the best five, one per name, fastest first', () => {
  const g = newObstacle();
  expect(obstacleRecord(g, 'Ann', 9000)).toEqual({ rank: 1, record: true });
  expect(obstacleRecord(g, 'Bao', 8000)).toEqual({ rank: 1, record: true });
  expect(obstacleRecord(g, 'Ann', 9500)).toEqual({ rank: 0, record: false }); // slower than her own best
  expect(obstacleRecord(g, 'Ann', 8500)).toEqual({ rank: 2, record: false }); // better, but not the best of all
  expect(g.best).toEqual([{ name: 'Bao', ms: 8000 }, { name: 'Ann', ms: 8500 }]);
  for (const [i, n] of ['C', 'D', 'E', 'F'].entries()) obstacleRecord(g, n, 10_000 + i);
  expect(g.best.length).toBe(BOARD_SIZE);
  expect(g.best.map((b) => b.name)).toEqual(['Bao', 'Ann', 'C', 'D', 'E']);
  expect(obstacleRecord(g, 'Zed', 20_000)).toEqual({ rank: 0, record: false }); // too slow for the board
  expect(obstacleRecord(g, 'Zed', 7000)).toEqual({ rank: 1, record: true });
  expect(g.best.map((b) => b.name)).toEqual(['Zed', 'Bao', 'Ann', 'C', 'D']);
});

test('stop cancels a run, once', () => {
  const g = newObstacle();
  obstacleStart(g, ann, 0);
  expect(obstacleStop(g, 'b')).toBe(false);
  expect(obstacleStop(g, 'a')).toBe(true);
  expect(obstacleStop(g, 'a')).toBe(false);
  expect(obstacleStart(g, ann, 10)).toBe(true); // and can go again
});

test('tick: leaving the lane, leaving the room, sitting, a false start and running out of time all end a run', () => {
  const go = COUNTDOWN_MS;
  const one = (pos: { x: number; z: number; seat?: string | null } | null, now: number, before?: (g: ReturnType<typeof newObstacle>) => void) => {
    const g = newObstacle();
    obstacleStart(g, ann, 0);
    before?.(g);
    const out = obstacleTick(g, () => pos, now);
    return { g, why: out[0]?.end.why ?? null };
  };
  const settle = (g: ReturnType<typeof newObstacle>) => obstacleTick(g, () => atStart, go); // the check at "go" passes
  // During the countdown the server's record may still be the signpost: not judged yet.
  expect(one({ x: LANE.x1 - 1, z: MID_Z + 1 }, go - 100).why).toBeNull();
  expect(one(null, go - 100).why).toBe('left'); // gone from the room
  expect(one(atStart, go + 50).why).toBeNull();
  expect(one({ x: START_X + 3, z: MID_Z }, go + 50).why).toBe('false-start'); // crept forward before "go"
  expect(one({ x: START_X + 3, z: MID_Z }, go + 400, settle).why).toBeNull(); // the same spot later is fine
  expect(one({ x: START_X + 3, z: LANE.z1 - 2 }, go + 400, settle).why).toBe('left');
  expect(one({ x: LANE.x1 - 2, z: MID_Z }, go + 400, settle).why).toBe('left');
  expect(one({ x: START_X + 3, z: LANE.z1 - 0.2 }, go + 400, settle).why).toBeNull(); // a foot on the kerb is fine
  expect(one({ ...atStart, seat: 'chair-1' }, go + 400, settle).why).toBe('left');
  expect(one(atStart, go + MAX_RUN_MS, settle).why).toBeNull();
  const late = one(atStart, go + MAX_RUN_MS + 1, settle);
  expect(late.why).toBe('timeout');
  expect(late.g.runs.length).toBe(0);
});

test('tick finishes a runner the server can see over the line, even if their message never came', () => {
  const g = newObstacle();
  obstacleStart(g, ann, 0);
  obstacleStart(g, bao, 500);
  const where = (id: string) => (id === 'a' ? atEnd : atStart);
  obstacleTick(g, () => atStart, COUNTDOWN_MS + 500);
  const out = obstacleTick(g, where, COUNTDOWN_MS + 6000);
  expect(out).toEqual([{ id: 'a', name: 'Ann', end: { why: 'finish', ms: 6000, rank: 1, record: true } }]);
  expect(g.runs.map((r) => r.id)).toEqual(['b']); // Bao is still on his own clock
  expect(obstacleFinish(g, 'b', atEnd, 500 + COUNTDOWN_MS + 4000)).toMatchObject({ ms: 4000, rank: 1, record: true });
  expect(g.best).toEqual([{ name: 'Bao', ms: 4000 }, { name: 'Ann', ms: 6000 }]);
});

// The server side, with a pretend room.
function room() {
  const people = new Map<string, PlayerInfo>();
  const log: { to: string; view: Record<string, unknown> }[] = [];
  const notices: string[] = [];
  const puts: { id: string; x: number; z: number }[] = [];
  const add = (id: string, name: string, x: number, z: number) => people.set(id, { id, name, color: '#fff', look: 'a', x, z, ry: 0, seat: null });
  const game = create({
    players: () => [...people.values()],
    send: (to, view) => log.push({ to, view: view as Record<string, unknown> }),
    broadcast: (view) => log.push({ to: '*', view: view as Record<string, unknown> }),
    notice: (t) => notices.push(t),
    emote: () => {},
    put: (id, x, z) => {
      puts.push({ id, x, z });
      Object.assign(people.get(id)!, { x, z });
    },
    nudge: () => {},
    resetBall: () => {},
    setScore: () => {},
  });
  const move = (id: string, x: number, z: number) => Object.assign(people.get(id)!, { x, z });
  return { game, people, log, notices, puts, add, move };
}

test('server: Run moves you to the start, the finish is timed by the server and a new best is announced', () => {
  const r = room();
  r.add('a', 'Ann', 8.8, 17.4);
  const a = r.people.get('a')!;
  r.game.onAction(a, { k: 'run' }, 1000);
  expect(r.puts).toEqual([{ id: 'a', x: START_X, z: MID_Z }]);
  expect(r.log[0]).toMatchObject({ to: 'a', view: { start: { t: -COUNTDOWN_MS }, runners: ['a'] } });
  expect(r.log[1]).toEqual({ to: '*', view: { best: [], runners: ['a'] } }); // nothing private in the broadcast
  const go = 1000 + COUNTDOWN_MS;
  r.game.tick!(go + 100);

  // A browser claiming to have finished, with a made-up time, while the server sees it at the start.
  r.game.onAction(a, { k: 'finish', ms: 1, x: 99 }, go + 2000);
  expect(r.notices).toEqual([]);
  expect(r.log.length).toBe(2);

  r.move('a', FINISH_X + 0.1, MID_Z);
  r.game.onAction(a, { k: 'finish', ms: 1 }, go + 7250);
  expect(r.log[2]).toMatchObject({ to: 'a', view: { end: { why: 'finish', ms: 7250, rank: 1, record: true } } });
  expect(r.log[3]).toEqual({ to: '*', view: { best: [{ name: 'Ann', ms: 7250 }], runners: [] } });
  expect(r.notices).toEqual(['Ann set a new best on the obstacle dash: 7.25s']);

  // A finish with no run under way does nothing.
  r.game.onAction(a, { k: 'finish' }, go + 9000);
  expect(r.log.length).toBe(4);
});

test('server: teleporting to the end at once does not count', () => {
  const r = room();
  r.add('a', 'Ann', 8.8, 17.4);
  const a = r.people.get('a')!;
  r.game.onAction(a, { k: 'run' }, 0);
  r.move('a', FINISH_X + 0.1, MID_Z);
  r.game.onAction(a, { k: 'finish' }, COUNTDOWN_MS - 500); // before "go": ignored
  expect(r.log.length).toBe(2);
  r.game.tick!(COUNTDOWN_MS + 10); // already down the lane when the clock starts
  expect(r.log[2]).toMatchObject({ to: 'a', view: { end: { why: 'false-start' } } });
  expect(r.log[3]).toEqual({ to: '*', view: { best: [], runners: [] } });
  expect(r.notices).toEqual([]);
});

test('server: stop, walking out and leaving the room cancel only that run; a newcomer is sent the board', () => {
  const r = room();
  r.add('a', 'Ann', 8.8, 17.4);
  r.add('b', 'Bao', 8.8, 17.0);
  r.add('c', 'Chi', 0, 0);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => r.people.get(id)!);
  r.game.onAction(a, { k: 'run' }, 0);
  r.game.onAction(b, { k: 'run' }, 0);
  r.game.onAction(c, { k: 'run' }, 0);
  r.game.onAction(a, { k: 'run' }, 100); // already running
  r.game.onAction(a, { k: 'nonsense' }, 100);
  r.game.onAction(a, {}, 100);
  expect(r.puts.length).toBe(3);
  const n = r.log.length;

  r.game.onAction(a, { k: 'stop' }, 200);
  expect(r.log[n]).toMatchObject({ to: 'a', view: { end: { why: 'stop' } } });
  expect(r.log[n + 1]).toEqual({ to: '*', view: { best: [], runners: ['b', 'c'] } });
  r.game.onAction(a, { k: 'stop' }, 300); // nothing left to stop
  expect(r.log.length).toBe(n + 2);

  r.game.tick!(COUNTDOWN_MS + 100);
  r.move('b', 14, LANE.z2 + 3); // Bao wanders off
  r.game.tick!(COUNTDOWN_MS + 200);
  expect(r.log[n + 2]).toMatchObject({ to: 'b', view: { end: { why: 'left' } } });
  expect(r.log[n + 3]).toEqual({ to: '*', view: { best: [], runners: ['c'] } });

  r.people.delete('c');
  r.game.onLeave('c', COUNTDOWN_MS + 300);
  expect(r.log[n + 4]).toEqual({ to: '*', view: { best: [], runners: [] } });
  r.game.onLeave('c', COUNTDOWN_MS + 400);
  expect(r.log.length).toBe(n + 5);

  // Nothing to show a newcomer yet; once there is a time, they get the board.
  r.add('d', 'Dung', 0, 0);
  r.game.onJoin!(r.people.get('d')!, 0);
  expect(r.log.length).toBe(n + 5);
  r.game.onAction(a, { k: 'run' }, 10_000);
  r.game.tick!(10_000 + COUNTDOWN_MS + 100);
  r.move('a', FINISH_X + 0.3, MID_Z);
  r.game.tick!(10_000 + COUNTDOWN_MS + 5000); // no finish message at all
  expect(r.notices.length).toBe(1);
  r.log.length = 0;
  r.game.onJoin!(r.people.get('d')!, 0);
  expect(r.log).toEqual([{ to: 'd', view: { best: [{ name: 'Ann', ms: 5000 }], runners: [] } }]);
});

test('regression: a barrier is still somewhere in the lane for a time that is not a number', () => {
  // Found by tests/sim/obstacle.sim.test.ts: sin(Infinity) is NaN, so the barrier was at NaN
  // (and a huge time overflows to Infinity on the way).
  for (const t of [NaN, Infinity, -Infinity, 1e308, -1e308])
    for (const b of BARRIERS) {
      const c = barrierAt(b, t);
      if (!Number.isFinite(t)) expect(c).toEqual(barrierAt(b, 0));
      expect(Number.isFinite(c.x) && Number.isFinite(c.z)).toBe(true);
    }
  expect(barrierHit(START_X, MID_Z, Infinity)).toBe(-1);
});
