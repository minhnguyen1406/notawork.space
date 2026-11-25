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

/** Advance the ball. Returns which goal it went into, if any. */
export function stepBall(b: BallState, dt: number): 'west' | 'east' | null {
  if (!ballMoving(b)) return null;
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
  // Ends: open at the goal mouth, boards elsewhere
  const inMouth = Math.abs(b.z - PITCH.cz) < GOAL_HALF - BALL_R * 0.5;
  if (b.x < PITCH.x1 + BALL_R) {
    if (inMouth && b.y < CROSSBAR) {
      if (b.x < PITCH.x1 - BALL_R) return 'west';
    } else {
      b.x = PITCH.x1 + BALL_R;
      b.vx = Math.abs(b.vx) * BOUNCE;
    }
  } else if (b.x > PITCH.x2 - BALL_R) {
    if (inMouth && b.y < CROSSBAR) {
      if (b.x > PITCH.x2 + BALL_R) return 'east';
    } else {
      b.x = PITCH.x2 - BALL_R;
      b.vx = -Math.abs(b.vx) * BOUNCE;
    }
  }
  return null;
}
