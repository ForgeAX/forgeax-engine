import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import type { App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, Update, type World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { createFrontendHost } from '@forgeax/engine-host/frontend';
import { createHostAssembly } from '@forgeax/engine-host/protocol';
import { connectHostWebSocket, type HostTransportClient } from '@forgeax/engine-host/transport';
import {
  createReplicaCoordinator,
  createSessionId,
  type NetEndpoint,
  type NetEndpointConnector,
  type NetRecoverySnapshot,
  type NetSession,
  netPlugin,
  type SessionId,
} from '@forgeax/engine-net';
import { createWebSocketConnector } from '@forgeax/engine-net-websocket/browser';
import type { Plugin } from '@forgeax/engine-plugin';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
  type Renderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { SNAKE_HOST_VERSION, snakeHostRoot } from './host';
import { type Direction, encodeCommand, encodeDirectionCommand } from './shared/commands';
import {
  Food,
  GridPosition,
  Snake,
  SnakeBody,
  SnakeSegment,
  SnakeSession,
  snakeProfile,
} from './shared/components';

export interface ReplicaRenderSinks {
  readonly stateTarget?: HTMLElement;
  readonly directionCommandEvidence?: DirectionCommandEvidence;
}

export interface ReplicatedSnake {
  readonly networkEntityId: number;
  readonly playerNetworkId: number;
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly score: number;
  readonly bodyLength: number;
  readonly direction: Direction;
  readonly color: number;
}

export interface SnakeSessionView {
  readonly started: boolean;
  readonly gameplayTick: number;
  readonly startedAtGameplayTick: number;
  readonly lastDirectionCommandPlayerNetworkId: number;
  readonly lastDirectionCommandGameplayTick: number;
}

/** One frame's replica projection, accumulated across the head and body row passes. */
interface ReplicaFrame {
  readonly liveIds: Set<number>;
  readonly snakes: ReplicatedSnake[];
  readonly playerColors: Map<number, number>;
  food?: { x: number; y: number };
  gameSession?: SnakeSessionView;
}

export interface RenderSnake {
  readonly id: number;
  readonly position: readonly [number, number, number];
  readonly color: number;
}

export interface DirectionCommandEvidence {
  directionCommandSendCount: number;
  lastAttemptedDirection?: Direction;
  lastSendResult?: 'sent' | 'rejected';
}

type SnakeCommandSession = Pick<NetSession, 'getRecoverySnapshot' | 'sendToAuthority'>;

interface SnakeClientPluginState {
  app?: App;
  world?: World;
  renderer?: Renderer;
  dispose?: () => void;
  session?: NetSession;
  replica?: ReturnType<typeof createReplicaCoordinator>;
  sessionId?: SessionId;
  directionCommandEvidence?: DirectionCommandEvidence;
}

/** Construct the Engine App inside the frontend host's plugin lifetime. */
function snakeAppPlugin(canvas: HTMLCanvasElement, state: SnakeClientPluginState): Plugin {
  return {
    name: 'snake:app',
    async apply(ctx) {
      const created = await createApp(canvas, { context: ctx.root }, forgeaxBundlerAdapter());
      if (!created.ok) throw created.error;
      state.app = created.value;
      state.world = created.value.world;
      state.renderer = created.value.renderer;
      // createApp installs the World service on the shared Host context. Do
      // not register a second provider on this startup Fiber: the Catalog
      // loader's `snake:client` entry resolves the same root service.
      ctx.effect(
        () => () => {
          void created.value.dispose();
        },
        'snake/app',
      );
    },
  };
}

interface SnakeClientPluginOptions {
  readonly endpoint: NetEndpoint;
  readonly connector?: NetEndpointConnector;
  readonly hostTransport?: HostTransportClient;
  readonly state: SnakeClientPluginState;
  readonly stateTarget?: HTMLElement;
  readonly directionCommandEvidence: DirectionCommandEvidence;
}

let nextSnakeSessionId = 1;

function allocateSnakeSessionId(): SessionId {
  const random = globalThis.crypto;
  const candidate =
    random === undefined
      ? nextSnakeSessionId
      : 1 + ((random.getRandomValues(new Uint32Array(1))[0] ?? 0) % 0x7fffffff);
  nextSnakeSessionId = candidate >= Number.MAX_SAFE_INTEGER ? 1 : candidate + 1;
  const created = createSessionId(candidate);
  if (!created.ok) throw created.error;
  return created.value;
}

/** Own the browser game capability and its Net/App-facing effects as one Fiber. */
function snakeClientPlugin(options: SnakeClientPluginOptions): Plugin {
  return {
    name: 'snake:client',
    inject: ['world'],
    async apply(ctx) {
      await ctx.plugin(
        netPlugin({
          endpoint: options.endpoint,
          ...(options.connector === undefined ? {} : { connector: options.connector }),
          sessionId: allocateSnakeSessionId(),
        }),
      );
      const world = ctx.world;
      const session = world.getResource<NetSession>('net-session');
      const replica = createReplicaCoordinator(world, snakeProfile);
      session.attachReplica(replica, snakeProfile.limits);
      // The World receive system announces this session after Host activation.
      // Polling here starts the authority's ACK budget before App can advance.
      const sessionId = session.getRecoverySnapshot().sessionId;
      const lifecycleTarget = options.stateTarget;
      if (lifecycleTarget !== undefined) {
        lifecycleTarget.dataset.lifecycle = 'renderer-ready';
        lifecycleTarget.dataset.rendererReady = 'true';
      }
      // Initial join is sent by the same per-epoch World system as rejoin.
      // A socket can close while App/renderer assembly is still pending; the
      // NetSession must be allowed to recover before a command is admitted.
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 20] } },
          {
            component: Camera,
            data: orthographic({ left: -13, right: 13, bottom: -9, top: 9, near: 0.1, far: 100 }),
          },
        )
        .unwrap();
      const stateTarget =
        globalThis.document?.querySelector<HTMLElement>('[data-testid="snake-state"]') ?? undefined;
      const sinks: ReplicaRenderSinks = {};
      if (stateTarget !== undefined)
        (sinks as { stateTarget: HTMLElement }).stateTarget = stateTarget;
      (sinks as { directionCommandEvidence: DirectionCommandEvidence }).directionCommandEvidence =
        options.directionCommandEvidence;
      registerReplicaDerivation(world, replica, sinks, session);
      const disposeKeyboard = installKeyboardInput(
        session,
        undefined,
        options.directionCommandEvidence,
      );
      options.state.session = session;
      options.state.replica = replica;
      options.state.sessionId = sessionId;
      options.state.directionCommandEvidence = options.directionCommandEvidence;
      ctx.effect(() => () => disposeKeyboard(), 'snake/client-input');
      let retired = false;
      const retire = (): void => {
        if (retired) return;
        retired = true;
        session.dispose();
        options.hostTransport?.close('snake client plugin disposed');
      };
      options.state.dispose = retire;
      ctx.effect(() => retire, 'snake/client-lifecycle');
    },
  };
}

