// The party games added on top of the room. Each one lives in its own files:
//   shared/minigames/<id>.ts      rules and the types of its messages (no browser or server code)
//   worker/src/minigames/<id>.ts  the server side, which decides everything
//   src/minigames/<id>.ts (+.css) what the browser shows
//   tests/minigames/<id>.test.ts  rule tests
// and is listed once in each registry (worker/src/minigames/registry.ts, src/minigames/registry.ts).

export const GAME_IDS = ['dare', 'draw', 'trivia', 'tag', 'hide', 'sumo', 'cup', 'obstacle', 'dice', 'tienlen', 'baucua', 'words', 'cookoff', 'tube', 'board'] as const;
export type GameId = (typeof GAME_IDS)[number];

/** Where each game's signpost stands. Walk up and press E to open the game. */
export const GAME_SPOTS: Record<GameId, { x: number; z: number; title: string }> = {
  dare: { x: -9, z: 18.5, title: 'Truth or dare' },
  tag: { x: -6, z: 18.5, title: 'Tag' },
  hide: { x: -3, z: 18.5, title: 'Hide and seek' },
  dice: { x: 0, z: 18.5, title: "Liar's dice" },
  tienlen: { x: 3, z: 18.5, title: 'Tiến lên' },
  baucua: { x: 6, z: 18.5, title: 'Bầu cua' },
  words: { x: -12, z: 18.5, title: 'Word clues' },
  draw: { x: -33, z: -16.6, title: 'Draw and guess' },
  trivia: { x: -8.4, z: -1.6, title: 'Trivia night' },
  sumo: { x: -15, z: -2.4, title: 'Sumo ring' },
  cup: { x: -6, z: 22.2, title: 'Football match' },
  obstacle: { x: 8.2, z: 16.5, title: 'Obstacle dash' },
  cookoff: { x: 9.4, z: 9.6, title: 'Cook-off' },
  tube: { x: 8.6, z: -9.5, title: 'Play a video' },
  board: { x: -20.5, z: -14.5, title: 'Leaderboards' },
};

/** Fixed patches of roof set aside for games that need room. */
export const GAME_ZONES = {
  /** Sumo: a circle. */
  sumo: { x: -15, z: -8.6, r: 4.4 },
  /** Obstacle dash: a lane running west to east. */
  obstacle: { x1: 9.2, x2: 19.4, z1: 13.4, z2: 19.6 },
  /** Draw and guess: the board hangs on the north wall here, facing south. */
  drawBoard: { x: -33, y: 3.3, z: -19.5, w: 7.2, h: 4.2 },
  /** Leaderboards: a board on the north wall between the drawing board and the work-talk sign, facing south. */
  leaderBoard: { x: -27.6, y: 3.2, z: -19.5, w: 3.4, h: 4.2 },
};
