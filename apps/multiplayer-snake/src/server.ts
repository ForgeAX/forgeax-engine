import { type EntityHandle, FixedTime, FixedUpdate, World, worldPlugin } from '@forgeax/engine-ecs';
import { type BackendHost, createBackendHost } from '@forgeax/engine-host/backend';
import {
  createHostAssembly,
  type HostActivationReport,
  type HostRootDescriptor,
} from '@forgeax/engine-host/protocol';
import {
  attachHostWebSocketServer,
  createHostTransport,
  type HostTransportServer,
} from '@forgeax/engine-host/transport';
import {
  createAuthorityCoordinator,
  isTerminalNetSessionState,
  type NetEndpoint,
  type NetSession,
  netPlugin,
  type SessionId,
} from '@forgeax/engine-net';
import { listenWebSocketEndpoint } from '@forgeax/engine-net-websocket/node';
import type { Context, Plugin } from '@forgeax/engine-plugin';
import { type WebSocket, WebSocketServer } from 'ws';
import { snakeHostRoot } from './host';
import type { Direction } from './shared/commands';
import {
  decodeCommand,
  processCommands,
  processJoinCommands,
  processReadyCommands,
} from './shared/commands';
import {
  ControlledBy,
  Food,
  GridPosition,
  Networked,
  PendingDirection,
  Snake,
  SnakeBody,
  SnakeSegment,
  SnakeSession,
  snakeProfile,
} from './shared/components';
import { SNAKE_MOVE_INTERVAL_SECONDS, type SnakeGameState, tickSimulation } from './shared/rules';

export interface SnakeServer {
  readonly world: World;
  readonly game: SnakeGameState;
  readonly pluginContext: Context;
  readonly host: BackendHost;
  readonly hostTransport: HostTransportServer;
  readonly activationReports: readonly HostActivationReport[];
}

const directionValue: Record<Direction, number> = { up: 0, right: 1, down: 2, left: 3 };

interface SnakeEntities {
  readonly snake: EntityHandle;
  segments: EntityHandle[];
}

/** The server plugin owns the simulation clock and its reversible timer. */
function snakeSimulationClockPlugin(): Plugin {
  return {
    name: 'snake:simulation-clock',
    inject: ['world'],
    apply(ctx) {
      const timer = setInterval(() => {
        const updated = ctx.world.update(1 / 60);
        if (updated.ok) return;
        console.error(`${updated.error.code}: ${updated.error.hint}`);
        clearInterval(timer);
      }, 1000 / 60);
      ctx.effect(() => () => clearInterval(timer), 'snake/simulation-clock');
    },
  };
}

function initialSnakeCells(index: number) {
  const y = 3 + index * 3;
  return [
    { x: 4, y },
    { x: 3, y },
    { x: 2, y },
  ];
}

/**
 * Materialize the plain deterministic game state into the replicated ECS
 * surface. The coordinator assigns network ids from these stable handles;
 * segment references therefore get remapped correctly on every replica.
 */
