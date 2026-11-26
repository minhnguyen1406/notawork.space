import { newTube, tubeAllow, tubeLeave, tubePause, tubePlay, tubeResume, tubeSeek, tubeStop, tubeTick, tubeView, type TubeView } from '../../../shared/minigames/tube';
import type { GameFactory } from './api';

/** Play a video, server side. It holds what is on and where it has got to; browsers only follow. */
export const create: GameFactory = (io) => {
  const g = newTube();
  const publish = (now: number) => io.broadcast(tubeView(g, now));
  /** Tell one person why nothing happened, along with the state as it stands. */
  const refuse = (id: string, err: TubeView['err'], now: number) => io.send(id, { ...tubeView(g, now), err });

  return {
    onAction(p, a, now) {
      // It is a room of friends, so anyone may drive, but not faster than a person would.
      if (!tubeAllow(g, p.id, now)) return refuse(p.id, 'slow', now);
      let changed = false;
      if (a.k === 'play') {
        // Only the checked id is kept: the text the browser sent goes no further than this line.
        changed = tubePlay(g, p, a.link, now);
        if (!changed) return refuse(p.id, 'link', now);
        io.notice(`${p.name} put a video on`);
      } else if (a.k === 'pause') changed = tubePause(g, now);
      else if (a.k === 'resume') changed = tubeResume(g, now);
      else if (a.k === 'seek') changed = tubeSeek(g, a.t, now);
      else if (a.k === 'stop') changed = tubeStop(g);
      if (changed) publish(now);
    },
    onLeave(id, now) {
      const ids = io.players().map((p) => p.id);
      if (tubeLeave(g, id, ids)) publish(now);
    },
    onJoin(p, now) {
      // A newcomer only needs to hear about a video that is on.
      if (g.id) io.send(p.id, tubeView(g, now));
    },
    tick(now) {
      if (tubeTick(g, now)) publish(now);
    },
  };
};
