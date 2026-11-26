import { expect, test } from 'vitest';
import { FIRE_RANGE, MASTER, STEP_RANGE, falloff, kickLevel, nextMode, parseMode, stepInterval } from '../src/features/sound';

test('sound is full at no distance and gone at the edge of earshot', () => {
  expect(falloff(0, STEP_RANGE)).toBe(1);
  expect(falloff(-1, STEP_RANGE)).toBe(1);
  expect(falloff(STEP_RANGE, STEP_RANGE)).toBe(0);
  expect(falloff(STEP_RANGE + 0.01, STEP_RANGE)).toBe(0);
  expect(falloff(1000, FIRE_RANGE)).toBe(0);
  expect(falloff(15, STEP_RANGE)).toBe(0); // footsteps stop at 14 metres...
  expect(falloff(15, FIRE_RANGE)).toBeGreaterThan(0); // ...the fire carries to 16
});

test('sound only ever gets quieter with distance, and never leaves 0..1', () => {
  let last = 1;
  for (let d = 0; d <= 20; d += 0.25) {
    const v = falloff(d, FIRE_RANGE);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(last);
    last = v;
  }
  expect(falloff(FIRE_RANGE / 2, FIRE_RANGE)).toBeCloseTo(0.25); // half way is a quarter as loud
});

test('nonsense distances are silent rather than loud', () => {
  expect(falloff(NaN, 14)).toBe(0);
  expect(falloff(Infinity, 14)).toBe(0);
  expect(falloff(3, 0)).toBe(0);
  expect(falloff(3, NaN)).toBe(0);
});

test('footsteps come quicker the faster someone moves, within sensible limits', () => {
  expect(stepInterval(0)).toBeCloseTo(0.44);
  expect(stepInterval(2)).toBeCloseTo(0.44);
  expect(stepInterval(8)).toBeCloseTo(0.24);
  expect(stepInterval(50)).toBeCloseTo(0.24);
  expect(stepInterval(7)).toBeLessThan(stepInterval(4.2)); // a sprint against a walk
  let last = Infinity;
  for (let s = 0; s <= 12; s += 0.5) {
    const t = stepInterval(s);
    expect(t).toBeLessThanOrEqual(last);
    expect(t).toBeGreaterThanOrEqual(0.24);
    last = t;
  }
  expect(stepInterval(NaN)).toBeCloseTo(0.44);
  expect(stepInterval(-3)).toBeCloseTo(0.44);
});

test('a harder kick is louder, a tap is still heard, and nothing exceeds full', () => {
  expect(kickLevel(0)).toBeCloseTo(0.3);
  expect(kickLevel(20)).toBeCloseTo(1);
  expect(kickLevel(99)).toBeCloseTo(1);
  expect(kickLevel(15)).toBeGreaterThan(kickLevel(5));
  expect(kickLevel(NaN)).toBeCloseTo(0.3);
});

test('the button goes on, quiet, off and round again', () => {
  expect(nextMode('on')).toBe('quiet');
  expect(nextMode('quiet')).toBe('off');
  expect(nextMode('off')).toBe('on');
  expect(MASTER.on).toBeGreaterThan(MASTER.quiet);
  expect(MASTER.quiet).toBeGreaterThan(0);
  expect(MASTER.off).toBe(0);
});

test('a missing or mangled saved setting means sound on', () => {
  expect(parseMode(null)).toBe('on');
  expect(parseMode('loud')).toBe('on');
  expect(parseMode('quiet')).toBe('quiet');
  expect(parseMode('off')).toBe('off');
});
