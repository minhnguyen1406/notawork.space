import type { GameId } from '../../shared/minigames';
import type { ClientGame } from './api';
import './base.css';
import { game as dare } from './dare';
import { game as draw } from './draw';
import { game as trivia } from './trivia';
import { game as tag } from './tag';
import { game as hide } from './hide';
import { game as sumo } from './sumo';
import { game as cup } from './cup';
import { game as obstacle } from './obstacle';
import { game as dice } from './dice';
import { game as tienlen } from './tienlen';
import { game as baucua } from './baucua';
import { game as words } from './words';
import { game as cookoff } from './cookoff';

/** Every game's browser side, by id. */
export const CLIENT_GAMES: Record<GameId, ClientGame> = { dare, draw, trivia, tag, hide, sumo, cup, obstacle, dice, tienlen, baucua, words, cookoff };