function projectGameState(
  world: World,
  game: SnakeGameState,
  bySession: Map<SessionId, SnakeEntities>,
  foodRef: { entity?: EntityHandle },
): void {
  if (foodRef.entity === undefined) {
    foodRef.entity = world
      .spawn(
        { component: Networked, data: { enabled: true } },
        { component: Food, data: { enabled: true } },
        { component: GridPosition, data: game.food },
      )
      .unwrap();
  } else world.set(foodRef.entity, GridPosition, { x: game.food.x, y: game.food.y }).unwrap();

  const liveSessions = new Set([...game.snakes.keys()].map((value) => value as SessionId));
  for (const [sessionId, entities] of [...bySession]) {
    const snake = game.snakes.get(sessionId);
    if (snake === undefined || snake.cells.length === 0) {
      for (const segment of entities.segments) world.despawn(segment).unwrap();
      world.despawn(entities.snake).unwrap();
      bySession.delete(sessionId);
    }
  }

  for (const [playerId, snake] of game.snakes) {
    if (snake.cells.length === 0) continue;
    const sessionId = playerId as SessionId;
    const head = snake.cells[0] ?? { x: 0, y: 0 };
    let entities = bySession.get(sessionId);
    if (entities === undefined) {
      const created = world
        .spawn(
          { component: Networked, data: { enabled: true } },
          {
            component: Snake,
            data: {
              direction: directionValue[snake.direction],
              score: snake.score,
              playerNetworkId: Number(sessionId),
            },
          },
          { component: GridPosition, data: head },
          { component: SnakeBody, data: { segments: [] } },
          { component: ControlledBy, data: { sessionId: Number(sessionId) } },
          { component: PendingDirection, data: { value: directionValue[snake.direction] } },
        )
        .unwrap();
      entities = { snake: created, segments: [] };
      bySession.set(sessionId, entities);
    }
    world
      .set(entities.snake, Snake, {
        direction: directionValue[snake.direction],
        score: snake.score,
        playerNetworkId: Number(sessionId),
      })
      .unwrap();
    world.set(entities.snake, GridPosition, { x: head.x, y: head.y }).unwrap();
    world
      .set(entities.snake, PendingDirection, { value: directionValue[snake.direction] })
      .unwrap();
    while (entities.segments.length > snake.cells.length - 1) {
      const segment = entities.segments.pop();
      if (segment !== undefined) world.despawn(segment).unwrap();
    }
    while (entities.segments.length < snake.cells.length - 1) {
      entities.segments.push(
        world
          .spawn(
            { component: Networked, data: { enabled: true } },
            {
              component: SnakeSegment,
              data: { playerNetworkId: Number(sessionId), order: entities.segments.length + 1 },
            },
            { component: GridPosition, data: { x: 0, y: 0 } },
          )
          .unwrap(),
      );
    }
    for (const [index, segment] of entities.segments.entries()) {
      const cell = snake.cells[index + 1] ?? { x: 0, y: 0 };
      world.set(segment, GridPosition, { x: cell.x, y: cell.y }).unwrap();
    }
    world.set(entities.snake, SnakeBody, { segments: entities.segments }).unwrap();
  }
  // The set above is authoritative; this guard documents that disconnected
  // peers never retain a projected entity even when no simulation tick ran.
  for (const sessionId of bySession.keys())
    if (!liveSessions.has(sessionId)) bySession.delete(sessionId);
}

interface SnakeServerState {
  game?: SnakeGameState;
  world?: World;
}

