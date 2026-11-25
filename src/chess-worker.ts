// Claude's chess thinking, off the main thread so the room keeps moving while it works.
import { bestMove } from '../tools/chess-engine.mjs';

self.onmessage = (e: MessageEvent<{ fen: string }>) => {
  const move = bestMove(e.data.fen, { ms: 1800, maxDepth: 4 });
  self.postMessage({ fen: e.data.fen, move });
};
