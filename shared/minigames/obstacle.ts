// Obstacle dash: a timed solo run down a lane of sliding barriers, with a shared board of best times.
// Rules only: no browser or server code in this file.
import { GAME_ZONES } from '../minigames';

export const LANE = GAME_ZONES.obstacle;
/** The start and finish lines, a little in from the two ends of the lane. */
export const START_X = LANE.x1 + 0.8;
export const FINISH_X = LANE.x2 - 0.8;
export const MID_Z = (LANE.z1 + LANE.z2) / 2;
/** Top speed on foot (the room's running speed), in metres a second. */
export const RUN_SPEED = 8.5;
/** How wide a person is, for touching a barrier. */
export const BODY = 0.38;
/** The 3-2-1 before the clock starts. */
export const COUNTDOWN_MS = 3000;
/** A run nobody finishes is dropped after this long, so nothing waits on an idle player. */
export const MAX_RUN_MS = 90_000;
/** The server hears positions a few times a second, so its record may trail the runner by this much. */
export const FINISH_SLACK = 0.9;
/** How far over a kerb still counts as in the lane. */
export const LANE_MARGIN = 0.5;
/** Moving further than this from the start line during the countdown is a false start. */
export const FALSE_START = 1.2;
/** Nobody can cover the course faster than a straight line at full speed. */
export const MIN_RUN_MS = Math.floor(((FINISH_X - START_X - FINISH_SLACK) / RUN_SPEED) * 1000);
export const BOARD_SIZE = 5;

/** A barrier: a box that slides back and forth along one axis. Sizes are half-widths, in metres. */
export interface Barrier {
  /** 'z' sweeps north-south across the lane, 'x' slides east-west along it. */
  axis: 'x' | 'z';
  /** The middle of its travel. */
  x: number;
  z: number;
  hw: number;
  hd: number;
  /** How far it travels either side of the middle. */
  amp: number;
  /** Seconds for one trip there and back. */
  period: number;
  /** Where in its trip it is when the clock starts, 0 to 1. */
  phase: number;
  color: string;
}

const SWEEP_HD = 1.3;
const sweep = (x: number, period: number, phase: number, color: string): Barrier => ({
  axis: 'z', x, z: MID_Z, hw: 0.2, hd: SWEEP_HD, amp: (LANE.z2 - LANE.z1) / 2 - SWEEP_HD, period, phase, color,
});
const SLIDE_HW = 0.7;
const slide = (z: number, period: number, phase: number, color: string): Barrier => ({
  axis: 'x', x: (START_X + FINISH_X) / 2, z, hw: SLIDE_HW, hd: 0.2, amp: (FINISH_X - START_X) / 2 - SLIDE_HW - 1.2, period, phase, color,
});

/** Five sweepers across the lane and two sliders along it. The start and finish lines are always clear. */
export const BARRIERS: Barrier[] = [
  sweep(START_X + 1.4, 2.6, 0, '#ff5d5d'),
  sweep(START_X + 2.9, 3.4, 0.3, '#ffb347'),
  sweep(START_X + 4.4, 2.2, 0.55, '#3ddc97'),
  sweep(START_X + 5.9, 3.0, 0.15, '#4cc9f0'),
  sweep(START_X + 7.4, 1.9, 0.7, '#c77dff'),
  slide(MID_Z - 1.5, 5.2, 0, '#ffe066'),
  slide(MID_Z + 1.5, 6.4, 0.5, '#ff8fab'),
];

export interface Box {
  x: number;
  z: number;
  hw: number;
  hd: number;
}

/**
 * Where a barrier is `t` seconds after the run's clock started (negative during the countdown).
 * A pure function, so every browser and the server agree on it.
 */
export function barrierAt(b: Barrier, t: number): Box {
  const off = b.amp * Math.sin(2 * Math.PI * (t / b.period + b.phase));
  return { x: b.axis === 'x' ? b.x + off : b.x, z: b.axis === 'z' ? b.z + off : b.z, hw: b.hw, hd: b.hd };
}

/** Which barrier (its index) someone standing at (x, z) is touching at time `t`, or -1. */
export function barrierHit(x: number, z: number, t: number, body = BODY): number {
  return BARRIERS.findIndex((b) => {
    const c = barrierAt(b, t);
    // Nearest point of the box to the person's middle.
    const dx = Math.max(Math.abs(x - c.x) - c.hw, 0);
    const dz = Math.max(Math.abs(z - c.z) - c.hd, 0);
    return dx * dx + dz * dz < body * body;
  });
}

export const inLane = (x: number, z: number, margin = LANE_MARGIN) =>
  x >= LANE.x1 - margin && x <= LANE.x2 + margin && z >= LANE.z1 - margin && z <= LANE.z2 + margin;

export interface ObstacleRun {
  id: string;
  name: string;
  /** When the clock starts (server clock): the moment the countdown ends. */
  go: number;
  /** Whether the false-start check at "go" has been done. */
  off: boolean;
}

