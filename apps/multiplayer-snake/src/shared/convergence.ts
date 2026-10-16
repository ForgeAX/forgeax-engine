import type { SnakeGameState } from './rules';

export function semanticSnapshot(state: SnakeGameState) {
  return {
    tick: state.tick,
    food: { ...state.food },
    snakes: [...state.snakes.values()]
      .sort((left, right) => left.sessionId - right.sessionId)
      .map((snake) => ({
        sessionId: snake.sessionId,
        direction: snake.direction,
        score: snake.score,
        cells: snake.cells.map((cell) => ({ ...cell })),
      })),
  };
}