async function configureSnakeServer(world: World): Promise<SnakeGameState> {
  const session = world.getResource<NetSession>('net-session');
  session.attachAuthority(createAuthorityCoordinator(world, snakeProfile));
  const game: SnakeGameState = {
    tick: 0,
    started: false,
    gameplayTick: 0,
    nextId: 1,
    snakes: new Map(),
    food: { x: 12, y: 8 },
    width: 24,
    height: 16,
    maxPeers: 4,
    seed: 1,
    movementAccumulatorSeconds: SNAKE_MOVE_INTERVAL_SECONDS,
    movementIntervalSeconds: SNAKE_MOVE_INTERVAL_SECONDS,
  };
  world.insertResource('snake-game', game);
  const sessionEntity = world
    .spawn(
      { component: Networked, data: { enabled: true } },
      {
        component: SnakeSession,
        data: {
          started: false,
          gameplayTick: 0,
          startedAtGameplayTick: 0,
          lastDirectionCommandPlayerNetworkId: 0,
          lastDirectionCommandGameplayTick: 0,
        },
      },
    )
    .unwrap();
  const projected = new Map<SessionId, SnakeEntities>();
  const readySessions = new Set<number>();
  const foodRef: { entity?: EntityHandle } = {};
  projectGameState(world, game, projected, foodRef);
  world.addSystem(FixedUpdate, {
    name: 'snake-fixed-tick',
    queries: [],
    fn: (world) => {
      const activeSession = world.getResource<NetSession>('net-session');
      const activeGame = world.getResource<SnakeGameState>('snake-game');
      const fixedDeltaSeconds = world.getResource(FixedTime).delta;
      const recoverySnapshot = activeSession.getRecoverySnapshot();
      if (isTerminalNetSessionState(recoverySnapshot.state)) return;
      const wasStarted = activeGame.started;
      const rawMessages = activeSession.drainRawMessages();
      const sessionIds = activeSession.getSessionSnapshot().sessionIds;
      const connectedSessions = new Set(sessionIds.map(Number));
      const commandMessages = rawMessages.map((message) => ({
        sessionId: Number(message.sessionId),
        data: message.data,
      }));
      for (const sessionId of [...readySessions])
        if (!connectedSessions.has(sessionId)) readySessions.delete(sessionId);
      const joined = new Set(activeGame.snakes.keys());
      for (const sessionId of processJoinCommands(commandMessages, connectedSessions))
        joined.add(sessionId);
      for (const sessionId of processReadyCommands(commandMessages, connectedSessions))
        readySessions.add(sessionId);
      for (const sessionId of [...joined])
        if (!connectedSessions.has(sessionId)) joined.delete(sessionId);
      for (const sessionId of [...activeGame.snakes.keys()])
        if (!joined.has(sessionId)) activeGame.snakes.delete(sessionId);
      for (const sessionId of joined) {
        if (activeGame.snakes.has(sessionId)) continue;
        if (activeGame.snakes.size >= activeGame.maxPeers) continue;
        activeGame.snakes.set(sessionId, {
          sessionId,
          direction: 'right',
          score: 0,
          cells: initialSnakeCells(activeGame.snakes.size),
          respawnAt: null,
        });
        activeSession.requestFullBaselineForSession(sessionId as SessionId);
      }
      // Admission is complete only after both peers have a projected snake.
      // This keeps the replicated waiting state observable until the second
      // peer has actually been accepted and baselined.
      if (!activeGame.started && readySessions.size >= 2) {
        activeGame.started = true;
        activeGame.startedAtGameplayTick = activeGame.gameplayTick ?? 0;
      }
      const directions = new Map(
        [...activeGame.snakes.values()].map((snake) => [snake.sessionId, snake.direction]),
      );
      const directionMessages = commandMessages.filter((message) => {
        const decoded = decodeCommand(message.data);
        return decoded.ok && !('kind' in decoded.value);
      });
      for (const [sessionId, direction] of processCommands(directionMessages, directions)) {
        const snake = activeGame.snakes.get(sessionId);
        if (snake === undefined) continue;
        snake.direction = direction;
        activeGame.lastDirectionCommandPlayerNetworkId = sessionId;
        activeGame.lastDirectionCommandGameplayTick = activeGame.gameplayTick ?? 0;
      }
      if (wasStarted) tickSimulation(activeGame, fixedDeltaSeconds);
      world
        .set(sessionEntity, SnakeSession, {
          started: activeGame.started ?? false,
          gameplayTick: activeGame.gameplayTick ?? 0,
          startedAtGameplayTick: activeGame.startedAtGameplayTick ?? 0,
          lastDirectionCommandPlayerNetworkId: activeGame.lastDirectionCommandPlayerNetworkId ?? 0,
          lastDirectionCommandGameplayTick: activeGame.lastDirectionCommandGameplayTick ?? 0,
        })
        .unwrap();
      projectGameState(world, activeGame, projected, foodRef);
    },
  });
  return game;
}

function snakeServerPlugin(
  endpoint: NetEndpoint,
  state: SnakeServerState,
  withClock: boolean,
): Plugin {
  return {
    name: 'snake:server',
    async apply(ctx) {
      const world = new World();
      await ctx.plugin(worldPlugin(world));
      await ctx.plugin(netPlugin({ endpoint }));
      state.world = world;
      state.game = await configureSnakeServer(world);
      if (withClock) await ctx.plugin(snakeSimulationClockPlugin());
    },
  };
}