function syncSessionSnapshot(target: HTMLElement, snapshot: NetRecoverySnapshot): void {
  target.dataset.sessionId = String(snapshot.sessionId);
  target.dataset.pendingPackets = String(snapshot.pendingPackets);
  target.dataset.ownedResources = JSON.stringify(snapshot.ownedResources);
  switch (snapshot.state.kind) {
    case 'connecting':
      target.dataset.lifecycle = 'connecting';
      break;
    case 'resyncing':
      target.dataset.lifecycle = 'resyncing';
      target.dataset.recoveryEpoch = String(snapshot.state.epoch);
      break;
    case 'active':
      target.dataset.lifecycle = 'active';
      target.dataset.recoveryEpoch = String(snapshot.state.epoch);
      target.dataset.recoverySequence = String(snapshot.state.sequence);
      break;
    case 'recovering':
      target.dataset.lifecycle = 'recovering';
      target.dataset.recoveryAttempt = String(snapshot.state.attempt);
      break;
    case 'failed':
      target.dataset.lifecycle = 'failed';
      target.dataset.errorCode = snapshot.state.error.code;
      target.dataset.errorHint = snapshot.state.error.hint;
      break;
    case 'retired':
      target.dataset.lifecycle = 'retired';
      target.dataset.retireReason = snapshot.state.reason;
      break;
  }
  if (snapshot.lastError !== undefined) {
    target.dataset.lastError = snapshot.lastError.code;
    target.dataset.lastErrorHint = snapshot.lastError.hint;
  }
}

