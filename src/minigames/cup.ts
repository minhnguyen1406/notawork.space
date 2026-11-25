import type { ClientGame, GameCtx } from './api';

// Not built yet.
let ctx: GameCtx;
export const game: ClientGame = {
  init(c) {
    ctx = c;
  },
  onView() {},
  open() {
    ctx.toast('This game is coming soon.');
  },
};
