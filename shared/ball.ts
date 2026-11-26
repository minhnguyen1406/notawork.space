// Football physics, shared so the server (the authority) and browsers (for smooth motion) agree.
import { GOAL_HALF, PITCH } from './layout';

export interface BallState {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Height of the ball's underside above the grass, and its upward speed. */
  y: number;
  vy: number;
}

export const BALL_R = 0.45;
export const MAX_KICK = 20;
/** The most lift a shot can have, in metres a second upwards. */
export const MAX_LIFT = 8;
/** Height of the crossbar: a ball crossing the line above this is not a goal. */
export const CROSSBAR = 2.3;
const BOUNCE = 0.6;
const GRAVITY = 20;
/** Air resistance, which matters most when the ball is fast. */
const AIR_DRAG = 0.22;
/** Grass slows a rolling ball at a steady rate, so it comes to a definite stop. */
const ROLL_FRICTION = 3.6;

export const centreBall = (): BallState => ({ x: PITCH.cx, z: PITCH.cz, vx: 0, vz: 0, y: 0, vy: 0 });
export const ballMoving = (b: BallState) => b.vx !== 0 || b.vz !== 0 || b.y > 0 || b.vy !== 0;

/** The longest stretch of time worked out in one go. The server steps by exactly this and browsers by less. */
const MAX_STEP = 0.05;
/** A ball always stops well within this many seconds, so a longer jump in time is treated as this. */
const MAX_DT = 60;

/**
 * Advance the ball. Returns which goal it went into, if any.
 * A long step is worked out as several short ones, so a bounce can never gain energy from a slow clock,
 * and a time step that is not a positive number is ignored.
 */
export function stepBall(b: BallState, dt: number): 'west' | 'east' | null {
  if (typeof dt !== 'number' || !(dt > 0)) return null;
  if (dt <= MAX_STEP) return stepOnce(b, dt);
  const total = Math.min(dt, MAX_DT);
  const n = Math.ceil(total / MAX_STEP);
  for (let i = 0; i < n && ballMoving(b); i++) {
    const goal = stepOnce(b, total / n);
    if (goal) return goal;
  }
  return null;
}

function stepOnce(b: BallState, dt: number): 'west' | 'east' | null {
  if (!ballMoving(b)) return null;
  const fromX = b.x;
  const fromZ = b.z;
  b.x += b.vx * dt;
  b.z += b.vz * dt;

  // Up and down: gravity, and a bounce that loses energy each time until it settles.
  const flying = b.y > 0 || b.vy > 0;
  if (flying) {
    b.vy -= GRAVITY * dt;
    b.y += b.vy * dt;
    if (b.y <= 0) {
      b.y = 0;
      if (b.vy < -3) {
        b.vy = -b.vy * 0.5;
        b.vx *= 0.85;
        b.vz *= 0.85;
      } else b.vy = 0;
    }
  }
  const air = Math.exp(-AIR_DRAG * dt);
  b.vx *= air;
  b.vz *= air;
  if (!flying) {
    const speed = Math.hypot(b.vx, b.vz);
    const slower = speed - ROLL_FRICTION * dt;
    if (slower <= 0.05) b.vx = b.vz = 0;
    else {
      b.vx *= slower / speed;
      b.vz *= slower / speed;
    }
  }

  // Side boards
  if (b.z < PITCH.z1 + BALL_R) {
    b.z = PITCH.z1 + BALL_R;
    b.vz = Math.abs(b.vz) * BOUNCE;
  } else if (b.z > PITCH.z2 - BALL_R) {
    b.z = PITCH.z2 - BALL_R;
    b.vz = -Math.abs(b.vz) * BOUNCE;
  }
  // Ends: open at the goal mouth, boards elsewhere.
  const west = PITCH.x1 + BALL_R;
  const east = PITCH.x2 - BALL_R;
  if (b.x < west || b.x > east) {
    const plane = b.x < west ? west : east;
    const wasPast = b.x < west ? fromX < west : fromX > east;
    // A ball that reaches an end during this step is judged by where it was at that moment, so a fast
    // diagonal shot cannot skip round the outside of a post. One already in the mouth came in through it.
    const zThere = wasPast ? fromZ : fromZ + ((b.z - fromZ) * (plane - fromX)) / (b.x - fromX);
    const half = GOAL_HALF - BALL_R * 0.5;
    if (Math.abs(zThere - PITCH.cz) < half && b.y < CROSSBAR) {
      // In the mouth the side netting keeps it between the posts.
      const side = b.z - PITCH.cz;
      if (Math.abs(side) >= half) {
        b.z = PITCH.cz + Math.sign(side) * (half - 1e-6);
        b.vz = -Math.sign(side) * Math.abs(b.vz) * BOUNCE;
      }
      if (b.x < PITCH.x1 - BALL_R) return 'west';
      if (b.x > PITCH.x2 + BALL_R) return 'east';
    } else {
      b.x = plane;
      b.vx = (plane === west ? 1 : -1) * Math.abs(b.vx) * BOUNCE;
    }
  }
  return null;
}
