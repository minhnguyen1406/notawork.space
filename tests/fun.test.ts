import { expect, test } from 'vitest';
import { workWord } from '../shared/fun';

test('work talk is caught, in English and Vietnamese, whatever the capitals', () => {
  expect(workWord('ugh I have a MEETING at 9')).toBe('meeting');
  expect(workWord('mai phải họp rồi')).toBe('họp');
  expect(workWord("let's circle back on this")).toBe('circle back');
  expect(workWord('Sếp gọi')).toBe('sếp');
});

test('innocent words that merely contain a work word are left alone', () => {
  expect(workWord('that was a sprinter of a goal')).toBeNull();
  expect(workWord('meetings? never heard of them')).toBeNull(); // only the exact word counts
  expect(workWord('who wants pho')).toBeNull();
  expect(workWord('')).toBeNull();
});