/** The simulation grid grows downward; the orthographic world grows upward. */
export function gridToWorldPosition(x: number, y: number): [number, number, number] {
  return [x - 12, 8 - y, 0];
}

function replicaEntityReferences(value: unknown): number[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).map(Number).filter(Number.isFinite);
}

export function deriveReplicaRenderState(snakes: readonly ReplicatedSnake[]): RenderSnake[] {
  return snakes.map((snake) => ({
    id: snake.networkEntityId,
    position: [snake.x, snake.y, 0],
    color: snake.playerNetworkId % 2,
  }));
}

export function renderSnakeState(
  target: HTMLElement,
  tick: number,
  snakes: readonly ReplicatedSnake[],
  food?: { readonly x: number; readonly y: number },
  session?: SnakeSessionView,
  localPlayerNetworkId?: number,
): void {
  target.dataset.testid = 'snake-state';
  target.dataset.lifecycle = tick === 0 ? 'waiting' : tick === 1 ? 'gameplay-start' : 'gameplay';
  if (tick === 0) target.dataset.waitingTick = '0';
  if (tick > 0 && target.dataset.gameplayStartTick === undefined)
    target.dataset.gameplayStartTick = String(tick);
  target.textContent = JSON.stringify({
    tick,
    snakes: snakes.map(
      ({ networkEntityId, playerNetworkId, id, x, y, score, bodyLength, direction }) => ({
        id,
        networkEntityId,
        playerNetworkId,
        x,
        y,
        score,
        bodyLength,
        direction,
      }),
    ),
    ...(food === undefined ? {} : { food }),
    ...(session === undefined ? {} : { session }),
  });
  const status = globalThis.document?.querySelector<HTMLElement>('#round-status');
  const scoreboard = globalThis.document?.querySelector<HTMLElement>('#scoreboard');
  if (status !== null && status !== undefined) {
    status.textContent =
      session?.started === false
        ? 'Waiting for a second player…'
        : snakes.length === 0
          ? 'Round resetting…'
          : 'Round in progress';
  }
  if (scoreboard !== null && scoreboard !== undefined) {
    const localPlayer = snakes.find((snake) => snake.playerNetworkId === localPlayerNetworkId);
    scoreboard.replaceChildren(
      ...(localPlayer === undefined
        ? []
        : [
            Object.assign(document.createElement('span'), {
              className: localPlayer.color === 0 ? 'cyan' : 'orange',
              textContent: `You are P${localPlayer.playerNetworkId}`,
            }),
          ]),
      ...snakes.map((snake) => {
        const item = document.createElement('span');
        item.className = snake.color === 0 ? 'cyan' : 'orange';
        item.textContent = `P${snake.playerNetworkId}: ${snake.score}`;
        return item;
      }),
    );
  }
}

