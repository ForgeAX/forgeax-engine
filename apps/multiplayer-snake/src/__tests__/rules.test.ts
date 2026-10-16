import { describe, expect, it } from 'vitest';
import { SNAKE_MOVE_INTERVAL_SECONDS, type SnakeGameState, tickSimulation } from '../shared/rules';

const state = (): SnakeGameState => ({
  tick: 0,
  nextId: 3,
  snakes: new Map([
    [1, { sessionId: 1, direction: 'right', score: 0, cells: [{ x: 1, y: 1 }], respawnAt: null }],
  ]),
  food: { x: 2, y: 1 },
  width: 8,
  height: 8,
  maxPeers: 4,
  seed: 1,
  movementAccumulatorSeconds: SNAKE_MOVE_INTERVAL_SECONDS,
  movementIntervalSeconds: SNAKE_MOVE_INTERVAL_SECONDS,
});

describe('Snake deterministic rules', () => {
  it('moves, eats food, and grows deterministically', () => {
    const game = state();
    tickSimulation(game);
    expect(game.snakes.get(1)).toMatchObject({
      score: 1,
      cells: [
        { x: 2, y: 1 },
        { x: 1, y: 1 },
      ],
    });
  });

  it('moves at the game cadence instead of every authority tick', () => {
    const game = state();
    tickSimulation(game);
    const afterFirstMove = game.snakes.get(1)?.cells[0];
    expect(afterFirstMove).toEqual({ x: 2, y: 1 });
    for (let index = 0; index < 4; index += 1) tickSimulation(game);
    expect(game.snakes.get(1)?.cells[0]).toEqual(afterFirstMove);
    tickSimulation(game);
    expect(game.snakes.get(1)?.cells[0]).toEqual({ x: 3, y: 1 });
  });

  it('kills a snake on wall collision and respawns it after 30 ticks', () => {
    const game = state();
    const snake = game.snakes.get(1);
    if (snake === undefined) throw new Error('test setup');
    snake.cells = [{ x: 7, y: 1 }];
    for (let index = 0; index < 5; index += 1) tickSimulation(game);
    expect(snake.respawnAt).toBe(31);
    for (let index = 0; index < 30; index += 1) tickSimulation(game);
    expect(snake.respawnAt).toBeNull();
    expect(snake.cells).toHaveLength(3);
  });

  it('kills both snakes that enter the same cell', () => {
    const game = state();
    game.snakes.set(2, {
      sessionId: 2,
      direction: 'left',
      score: 0,
      cells: [{ x: 3, y: 1 }],
      respawnAt: null,
    });
    tickSimulation(game);
    expect(game.snakes.get(1)?.respawnAt).toBe(31);
    expect(game.snakes.get(2)?.respawnAt).toBe(31);
  });

  it('kills a snake on self and other-snake body collision', () => {
    const game = state();
    const snake = game.snakes.get(1);
    if (snake === undefined) throw new Error('test setup');
    snake.cells = [
      { x: 2, y: 1 },
      { x: 1, y: 1 },
    ];
    snake.direction = 'left';
    game.snakes.set(2, {
      sessionId: 2,
      direction: 'right',
      score: 0,
      cells: [
        { x: 6, y: 1 },
        { x: 5, y: 1 },
      ],
      respawnAt: null,
    });
    tickSimulation(game);
    expect(snake.respawnAt).toBe(31);
    const other = game.snakes.get(2);
    if (other === undefined) throw new Error('test setup');
    other.cells = [
      { x: 4, y: 1 },
      { x: 3, y: 1 },
    ];
    other.direction = 'left';
    snake.cells = [{ x: 2, y: 1 }];
    snake.direction = 'right';
    for (let index = 0; index < 5; index += 1) tickSimulation(game);
    expect(other.respawnAt).toBe(36);
    expect(snake.respawnAt).toBe(31);
  });

  it('keeps seeded food placement deterministic', () => {
    const left = state();
    const right = state();
    for (let index = 0; index < 8; index += 1) {
      tickSimulation(left);
      tickSimulation(right);
    }
    expect(left).toEqual(right);
  });

  it('kills both snakes on a head swap', () => {
    const game = state();
    game.snakes.set(2, {
      sessionId: 2,
      direction: 'left',
      score: 0,
      cells: [{ x: 2, y: 1 }],
      respawnAt: null,
    });
    tickSimulation(game);
    expect(game.snakes.get(1)?.respawnAt).toBe(31);
    expect(game.snakes.get(2)?.respawnAt).toBe(31);
  });
});
