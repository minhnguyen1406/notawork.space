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

// ---- regressions found by tests/sim/ball.sim.test.ts

test('regression: a lifted ball still settles when the clock moves in big steps', () => {
  const b = centreBall();
  b.y = 2; // dropped from head height
  for (let i = 0; i < 200 && ballMoving(b); i++) stepBall(b, 0.5); // 100 seconds of half-second steps
  expect(b.y).toBe(0);
  expect(ballMoving(b)).toBe(false);
});

test('regression: a nonsense time step is ignored', () => {
  for (const dt of [NaN, -1, 0, -Infinity]) {
    const b = centreBall();
    b.vx = 5;
    b.vy = 3;
    const before = { ...b };
    expect(stepBall(b, dt)).toBeNull();
    expect(b).toEqual(before);
  }
  const b = centreBall();
  b.vx = 5;
  b.vy = 3;
  stepBall(b, Infinity);
  expect(Object.values(b).every(Number.isFinite)).toBe(true);
  expect(ballMoving(b)).toBe(false);
});

test('regression: a fast diagonal shot that crosses the line just outside the post is not a goal', () => {
  // With the server's 0.05 s step the ball used to skip past the corner of the post: it was outside the
  // mouth when it reached the line, but inside by the end of the step, and was waved through.
  for (const side of [-1, 1]) {
    const b = centreBall();
    b.x = side < 0 ? PITCH.x1 + 0.45 + 0.1 : PITCH.x2 - 0.45 - 0.1;
    b.z = PITCH.cz - 3.075; // 0.3 m wide of the opening
    b.vx = 18 * side;
    b.vz = 8;
    let goal: string | null = null;
    for (let i = 0; i < 40 && !goal; i++) goal = stepBall(b, 0.05);
    expect(goal).toBeNull();
    expect(b.x).toBeGreaterThanOrEqual(PITCH.x1 + 0.45);
    expect(b.x).toBeLessThanOrEqual(PITCH.x2 - 0.45);
  }
});

test('regression: a ball in the goal mouth is kept between the posts instead of jumping back onto the pitch', () => {
  const b = centreBall();
  b.x = PITCH.x1 - 0.3; // lying most of the way over the west goal line
  b.vz = 12; // and knocked sideways, towards the post
  let goal: string | null = null;
  let jump = 0;
  for (let i = 0; i < 200 && ballMoving(b) && !goal; i++) {
    const x = b.x;
    goal = stepBall(b, 0.05);
    jump = Math.max(jump, Math.abs(b.x - x));
  }
  expect(goal).toBeNull();
  expect(jump).toBe(0); // it used to leap 0.75 m out to the front of the goal
  expect(Math.abs(b.z - PITCH.cz)).toBeLessThan(3);
});