export function registerReplicaDerivation(
  world: World,
  replica: ReturnType<typeof createReplicaCoordinator>,
  sinks: ReplicaRenderSinks = {},
  session?: SnakeCommandSession,
): Map<number, EntityHandle> {
  const sceneAssets = world.assets;
  if (!(sceneAssets instanceof AssetRegistry))
    throw new Error('Scene requires its runtime asset owner');

  const primitiveCube = sceneAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

  const hasBrowserVisuals = sinks.stateTarget !== undefined && globalThis.document !== undefined;
  const hideBodyForVisualFalsification =
    globalThis.location?.search.includes('visual-sabotage=hide-body') ?? false;
  const renderEntities = new Map<number, EntityHandle>();
  let localPlayerNetworkId: number | undefined;
  const snakeMaterials = [
    sceneAssets.create(Materials.unlit([0.13, 0.83, 0.93, 1])).unwrap(),
    sceneAssets.create(Materials.unlit([0.98, 0.45, 0.09, 1])).unwrap(),
  ] as const;
  const snakeBodyMaterials = [
    sceneAssets.create(Materials.unlit([0.05, 0.46, 0.54, 1])).unwrap(),
    sceneAssets.create(Materials.unlit([0.61, 0.24, 0.04, 1])).unwrap(),
  ] as const;
  const foodMaterial = sceneAssets.create(Materials.unlit([0.96, 0.23, 0.38, 1])).unwrap();
  const boundaryMaterial = sceneAssets.create(Materials.unlit([0.2, 0.27, 0.38, 1])).unwrap();
  let foodEntity: EntityHandle | undefined;
  let joinedEpoch: number | undefined;
  let readyEpoch: number | undefined;
  if (hasBrowserVisuals) {
    foodEntity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], scale: [0.55, 0.55, 0.55] } },
        { component: MeshFilter, data: { assetHandle: primitiveCube } },
        { component: MeshRenderer, data: { materials: [foodMaterial] } },
      )
      .unwrap();
    for (const [pos, scale] of [
      [
        [0, -8.5, 0],
        [25, 0.2, 0.2],
      ],
      [
        [0, 8.5, 0],
        [25, 0.2, 0.2],
      ],
      [
        [-12.5, 0, 0],
        [0.2, 17, 0.2],
      ],
      [
        [12.5, 0, 0],
        [0.2, 17, 0.2],
      ],
    ] as const)
      world
        .spawn(
          { component: Transform, data: { pos, scale } },
          { component: MeshFilter, data: { assetHandle: primitiveCube } },
          { component: MeshRenderer, data: { materials: [boundaryMaterial] } },
        )
        .unwrap();
  }

  function readSessionView(rowId: number): SnakeSessionView | undefined {
    const sessionComponent = replica.readComponent(rowId, SnakeSession);
    if (sessionComponent === undefined) return undefined;
    return {
      started: Boolean(sessionComponent.started),
      gameplayTick: Number(sessionComponent.gameplayTick ?? 0),
      startedAtGameplayTick: Number(sessionComponent.startedAtGameplayTick ?? 0),
      lastDirectionCommandPlayerNetworkId: Number(
        sessionComponent.lastDirectionCommandPlayerNetworkId ?? 0,
      ),
      lastDirectionCommandGameplayTick: Number(
        sessionComponent.lastDirectionCommandGameplayTick ?? 0,
      ),
    };
  }

  function readFoodPosition(rowId: number): { x: number; y: number } | undefined {
    const foodComponent = replica.readComponent(rowId, Food);
    const foodPosition = replica.readComponent(rowId, GridPosition);
    if (foodComponent === undefined || foodPosition === undefined) return undefined;
    return { x: Number(foodPosition.x ?? 0), y: Number(foodPosition.y ?? 0) };
  }

  function collectSnakeHead(
    frameWorld: World,
    cube: typeof primitiveCube,
    rowId: number,
    frame: ReplicaFrame,
  ): void {
    const position = replica.readComponent(rowId, GridPosition);
    const snake = replica.readComponent(rowId, Snake);
    if (position === undefined || snake === undefined) return;
    const body = replica.readComponent(rowId, SnakeBody);
    const bodySegments = replicaEntityReferences(body?.segments);
    const x = Number(position.x ?? 0);
    const y = Number(position.y ?? 0);
    const playerNetworkId = Number(snake.playerNetworkId ?? 0);
    const color = playerNetworkId % 2;
    frame.liveIds.add(rowId);
    frame.snakes.push({
      id: rowId,
      x,
      y,
      score: Number(snake.score ?? 0),
      bodyLength: bodySegments.length + 1,
      direction: (['up', 'right', 'down', 'left'][Number(snake.direction ?? 0)] ??
        'right') as ReplicatedSnake['direction'],
      networkEntityId: rowId,
      playerNetworkId,
      color,
    });
    frame.playerColors.set(playerNetworkId, color);
    let entity = renderEntities.get(rowId);
    if (entity === undefined) {
      entity = frameWorld
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: cube } },
          {
            component: MeshRenderer,
            data: { materials: [snakeMaterials[color] ?? snakeMaterials[0]] },
          },
        )
        .unwrap();
      renderEntities.set(rowId, entity);
    }
    frameWorld.set(entity, Transform, { pos: gridToWorldPosition(x, y) });
  }

  function collectReplicaRow(
    frameWorld: World,
    cube: typeof primitiveCube,
    rowId: number,
    frame: ReplicaFrame,
  ): void {
    const sessionView = readSessionView(rowId);
    if (sessionView !== undefined) {
      frame.gameSession = sessionView;
      return;
    }
    const foodPosition = readFoodPosition(rowId);
    if (foodPosition !== undefined) {
      frame.food = foodPosition;
      return;
    }
    collectSnakeHead(frameWorld, cube, rowId, frame);
  }

  function collectBodySegment(
    frameWorld: World,
    cube: typeof primitiveCube,
    rowId: number,
    frame: ReplicaFrame,
  ): void {
    const segment = replica.readComponent(rowId, SnakeSegment);
    const position = replica.readComponent(rowId, GridPosition);
    if (segment === undefined || position === undefined) return;
    const color = frame.playerColors.get(Number(segment.playerNetworkId ?? 0));
    if (color === undefined) return;
    if (hideBodyForVisualFalsification) return;
    frame.liveIds.add(rowId);
    let entity = renderEntities.get(rowId);
    if (entity === undefined) {
      entity = frameWorld
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0], scale: [0.9, 0.9, 0.9] } },
          { component: MeshFilter, data: { assetHandle: cube } },
          {
            component: MeshRenderer,
            data: { materials: [snakeBodyMaterials[color] ?? snakeBodyMaterials[0]] },
          },
        )
        .unwrap();
      renderEntities.set(rowId, entity);
    }
    frameWorld.set(entity, Transform, {
      pos: gridToWorldPosition(Number(position.x ?? 0), Number(position.y ?? 0)),
      scale: [0.9, 0.9, 0.9],
    });
  }

  /** Joins once per recovered epoch and reports readiness while the session waits. */
  function announceToAuthority(
    recovery: NetRecoverySnapshot | undefined,
    gameSession: SnakeSessionView | undefined,
  ): void {
    if (session === undefined || recovery?.state.kind !== 'active') return;
    if (joinedEpoch !== recovery.state.epoch) {
      const join = encodeCommand({ kind: 'join' });
      if (!join.ok) throw join.error;
      const sent = session.sendToAuthority(recovery.sessionId, join.value);
      if (sent.ok) {
        joinedEpoch = recovery.state.epoch;
        readyEpoch = undefined;
        if (sinks.stateTarget !== undefined) {
          sinks.stateTarget.dataset.lifecycle = 'join-sent';
          sinks.stateTarget.dataset.joinSent = 'true';
          sinks.stateTarget.dataset.waitingTick = '0';
        }
      }
    }
    if (gameSession?.started === false && readyEpoch !== recovery.state.epoch) {
      const ready = encodeCommand({ kind: 'ready' });
      if (!ready.ok) throw ready.error;
      const sent = session.sendToAuthority(recovery.sessionId, ready.value);
      if (sent.ok) readyEpoch = recovery.state.epoch;
    }
  }

  function showWaitingRoom(frameWorld: World, frame: ReplicaFrame): void {
    for (const [, entity] of renderEntities) frameWorld.despawn(entity).unwrap();
    renderEntities.clear();
    if (sinks.stateTarget !== undefined)
      renderSnakeState(
        sinks.stateTarget,
        replica.tick,
        [],
        frame.food,
        frame.gameSession,
        localPlayerNetworkId,
      );
    if (sinks.stateTarget !== undefined) sinks.stateTarget.dataset.renderEntityCount = '0';
  }

  function adoptLocalPlayer(gameSession: SnakeSessionView | undefined): void {
    if (
      localPlayerNetworkId === undefined &&
      sinks.directionCommandEvidence?.lastSendResult === 'sent' &&
      (gameSession?.lastDirectionCommandPlayerNetworkId ?? 0) > 0
    )
      localPlayerNetworkId = gameSession?.lastDirectionCommandPlayerNetworkId;
  }

  function publishFrame(frameWorld: World, frame: ReplicaFrame): void {
    const { food } = frame;
    if (food !== undefined && foodEntity !== undefined)
      frameWorld
        .set(foodEntity, Transform, {
          pos: gridToWorldPosition(food.x, food.y),
          scale: [0.55, 0.55, 0.55],
        })
        .unwrap();
    for (const [id, entity] of renderEntities) {
      if (!frame.liveIds.has(id)) {
        frameWorld.despawn(entity).unwrap();
        renderEntities.delete(id);
      }
    }
    if (sinks.stateTarget !== undefined)
      renderSnakeState(
        sinks.stateTarget,
        replica.tick,
        frame.snakes,
        food,
        frame.gameSession,
        localPlayerNetworkId,
      );
    if (sinks.stateTarget !== undefined)
      sinks.stateTarget.dataset.renderEntityCount = String(renderEntities.size);
  }

  world.addSystem(Update, {
    name: 'snake-replica-derivation',
    queries: [],
    fn: (world) => {
      const sceneAssets = world.assets;
      if (!(sceneAssets instanceof AssetRegistry))
        throw new Error('Scene requires its runtime asset owner');

      const primitiveCube = sceneAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

      const frame: ReplicaFrame = { liveIds: new Set(), snakes: [], playerColors: new Map() };
      const rows = replica.snapshot();
      for (const row of rows) collectReplicaRow(world, primitiveCube, row.id, frame);
      const recovery = session?.getRecoverySnapshot();
      if (sinks.stateTarget !== undefined && recovery !== undefined)
        syncSessionSnapshot(sinks.stateTarget, recovery);
      announceToAuthority(recovery, frame.gameSession);
      if (hasBrowserVisuals && frame.gameSession?.started === false) {
        showWaitingRoom(world, frame);
        return;
      }
      for (const row of rows) collectBodySegment(world, primitiveCube, row.id, frame);
      adoptLocalPlayer(frame.gameSession);
      publishFrame(world, frame);
    },
  });
  return renderEntities;
}