export interface ObstacleGame {
  /** Everyone running now. Each has their own clock. */
  runs: ObstacleRun[];
  /** The best times, fastest first, one per player name. */
  best: { name: string; ms: number }[];
}

export const newObstacle = (): ObstacleGame => ({ runs: [], best: [] });

/** Start a run. The caller (the server) also moves the player to the start line. */
export function obstacleStart(g: ObstacleGame, p: { id: string; name: string; seat?: string | null }, now: number): boolean {
  if (p.seat || g.runs.some((r) => r.id === p.id)) return false;
  g.runs.push({ id: p.id, name: p.name, go: now + COUNTDOWN_MS, off: false });
  return true;
}

/** Stop pressed, or the runner left the room. Returns true if there was a run to cancel. */
export function obstacleStop(g: ObstacleGame, id: string): boolean {
  const i = g.runs.findIndex((r) => r.id === id);
  if (i < 0) return false;
  g.runs.splice(i, 1);
  return true;
}

/** Put a time on the board if it beats that name's own best. */
export function obstacleRecord(g: ObstacleGame, name: string, ms: number): { rank: number; record: boolean } {
  const old = g.best.find((b) => b.name === name);
  if (!old || ms < old.ms) {
    g.best = [...g.best.filter((b) => b !== old), { name, ms }].sort((a, b) => a.ms - b.ms).slice(0, BOARD_SIZE);
    const rank = g.best.findIndex((b) => b.name === name && b.ms === ms) + 1;
    return { rank, record: rank === 1 };
  }
  return { rank: 0, record: false };
}

export type ObstacleEnd =
  /** Crossed the line. `rank` is the new place on the board (0 if it didn't make it), `record` a new best of all. */
  | { why: 'finish'; ms: number; rank: number; record: boolean }
  | { why: 'stop' | 'left' | 'false-start' | 'too-fast' | 'timeout' };

/**
 * The runner says they crossed the finish line. `pos` is the server's own record of where they are,
 * and the time is the server's own. Returns how the run ended, or null if it carries on (no run,
 * still counting down, or not at the east end yet).
 */
export function obstacleFinish(g: ObstacleGame, id: string, pos: { x: number; z: number } | null | undefined, now: number): ObstacleEnd | null {
  const run = g.runs.find((r) => r.id === id);
  if (!run || !pos || now < run.go) return null;
  if (pos.x < FINISH_X - FINISH_SLACK || !inLane(pos.x, pos.z)) return null;
  obstacleStop(g, id);
  const ms = Math.round(now - run.go);
  if (ms < MIN_RUN_MS) return { why: 'too-fast' };
  return { why: 'finish', ms, ...obstacleRecord(g, run.name, ms) };
}

/**
 * Time passing. `where` gives the server's record of each player's position (missing if they have
 * gone). Returns every run that ended on this tick.
 */
export function obstacleTick(g: ObstacleGame, where: (id: string) => { x: number; z: number; seat?: string | null } | null | undefined, now: number): { id: string; name: string; end: ObstacleEnd }[] {
  const out: { id: string; name: string; end: ObstacleEnd }[] = [];
  for (const run of [...g.runs]) {
    const pos = where(run.id);
    let end: ObstacleEnd | null = null;
    if (!pos) end = { why: 'left' };
    // Positions are only judged once the clock is running: just after the server moves someone to
    // the start, its record of them can still be the spot they pressed Run from.
    else if (now < run.go) continue;
    else if (!run.off) {
      run.off = true;
      if (pos.x > START_X + FALSE_START) end = { why: 'false-start' };
    }
    if (!end && pos) {
      if (pos.seat || !inLane(pos.x, pos.z)) end = { why: 'left' };
      else if (now - run.go > MAX_RUN_MS) end = { why: 'timeout' };
      // The finish message may have been lost or come before the position did: finish them here.
      else if (pos.x >= FINISH_X) end = obstacleFinish(g, run.id, pos, now);
    }
    if (!end) continue;
    obstacleStop(g, run.id);
    out.push({ id: run.id, name: run.name, end });
  }
  return out;
}

/** What everyone sees. A runner is also sent `start` when their run begins and `end` when it is over. */
export interface ObstacleView {
  best: { name: string; ms: number }[];
  /** Ids of the people running now. */
  runners: string[];
  /** Only to the runner: the clock now, in ms since "go" (negative during the countdown). */
  start?: { t: number };
  /** Only to the runner: how their run ended. */
  end?: ObstacleEnd;
}

export const obstacleView = (g: ObstacleGame): ObstacleView => ({ best: g.best, runners: g.runs.map((r) => r.id) });

/** 12345 ms reads as "12.35". */
export const fmtTime = (ms: number) => (Math.max(0, ms) / 1000).toFixed(2);

/** What a browser may send. */
export type ObstacleAction = { k: 'run' } | { k: 'finish' } | { k: 'stop' };
