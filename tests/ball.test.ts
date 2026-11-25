import { expect, test } from 'vitest';
import { CROSSBAR, ballMoving, centreBall, stepBall } from '../shared/ball';
import { PITCH } from '../shared/layout';

const run = (b: ReturnType<typeof centreBall>, seconds: number) => {
  let goal: string | null = null;
  let peak = 0;
  for (let i = 0; i < seconds * 60 && ballMoving(b); i++) {
    goal = stepBall(b, 1 / 60) ?? goal;
    peak = Math.max(peak, b.y);
    if (goal) break;
  }
  return { goal, peak };
};

test('a rolling ball slows steadily and comes to a complete stop', () => {
  const b = centreBall();
  b.vx = 6;
  run(b, 10);
  expect(ballMoving(b)).toBe(false);
  const rolled = b.x - PITCH.cx;
  expect(rolled).toBeGreaterThan(3); // a pass travels a useful distance
  expect(rolled).toBeLessThan(7); // but does not slide on for ever
});

test('a gentle touch only nudges it', () => {
  const b = centreBall();
  b.vx = 2;
  run(b, 5);
  expect(b.x - PITCH.cx).toBeLessThan(1.2);
});

test('a lifted shot rises, comes down, bounces lower each time and settles', () => {
  const b = centreBall();
  b.vz = 3;
  b.vy = 7;
  const { peak } = run(b, 10);
  expect(peak).toBeGreaterThan(0.9);
  expect(peak).toBeLessThan(2);
  expect(b.y).toBe(0);
  expect(ballMoving(b)).toBe(false);
});

test('a low shot into the goal mouth scores', () => {
  const b = centreBall();
  b.x = PITCH.x2 - 4;
  b.vx = 14;
  expect(run(b, 3).goal).toBe('east');
});

test('a shot over the bar does not score and stays in play', () => {
  const b = centreBall();
  b.x = PITCH.x2 - 1.2;
  b.y = CROSSBAR + 0.6;
  b.vy = 2;
  b.vx = 14;
  expect(run(b, 0.3).goal).toBeNull();
  expect(b.x).toBeLessThanOrEqual(PITCH.x2);
  expect(b.vx).toBeLessThan(0); // it came back off the netting
});

test('the ball never leaves the pitch except through a goal mouth', () => {
  for (let i = 0; i < 200; i++) {
    const b = centreBall();
    const a = (i / 200) * Math.PI * 2;
    b.vx = Math.cos(a) * 19;
    b.vz = Math.sin(a) * 19;
    b.vy = (i % 5) * 1.5;
    const { goal } = run(b, 12);
    if (!goal) {
      // It may come to rest on a goal line, half over it.
      expect(b.x).toBeGreaterThanOrEqual(PITCH.x1 - 0.45);
      expect(b.x).toBeLessThanOrEqual(PITCH.x2 + 0.45);
      expect(b.z).toBeGreaterThanOrEqual(PITCH.z1);
      expect(b.z).toBeLessThanOrEqual(PITCH.z2);
      expect(ballMoving(b)).toBe(false);
    }
  }
});