/** Assemble the browser-side replica. Replicated components are read-only here. */
export async function createClient(canvas: HTMLCanvasElement, url: string, hostUrl: string) {
  const connector = createWebSocketConnector(url);
  const connected = await connector.connect(new AbortController().signal);
  if (!connected.ok) throw connected.error;
  const hostTransport = await connectHostWebSocket(hostUrl);
  return createClientWithEndpoint(canvas, connected.value, connector, {
    hostTransport,
  });
}

export async function createClientWithEndpoint(
  canvas: HTMLCanvasElement,
  endpoint: NetEndpoint,
  connector?: NetEndpointConnector,
  options: {
    readonly hostTransport?: HostTransportClient;
  } = {},
) {
  const lifecycleTarget = globalThis.document?.querySelector<HTMLElement>(
    '[data-testid="snake-state"]',
  );
  if (lifecycleTarget !== null && lifecycleTarget !== undefined)
    lifecycleTarget.dataset.lifecycle = 'connecting';
  const stateTarget =
    globalThis.document?.querySelector<HTMLElement>('[data-testid="snake-state"]') ?? undefined;
  const directionCommandEvidence: DirectionCommandEvidence = { directionCommandSendCount: 0 };
  const pluginState: SnakeClientPluginState = {};
  const hostAssembly =
    options.hostTransport === undefined ? createHostAssembly({ root: snakeHostRoot() }) : undefined;
  const frontendHost = await createFrontendHost({
    startupPlugins: [snakeAppPlugin(canvas, pluginState)],
    resolveRoot: async (root) => {
      if (root.program !== 'snake:client' || root.codeRevision !== SNAKE_HOST_VERSION)
        throw new Error('snake frontend program/version mismatch');
      return snakeClientPlugin({
        endpoint,
        ...(connector === undefined ? {} : { connector }),
        ...(options.hostTransport === undefined ? {} : { hostTransport: options.hostTransport }),
        state: pluginState,
        ...(stateTarget === undefined ? {} : { stateTarget }),
        directionCommandEvidence,
      });
    },
    ...(hostAssembly === undefined ? {} : { assembly: hostAssembly }),
    ...(options.hostTransport === undefined ? {} : { transport: options.hostTransport }),
  });
  const session = pluginState.session;
  const replica = pluginState.replica;
  const sessionId = pluginState.sessionId;
  const app = pluginState.app;
  const world = pluginState.world;
  const renderer = pluginState.renderer;
  if (
    app === undefined ||
    world === undefined ||
    renderer === undefined ||
    session === undefined ||
    replica === undefined ||
    sessionId === undefined
  )
    throw new Error(
      'snake: frontend host did not publish its App, World, renderer, session, and replica',
    );
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    pluginState.dispose?.();
    void frontendHost.dispose();
  };
  return {
    app,
    world,
    renderer,
    replica,
    session,
    sessionId,
    getRecoverySnapshot: () => session.getRecoverySnapshot(),
    dispose,
    directionCommandEvidence,
  };
}

