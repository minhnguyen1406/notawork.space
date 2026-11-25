/** Pick a move for the side to move in this position, or null if there is none. */
export function bestMove(
  fen: string,
  options?: { ms?: number; maxDepth?: number },
): { from: string; to: string; san: string; score: number; depth: number } | null;
