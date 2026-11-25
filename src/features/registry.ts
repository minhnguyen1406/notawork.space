import type { Feature } from './api';
import { feature as touch } from './touch';
import { feature as sound } from './sound';
import { feature as minimap } from './minimap';
import { feature as photo } from './photo';
import { feature as quality } from './quality';

/** Add-on features, each in its own file. */
export const FEATURES: Record<string, Feature> = { touch, sound, minimap, photo, quality };