const KEY_DIRECTIONS: Readonly<Record<string, Direction>> = {
  ArrowUp: 'up',
  ArrowRight: 'right',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  w: 'up',
  d: 'right',
  s: 'down',
  a: 'left',
};

export function installKeyboardInput(
  session: SnakeCommandSession,
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  evidence: DirectionCommandEvidence = { directionCommandSendCount: 0 },
): () => void {
  const eventTarget = target ?? globalThis.window;
  if (eventTarget === undefined) return () => {};
  const listener = (event: KeyboardEvent): void => {
    const direction = KEY_DIRECTIONS[event.key];
    if (direction === undefined) {
      evidence.lastSendResult = 'rejected';
      return;
    }
    evidence.lastAttemptedDirection = direction;
    const snapshot = session.getRecoverySnapshot();
    if (snapshot.state.kind !== 'active') {
      evidence.lastSendResult = 'rejected';
      return;
    }
    const encoded = encodeDirectionCommand({ direction });
    if (encoded.ok) {
      const sent = session.sendToAuthority(snapshot.sessionId, encoded.value);
      if (sent.ok) {
        evidence.directionCommandSendCount += 1;
        evidence.lastSendResult = 'sent';
      } else evidence.lastSendResult = 'rejected';
    } else evidence.lastSendResult = 'rejected';
  };
  eventTarget.addEventListener('keydown', listener);
  return () => eventTarget.removeEventListener('keydown', listener);
}
