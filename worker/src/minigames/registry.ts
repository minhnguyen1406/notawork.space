import type { GameId } from '../../../shared/minigames';
import type { GameFactory } from './api';
import { create as dare } from './dare';
import { create as draw } from './draw';
import { create as trivia } from './trivia';
import { create as tag } from './tag';
import { create as hide } from './hide';
import { create as sumo } from './sumo';
import { create as cup } from './cup';
import { create as obstacle } from './obstacle';
import { create as dice } from './dice';
import { create as tienlen } from './tienlen';
import { create as baucua } from './baucua';
import { create as words } from './words';
import { create as cookoff } from './cookoff';

/** Every game's server side, by id. */
export const SERVER_GAMES: Record<GameId, GameFactory> = { dare, draw, trivia, tag, hide, sumo, cup, obstacle, dice, tienlen, baucua, words, cookoff };
