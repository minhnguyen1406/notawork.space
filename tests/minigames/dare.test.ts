import { expect, test } from 'vitest';
import { CHOOSE_MS, DARES, TRUTHS, dareChoose, dareJoin, dareLeave, dareSpin, dareTick, dareView, newDare } from '../../shared/minigames/dare';

const ann = { id: 'a', name: 'Ann' };
const bao = { id: 'b', name: 'Bao' };
const chi = { id: 'c', name: 'Chi' };
const three = () => {
  const g = newDare();
  for (const p of [ann, bao, chi]) dareJoin(g, p);
  return g;
};

test('joining twice does nothing, and it takes two to spin', () => {
  const g = newDare();
  expect(dareJoin(g, ann)).toBe(true);
  expect(dareJoin(g, ann)).toBe(false);
  expect(dareSpin(g, 'a', 0)).toBe(false);
  dareJoin(g, bao);
  expect(dareSpin(g, 'a', 0)).toBe(true);
});

test('only someone playing can spin, and not while a choice is pending', () => {
  const g = three();
  expect(dareSpin(g, 'zed', 0)).toBe(false);
  expect(dareSpin(g, 'a', 0, () => 0.5)).toBe(true);
  expect(g.picked).toBe('b');
  expect(dareSpin(g, 'c', 1)).toBe(false);
});

test('only the person picked chooses, and gets a prompt of the kind they asked for', () => {
  const g = three();
  dareSpin(g, 'a', 0, () => 0);
  expect(dareChoose(g, 'b', 'dare')).toBe(false); // not their turn
  expect(dareChoose(g, 'a', 'nonsense')).toBe(false);
  expect(dareChoose(g, 'a', 'dare', () => 0)).toBe(true);
  expect(g.phase).toBe('prompt');
  expect(DARES).toContain(g.prompt);
});

test('no answer in time means truth', () => {
  const g = three();
  dareSpin(g, 'a', 0, () => 0);
  expect(dareTick(g, CHOOSE_MS - 1)).toBe(false);
  expect(dareTick(g, CHOOSE_MS)).toBe(true);
  expect(g.kind).toBe('truth');
  expect(TRUTHS).toContain(g.prompt);
});

test('prompts do not repeat until the list has been used up', () => {
  const g = three();
  const seen = new Set<string>();
  for (let i = 0; i < TRUTHS.length; i++) {
    dareSpin(g, 'a', i, () => 0);
    dareChoose(g, 'a', 'truth');
    seen.add(g.prompt!);
  }
  expect(seen.size).toBe(TRUTHS.length);
  dareSpin(g, 'a', 99, () => 0);
  expect(dareChoose(g, 'a', 'truth')).toBe(true); // starts over rather than running dry
});

test('the picked person leaving, or too few left, returns to the lobby', () => {
  const g = three();
  dareSpin(g, 'a', 0, () => 0);
  dareLeave(g, 'a');
  expect(g.phase).toBe('lobby');
  expect(g.picked).toBeNull();
  dareLeave(g, 'b');
  expect(dareSpin(g, 'c', 0)).toBe(false);
});

test('the view counts down the time left to choose', () => {
  const g = three();
  dareSpin(g, 'a', 1000, () => 0);
  expect(dareView(g, 1000 + 4000).left).toBe(CHOOSE_MS - 4000);
  expect(dareView(g, 1000 + CHOOSE_MS * 2).left).toBe(0);
});
