import {
  COUNTDOWN_MS,
  MID_Z,
  START_X,
  fmtTime,
  newObstacle,
  obstacleFinish,
  obstacleStart,
  obstacleStop,
  obstacleTick,
  obstacleView,
  type ObstacleEnd,
} from '../../../shared/minigames/obstacle';
import type { GameFactory } from './api';

/** Obstacle dash, server side. It starts every clock, measures every time and keeps the board. */
export const create: GameFactory = (io) => {
  const g = newObstacle();
  const where = (id: string) => io.players().find((p) => p.id === id);

  /** A run is over: tell the runner how, then everyone the new board and who is still running. */
  const ended = (id: string, name: string, end: ObstacleEnd) => {
    io.send(id, { ...obstacleView(g), end });
    if (end.why === 'finish' && end.record) io.notice(`${name} set a new best on the obstacle dash: ${fmtTime(end.ms)}s`);
    io.broadcast(obstacleView(g));
  };

  return {
    onAction(p, a, now) {
      if (a.k === 'run') {
        if (!obstacleStart(g, p, now)) return;
        io.put(p.id, START_X, MID_Z);
        io.send(p.id, { ...obstacleView(g), start: { t: -COUNTDOWN_MS } });
        io.broadcast(obstacleView(g));
      } else if (a.k === 'finish') {
        // Nothing in the message is used: the position and the time are the server's own.
        const end = obstacleFinish(g, p.id, where(p.id), now);
        if (end) ended(p.id, p.name, end);
      } else if (a.k === 'stop') {
        if (obstacleStop(g, p.id)) ended(p.id, p.name, { why: 'stop' });
      }
    },
    onLeave(id) {
      if (obstacleStop(g, id)) io.broadcast(obstacleView(g));
    },
    onJoin(p) {
      // The board is worth seeing even when nobody is running.
      if (g.best.length || g.runs.length) io.send(p.id, obstacleView(g));
    },
    tick(now) {
      if (!g.runs.length) return;
      for (const e of obstacleTick(g, where, now)) ended(e.id, e.name, e.end);
    },
  };
};
