import { expect, test } from 'vitest';
import { BOUNDS, CENTRE, SCREEN, PITCH } from '../shared/layout';
import { largeMapWidth, mapHeight, nextMode, worldToMap, yawToMapAngle } from '../src/features/minimap';

const W = 190;

test('the corners of the roof are the corners of the map', () => {
  const h = mapHeight(W);
  expect(worldToMap(BOUNDS.x1, BOUNDS.z1, W)).toEqual({ x: 0, y: 0 }); // north-west: top left
  expect(worldToMap(BOUNDS.x2, BOUNDS.z1, W)).toEqual({ x: W, y: 0 }); // north-east: top right
  expect(worldToMap(BOUNDS.x1, BOUNDS.z2, W)).toEqual({ x: 0, y: h }); // south-west: bottom left
  expect(worldToMap(BOUNDS.x2, BOUNDS.z2, W)).toEqual({ x: W, y: h }); // south-east: bottom right
});

test('the centre of the roof is the centre of the map', () => {
  const p = worldToMap(CENTRE.x, CENTRE.z, W);
  expect(p.x).toBeCloseTo(W / 2);
  expect(p.y).toBeCloseTo(mapHeight(W) / 2);
});

test('the map keeps the proportions of the roof', () => {
  const roof = (BOUNDS.z2 - BOUNDS.z1) / (BOUNDS.x2 - BOUNDS.x1);
  expect(mapHeight(W) / W).toBeCloseTo(roof);
  expect(mapHeight(600) / 600).toBeCloseTo(roof);
  // A roof twice as deep as it is wide makes a map twice as tall as it is wide.
  const tall = { x1: 0, x2: 10, z1: -10, z2: 10 };
  expect(mapHeight(100, tall)).toBe(200);
  expect(worldToMap(10, 10, 100, tall)).toEqual({ x: 100, y: 200 });
  expect(worldToMap(5, 0, 100, tall)).toEqual({ x: 50, y: 100 });
});

test('one metre is the same number of pixels east as south', () => {
  const a = worldToMap(0, 0, W);
  const east = worldToMap(1, 0, W);
  const south = worldToMap(0, 1, W);
  expect(east.x - a.x).toBeCloseTo(south.y - a.y);
  expect(east.y).toBeCloseTo(a.y);
  expect(south.x).toBeCloseTo(a.x);
  // And it scales with the width of the map.
  expect(worldToMap(1, 0, W * 2).x - worldToMap(0, 0, W * 2).x).toBeCloseTo((east.x - a.x) * 2);
});

test('north is up: the cinema is above the pitch, and east is right', () => {
  const cinema = worldToMap(SCREEN.x, SCREEN.z, W);
  const pitch = worldToMap(PITCH.cx, PITCH.cz, W);
  expect(cinema.y).toBeLessThan(pitch.y);
  expect(cinema.x).toBeGreaterThan(pitch.x); // the pitch is west of the screen
});

test('the camera wedge points the way the camera looks', () => {
  const dir = (yaw: number) => ({ x: Math.cos(yawToMapAngle(yaw)), y: Math.sin(yawToMapAngle(yaw)) });
  // Walking forward moves by (-sin yaw, -cos yaw) in the room, so yaw 0 is north: up the map.
  expect(dir(0).x).toBeCloseTo(0);
  expect(dir(0).y).toBeCloseTo(-1);
  expect(dir(Math.PI / 2).x).toBeCloseTo(-1); // west: left
  expect(dir(Math.PI).y).toBeCloseTo(1); // south: down
  expect(dir(-Math.PI / 2).x).toBeCloseTo(1); // east: right
});

test('the large map is about 70% of the window height but never wider than the screen', () => {
  expect(mapHeight(largeMapWidth(1600, 1000))).toBeCloseTo(700, 0);
  expect(largeMapWidth(400, 1000)).toBeLessThanOrEqual(400);
});

test('N goes small, large, hidden and round again', () => {
  expect(nextMode('small')).toBe('large');
  expect(nextMode('large')).toBe('hidden');
  expect(nextMode('hidden')).toBe('small');
});