/** Keep the host socket listener inside the backend Host Fiber lifetime. */
function snakeHostSocketPlugin(
  socketServer: WebSocketServer,
  transport: HostTransportServer,
): Plugin {
  return {
    name: 'snake:host-websocket',
    apply(ctx) {
      const socketDisposers = new Set<() => void>();
      const onConnection = (socket: WebSocket): void => {
        const dispose = attachHostWebSocketServer(socket, transport);
        socketDisposers.add(dispose);
        socket.once('close', () => socketDisposers.delete(dispose));
      };
      ctx.effect(() => {
        socketServer.on('connection', onConnection);
        return () => {
          socketServer.off('connection', onConnection);
          for (const dispose of socketDisposers) dispose();
          socketDisposers.clear();
          try {
            socketServer.close();
          } catch {
            // The process entry may have closed the listener first.
          }
        };
      }, 'snake/host-websocket');
    },
  };
}

/** Keep the gameplay endpoint inside the backend Host Fiber lifetime. */
function snakeEndpointLifecyclePlugin(endpoint: NetEndpoint): Plugin {
  return {
    name: 'snake:net-endpoint-lifecycle',
    apply(ctx) {
      ctx.effect(
        () => () => {
          endpoint.close();
        },
        'snake/net-endpoint',
      );
    },
  };
}

export async function createServerWorld(
  endpoint: NetEndpoint,
  options: {
    readonly withClock?: boolean;
    readonly hostTransport?: HostTransportServer;
    readonly hostSocketServer?: WebSocketServer;
    readonly root?: HostRootDescriptor;
  } = {},
): Promise<SnakeServer> {
  const state: SnakeServerState = {};
  const activationReports: HostActivationReport[] = [];
  const hostTransport = options.hostTransport ?? createHostTransport();
  const host = await createBackendHost({
    assembly: createHostAssembly({ root: options.root ?? snakeHostRoot() }),
    transport: hostTransport,
    startupPlugins: [
      snakeServerPlugin(endpoint, state, options.withClock ?? false),
      snakeEndpointLifecyclePlugin(endpoint),
      ...(options.hostSocketServer === undefined
        ? []
        : [snakeHostSocketPlugin(options.hostSocketServer, hostTransport)]),
    ],
    onActivationReport: (report) => {
      activationReports.push(report);
    },
  });
  if (state.world === undefined || state.game === undefined)
    throw new Error('snake: server plugin did not publish its World and game state');
  return {
    world: state.world,
    game: state.game,
    pluginContext: host.context,
    host,
    hostTransport,
    activationReports,
  };
}

export async function startServer(
  port: number,
  { withClock = true }: { readonly withClock?: boolean } = {},
) {
  const hostTransport = createHostTransport();
  const hostPort = port + 1;
  const hostSocketServer = new WebSocketServer({ host: '127.0.0.1', port: hostPort });
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      hostSocketServer.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      hostSocketServer.off('listening', onListening);
      reject(error);
    };
    hostSocketServer.once('listening', onListening);
    hostSocketServer.once('error', onError);
  });
  const listened = await listenWebSocketEndpoint({ port, maxPeers: 4 });
  if (!listened.ok) {
    await new Promise<void>((resolve) => hostSocketServer.close(() => resolve()));
    throw listened.error;
  }
  let server: SnakeServer;
  try {
    server = await createServerWorld(listened.value, {
      withClock,
      hostTransport,
      hostSocketServer,
    });
  } catch (error) {
    listened.value.close();
    hostSocketServer.close();
    hostTransport.close('snake backend startup failed');
    throw error;
  }
  return {
    ...server,
    port,
    hostPort,
    close: () => server.host.dispose(),
  };
}
