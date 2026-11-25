// Football physics, shared so the server (the authority) and browsers (for smooth motion) agree.
import { GOAL_HALF, PITCH } from './layout';

export interface BallState {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

export const BALL_R = 0.45;
export const MAX_KICK = 16;
const BOUNCE = 0.7;
const DRAG = 0.9;

export const centreBall = (): BallState => ({ x: PITCH.cx, z: PITCH.cz, vx: 0, vz: 0 });
export const ballMoving = (b: BallState) => b.vx !== 0 || b.vz !== 0;

/** Advance the ball. Returns which goal it went into, if any. */
export function stepBall(b: BallState, dt: number): 'west' | 'east' | null {
  if (!ballMoving(b)) return null;
  b.x += b.vx * dt;
  b.z += b.vz * dt;
  const k = Math.exp(-DRAG * dt);
  b.vx *= k;
  b.vz *= k;
  if (Math.hypot(b.vx, b.vz) < 0.25) b.vx = b.vz = 0;

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
    if (inMouth) {
      if (b.x < PITCH.x1 - BALL_R) return 'west';
    } else {
      b.x = PITCH.x1 + BALL_R;
      b.vx = Math.abs(b.vx) * BOUNCE;
    }
  } else if (b.x > PITCH.x2 - BALL_R) {
    if (inMouth) {
      if (b.x > PITCH.x2 + BALL_R) return 'east';
    } else {
      b.x = PITCH.x2 - BALL_R;
      b.vx = -Math.abs(b.vx) * BOUNCE;
    }
  }
  return null;
}
