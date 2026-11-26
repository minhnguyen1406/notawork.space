import { FULL_N, boardApply, boardFlush, boardView, newTallies } from '../../../shared/minigames/board';
import type { GameFactory } from './api';

/** Leaderboards, server side. It only listens: tallies change through room events, never through a browser. */
export const create: GameFactory = (io) => {
  // Kept in memory only, so the tables start again whenever the room restarts.
  const t = newTallies();

  return {
    onAction(p, a) {
      // The one thing a browser can ask for: the longer tables, sent to that person alone.
      if (a.k === 'full') io.send(p.id, boardView(t, FULL_N));
    },
    onLeave() {},
    onJoin(p) {
      io.send(p.id, boardView(t));
    },
    tick(now) {
      // A burst of events (a busy kitchen) becomes one broadcast a second at most.
      if (boardFlush(t, now)) io.broadcast(boardView(t));
    },
    onEvent(e) {
      boardApply(t, e);
    },
  };
};
