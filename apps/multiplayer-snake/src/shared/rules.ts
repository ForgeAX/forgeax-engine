import type { Direction } from './commands';

export interface GridCell {
  readonly x: number;
  readonly y: number;
}
export interface SnakeState {
  readonly sessionId: number;
  direction: Direction;
  score: number;
  cells: GridCell[];
  respawnAt: number | null;
}

export const SNAKE_FIXED_DELTA_SECONDS = 1 / 60;
export const SNAKE_MOVE_INTERVAL_SECONDS = 0.1;

export interface SnakeGameState {
  tick: number;
  started?: boolean;
  gameplayTick?: number;
  startedAtGameplayTick?: number;
  lastDirectionCommandPlayerNetworkId?: number;
  lastDirectionCommandGameplayTick?: number;
  nextId: number;
  readonly snakes: Map<number, SnakeState>;
  food: GridCell;
  readonly width: number;
  readonly height: number;
  readonly maxPeers: number;
  seed: number;
  movementAccumulatorSeconds: number;
  readonly movementIntervalSeconds: number;
}

export function tickSimulation(
  state: SnakeGameState,
  fixedDeltaSeconds = SNAKE_FIXED_DELTA_SECONDS,
): void {
  state.tick += 1;
  state.gameplayTick = (state.gameplayTick ?? 0) + 1;
  state.movementAccumulatorSeconds += fixedDeltaSeconds;
  const shouldMove =
    state.movementAccumulatorSeconds + Number.EPSILON >= state.movementIntervalSeconds;
  if (shouldMove) state.movementAccumulatorSeconds -= state.movementIntervalSeconds;

  const next = new Map<number, GridCell>();
  for (const [sessionId, snake] of state.snakes) {
    if (snake.respawnAt !== null) {
      if (snake.respawnAt <= state.tick) respawn(state, snake);
      continue;
    }
    if (!shouldMove) continue;
    next.set(sessionId, advance(snake.cells[0] as GridCell, snake.direction));
  }
  if (!shouldMove) return;

  const occupied = new Set([...state.snakes.values()].flatMap((snake) => snake.cells.map(key)));
  const targets = new Map<string, number[]>();
  for (const [sessionId, cell] of next)
    targets.set(key(cell), [...(targets.get(key(cell)) ?? []), sessionId]);
  for (const [sessionId, cell] of next) {
    const snake = state.snakes.get(sessionId) as SnakeState;
    const collide =
      cell.x < 0 ||
      cell.y < 0 ||
      cell.x >= state.width ||
      cell.y >= state.height ||
      occupied.has(key(cell)) ||
      (targets.get(key(cell))?.length ?? 0) > 1;
    if (collide) {
      snake.cells = [];
      snake.respawnAt = state.tick + 30;
      continue;
    }
    const ate = key(cell) === key(state.food);
    snake.cells.unshift(cell);
    if (ate) {
      snake.score += 1;
      state.food = spawnFood(state);
    } else snake.cells.pop();
  }
}

export function spawnFood(state: SnakeGameState): GridCell {
  const occupied = new Set([...state.snakes.values()].flatMap((snake) => snake.cells.map(key)));
  for (let attempts = 0; attempts < state.width * state.height; attempts += 1) {
    const candidate = { x: random(state) % state.width, y: random(state) % state.height };
    if (!occupied.has(key(candidate))) return candidate;
  }
  return { x: 0, y: 0 };
}

function respawn(state: SnakeGameState, snake: SnakeState): void {
  snake.cells = spawnSnake(state);
  snake.direction = 'right';
  snake.respawnAt = null;
}

function spawnSnake(state: SnakeGameState): GridCell[] {
  const occupied = new Set([...state.snakes.values()].flatMap((snake) => snake.cells.map(key)));
  for (let attempts = 0; attempts < state.width * state.height; attempts += 1) {
    const head = { x: 2 + (random(state) % (state.width - 2)), y: random(state) % state.height };
    const cells = [head, { x: head.x - 1, y: head.y }, { x: head.x - 2, y: head.y }];
    if (cells.every((cell) => !occupied.has(key(cell)))) return cells;
  }
  return [
    { x: 2, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 0 },
  ];
}

function random(state: SnakeGameState): number {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed;
}

function advance(cell: GridCell, direction: Direction): GridCell {
  if (direction === 'up') return { x: cell.x, y: cell.y - 1 };
  if (direction === 'right') return { x: cell.x + 1, y: cell.y };
  if (direction === 'down') return { x: cell.x, y: cell.y + 1 };
  return { x: cell.x - 1, y: cell.y };
}

function key(cell: GridCell): string {
  return `${cell.x},${cell.y}`;
}
