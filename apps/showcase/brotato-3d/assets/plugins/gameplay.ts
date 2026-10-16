import { renderFeaturePlugin, type GameHost, type GameProjectionValue } from '@forgeax/engine-app';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  FixedTime,
  FixedUpdate,
  Time,
  type CommandBuffer,
  type EntityHandle,
  type World,
  Update,
} from '@forgeax/engine-ecs';
import {
  INPUT_MAP_KEY,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type ActionConfig,
  type InputSnapshot,
} from '@forgeax/engine-input';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { Context } from '@forgeax/engine-plugin';
import {
  type Handle,
  type MaterialAsset,
  type MeshAsset,
  type SceneAsset,
} from '@forgeax/engine-types';
import {
  ANTIALIAS_FXAA,
  Camera,
  MeshFilter,
  MeshRenderer,
  TONEMAP_ACES_FILMIC,
  perspective,
  SceneInstance,
} from '@forgeax/engine-render';
import { Transform, worldDespawnScene } from '@forgeax/engine-scene';
import type { UiAsset } from '@forgeax/engine-ui';
import { loadVfxGpuEffect, ParticleEffectPlayer } from '@forgeax/engine-vfx';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import {
  BrotatoEnemy,
  BrotatoEnemyStats,
  BrotatoInput,
  BrotatoPickupMotion,
  BrotatoPickupTag,
  BrotatoPlayer,
  BrotatoProjectileMotion,
  BrotatoProjectileTag,
  BrotatoStats,
  BrotatoVfxCarrier,
  BrotatoWeapon,
} from './components';
import { createBrotatoHud, type BrotatoHud, type BrotatoHudSnapshot, type BrotatoPhase } from './hud';

export const BROTATO_STATE_KEY = 'Brotato3dGameState';

const INPUT_SYSTEM_NAME = 'brotato-3d-input';
const COMBAT_SYSTEM_NAME = 'brotato-3d-combat';
const PRESENTATION_SYSTEM_NAME = 'brotato-3d-presentation';
const CAMERA_SYSTEM_NAME = 'brotato-3d-camera-follow';
const ARENA_LIMIT = 14;
const CAMERA_DEAD_ZONE = 6.4;
const CAMERA_MAX_OFFSET = 3.2;
const MAX_ENEMIES = 24;
const MAX_PROJECTILES = 64;
const PLAYER_MAX_HEALTH = 5;
const PLAYER_SPEED = 6.2;
const ENEMY_SPAWN_RADIUS = 12.2;

const BROTATO_PACKAGE_ID = '019fb264-3000-7000-8000-000000000000';
const BROTATO_PACKAGE_NAMESPACE = (() => {
  const parsed = PackageId.parse(BROTATO_PACKAGE_ID);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
})();
const BROTATO_UI_PACKAGE_ID = '019fb264-3000-7000-8000-000000000091';
const BROTATO_UI_PACKAGE_NAMESPACE = (() => {
  const parsed = PackageId.parse(BROTATO_UI_PACKAGE_ID);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
})();
const BROTATO_IMPACT_PACKAGE_ID = '019fb264-3000-7000-8000-000000000080';
const BROTATO_IMPACT_PACKAGE_NAMESPACE = (() => {
  const parsed = PackageId.parse(BROTATO_IMPACT_PACKAGE_ID);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
})();

function brotatoAssetGuid(sourceKey: string): string {
  return AssetGuid.format(AssetGuid.derive(BROTATO_PACKAGE_NAMESPACE, sourceKey));
}

function brotatoUiAssetGuid(sourceKey: string): string {
  return AssetGuid.format(AssetGuid.derive(BROTATO_UI_PACKAGE_NAMESPACE, sourceKey));
}

function brotatoImpactAssetGuid(sourceKey: string): string {
  return AssetGuid.format(AssetGuid.derive(BROTATO_IMPACT_PACKAGE_NAMESPACE, sourceKey));
}

export const BROTATO_INPUT_MAP: readonly ActionConfig[] = [
  { action: 'moveUp', bindings: [{ type: 'key', key: 'w' }, { type: 'key', key: 'W' }, { type: 'gamepadAxis', axis: 1, sign: -1 }] },
  { action: 'moveDown', bindings: [{ type: 'key', key: 's' }, { type: 'key', key: 'S' }, { type: 'gamepadAxis', axis: 1, sign: 1 }] },
  { action: 'moveLeft', bindings: [{ type: 'key', key: 'a' }, { type: 'key', key: 'A' }, { type: 'gamepadAxis', axis: 0, sign: -1 }] },
  { action: 'moveRight', bindings: [{ type: 'key', key: 'd' }, { type: 'key', key: 'D' }, { type: 'gamepadAxis', axis: 0, sign: 1 }] },
  { action: 'fire', bindings: [{ type: 'key', key: ' ' }, { type: 'mouseButton', button: 0 }, { type: 'gamepadButton', button: 0 }] },
  { action: 'restart', bindings: [{ type: 'key', key: 'r' }, { type: 'key', key: 'R' }, { type: 'gamepadButton', button: 1 }] },
];

type MaterialHandle = Handle<'MaterialAsset', 'shared'>;

interface BrotatoMaterials {
  readonly floor: MaterialHandle;
  readonly tileA: MaterialHandle;
  readonly tileB: MaterialHandle;
  readonly wall: MaterialHandle;
  readonly player: MaterialHandle;
  readonly playerHit: MaterialHandle;
  readonly weapon: MaterialHandle;
  readonly weaponAccent: MaterialHandle;
  readonly enemy: MaterialHandle;
  readonly elite: MaterialHandle;
  readonly projectile: MaterialHandle;
  readonly pickup: MaterialHandle;
  readonly vfx: MaterialHandle;
}

interface BrotatoMeshes {
  readonly player: Handle<'MeshAsset', 'shared'>;
  readonly weapon: Handle<'MeshAsset', 'shared'>;
  readonly enemy: Handle<'MeshAsset', 'shared'>;
  readonly elite: Handle<'MeshAsset', 'shared'>;
  readonly projectile: Handle<'MeshAsset', 'shared'>;
  readonly pickup: Handle<'MeshAsset', 'shared'>;
}

interface BrotatoScenes {
  readonly arena: SceneAsset;
  readonly player: SceneAsset;
  readonly enemy: SceneAsset;
  readonly weapon: SceneAsset;
}

export interface BrotatoState {
  phase: BrotatoPhase;
  score: number;
  kills: number;
  wave: number;
  elapsed: number;
  enemyCount: number;
  projectileCount: number;
  spawnTimer: number;
  fireTimer: number;
  fireTargetCursor: number;
  randomState: number;
  resetRequested: boolean;
  hitFlash: number;
  playerHitVisual: boolean;
}

export interface BrotatoRuntime {
  readonly snapshot: () => BrotatoHudSnapshot;
  readonly requestReset: () => void;
  readonly dispose: () => void;
}

export interface BrotatoGameOptions {
  /** Keeps the player alive for bounded long-run performance captures only. */
  readonly survivalMode?: boolean;
  /** Diagnostic-only workload switch; the default gameplay still drops pickups. */
  readonly disablePickupDrops?: boolean;
  /** Diagnostic-only workload switch; the default gameplay keeps GPU VFX enabled. */
  readonly disableParticles?: boolean;
}

async function loadAsset<P extends { readonly kind: string }>(
  assets: AssetRegistry,
  guidText: string,
  kind: P['kind'],
): Promise<P> {
  const parsed = AssetGuid.parse(guidText);
  if (!parsed.ok) throw new Error(`Brotato asset GUID is invalid: ${guidText}`);
  const loaded = await assets.loadByGuid<P>(parsed.value);
  if (!loaded.ok) throw new Error(`Brotato asset load failed for ${guidText}: ${loaded.error.code} ${loaded.error.hint}`);
  if (loaded.value.kind !== kind) {
    throw new Error(`Brotato asset kind mismatch for ${guidText}: expected ${kind}, received ${loaded.value.kind}`);
  }
  return loaded.value;
}

async function loadMaterial(world: World, assets: AssetRegistry, guidText: string): Promise<MaterialHandle> {
  return world.allocSharedRef('MaterialAsset', await loadAsset<MaterialAsset>(assets, guidText, 'material'));
}

async function loadMesh(world: World, assets: AssetRegistry, guidText: string): Promise<Handle<'MeshAsset', 'shared'>> {
  return world.allocSharedRef('MeshAsset', await loadAsset<MeshAsset>(assets, guidText, 'mesh'));
}

async function loadMaterials(world: World, assets: AssetRegistry): Promise<BrotatoMaterials> {
  const [floor, tileA, tileB, wall, player, playerHit, weapon, weaponAccent, enemy, elite, projectile, pickup, vfx] = await Promise.all([
    loadMaterial(world, assets, brotatoAssetGuid("material/arena-floor")),
    loadMaterial(world, assets, brotatoAssetGuid("material/arena-tile-a")),
    loadMaterial(world, assets, brotatoAssetGuid("material/arena-tile-b")),
    loadMaterial(world, assets, brotatoAssetGuid("material/arena-wall")),
    loadMaterial(world, assets, brotatoAssetGuid("material/player")),
    loadMaterial(world, assets, brotatoAssetGuid("material/player-hit")),
    loadMaterial(world, assets, brotatoAssetGuid("material/weapon")),
    loadMaterial(world, assets, brotatoAssetGuid("material/weapon-accent")),
    loadMaterial(world, assets, brotatoAssetGuid("material/enemy")),
    loadMaterial(world, assets, brotatoAssetGuid("material/elite")),
    loadMaterial(world, assets, brotatoAssetGuid("material/projectile")),
    loadMaterial(world, assets, brotatoAssetGuid("material/pickup")),
    loadMaterial(world, assets, brotatoImpactAssetGuid("material/vfx")),
  ]);
  return { floor, tileA, tileB, wall, player, playerHit, weapon, weaponAccent, enemy, elite, projectile, pickup, vfx };
}

async function loadMeshes(world: World, assets: AssetRegistry): Promise<BrotatoMeshes> {
  const [player, weapon, enemy, elite, projectile, pickup] = await Promise.all([
    loadMesh(world, assets, brotatoAssetGuid("mesh/player")),
    loadMesh(world, assets, brotatoAssetGuid("mesh/weapon")),
    loadMesh(world, assets, brotatoAssetGuid("mesh/enemy")),
    loadMesh(world, assets, brotatoAssetGuid("mesh/elite")),
    loadMesh(world, assets, brotatoAssetGuid("mesh/projectile")),
    loadMesh(world, assets, brotatoAssetGuid("mesh/pickup")),
  ]);
  return { player, weapon, enemy, elite, projectile, pickup };
}

async function loadScenes(assets: AssetRegistry): Promise<BrotatoScenes> {
  const [arena, player, enemy, weapon] = await Promise.all([
    loadAsset<SceneAsset>(assets, brotatoAssetGuid("scene/arena"), 'scene'),
    loadAsset<SceneAsset>(assets, brotatoAssetGuid("scene/player"), 'scene'),
    loadAsset<SceneAsset>(assets, brotatoAssetGuid("scene/enemy"), 'scene'),
    loadAsset<SceneAsset>(assets, brotatoAssetGuid("scene/weapon"), 'scene'),
  ]);
  return { arena, player, enemy, weapon };
}

async function loadUiAsset(assets: AssetRegistry, guidText: string): Promise<UiAsset | undefined> {
  const parsed = AssetGuid.parse(guidText);
  if (!parsed.ok) return undefined;
  const loaded = await assets.loadByGuid<UiAsset>(parsed.value);
  return loaded.ok ? loaded.value : undefined;
}

async function instantiateSceneMember(
  world: World,
  assets: AssetRegistry,
  scene: SceneAsset,
): Promise<{ readonly root: EntityHandle; readonly member: EntityHandle }> {
  const handle = world.allocSharedRef('SceneAsset', scene);
  const instance = assets.instantiate<SceneAsset>(handle, world);
  if (!instance.ok) throw new Error(`Brotato SceneAsset instantiate failed: ${instance.error.code}`);
  const sceneState = world.get(instance.value, SceneInstance);
  if (!sceneState.ok) throw new Error('Brotato SceneAsset instance has no SceneInstance state');
  const member = sceneState.value.mapping[0];
  if (member === undefined) throw new Error('Brotato SceneAsset instance has no root member');
  return { root: instance.value, member: member as EntityHandle };
}

function particleCameraSource(camera: EntityHandle) {
  return {
    read(world: World) {
      const transform = world.get(camera, Transform);
      const cameraValue = world.get(camera, Camera);
      if (!transform.ok || !cameraValue.ok) return undefined;
      const position = new Float32Array(transform.value.pos);
      const rotation = transform.value.quat;
      const right = quat.right(vec3.create(), rotation);
      const up = quat.up(vec3.create(), rotation);
      const forward = quat.forward(vec3.create(), rotation);
      const target = vec3.create();
      vec3.add(target, position, forward);
      const view = mat4.lookAt(mat4.create(), position, target, up);
      const projection = cameraValue.value.projection === 1
        ? mat4.orthographicReverseZ(
            mat4.create(),
            cameraValue.value.left,
            cameraValue.value.right,
            cameraValue.value.top,
            cameraValue.value.bottom,
            cameraValue.value.near,
            cameraValue.value.far,
          )
        : mat4.multiply(mat4.create(), mat4.perspectiveReverseZ(mat4.create(), cameraValue.value.fov, cameraValue.value.aspect, cameraValue.value.near, cameraValue.value.far), mat4.lookAt(mat4.create(), position, target, up));
      return {
        position,
        right,
        up,
        viewProjection: cameraValue.value.projection === 1 ? mat4.multiply(mat4.create(), projection, view) : projection,
      };
    },
  };
}

interface BrotatoVfx {
  readonly impact: (position: readonly [number, number, number], commands: CommandBuffer) => void;
  readonly dispose: () => Promise<void>;
}

async function createBrotatoVfx(
  context: Context,
  world: World,
  assets: AssetRegistry,
  camera: EntityHandle,
): Promise<BrotatoVfx> {
  const noop: BrotatoVfx = { impact: () => undefined, dispose: async () => undefined };
  const host = createVfxRuntimeHost({ camera: particleCameraSource(camera) });
  const attached = await host.attachWorld({ world, assets });
  if (!attached.ok) return noop;
  const loaded = await loadVfxGpuEffect(assets, brotatoAssetGuid("vfx/impact"));
  if (!loaded.ok) {
    await host.detachWorld({ world });
    return noop;
  }
  const effect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
  let featureFiber: Awaited<ReturnType<Context['plugin']>>;
  try {
    featureFiber = await context.plugin(renderFeaturePlugin(host.feature));
  } catch {
    await host.detachWorld({ world });
    return noop;
  }
  const controlResult = host.acquireControl(world);
  const control = controlResult.ok ? controlResult.value : undefined;
  let seed = 0;
  let activeImpacts = 0;
  world.addSystem(FixedUpdate, {
    name: 'brotato-3d-vfx-cleanup',
    queries: [{ write: [BrotatoVfxCarrier, ParticleEffectPlayer] }],
    fn: (world, [carriers], commands) => {
      const dt = world.getResource(FixedTime).delta;
      for (const row of carriers) {
        const carrier = row.mut(BrotatoVfxCarrier);
        carrier.ttl -= dt;
        if (carrier.ttl <= 0) {
          activeImpacts = Math.max(0, activeImpacts - 1);
          row.mut(ParticleEffectPlayer).playing = false;
          control?.setPlayerRenderConsumption({ player: row.entity, enabled: false });
          commands.despawn(row.entity);
        }
      }
    },
  }).unwrap();
  let disposed = false;
  return {
    impact: (position, commands) => {
      if (disposed) return;
      activeImpacts += 1;
      commands.spawn(
        { component: Transform, data: { pos: [...position] } },
        { component: ParticleEffectPlayer, data: { effect, playing: true, seed: seed++, timeScale: 1 } },
        { component: BrotatoVfxCarrier, data: { ttl: 0.68 } },
      );
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      world.removeSystem(FixedUpdate, 'brotato-3d-vfx-cleanup');
      const active = world.query({ with: [BrotatoVfxCarrier, ParticleEffectPlayer] });
      if (active.ok) {
        for (const row of active.value) {
          control?.setPlayerRenderConsumption({ player: row.entity, enabled: false });
          world.despawn(row.entity);
        }
      }
      activeImpacts = 0;
      await host.detachWorld({ world });
      await featureFiber.dispose();
    },
  };
}

function setYaw(transform: { quat: Float32Array }, angle: number): void {
  const halfAngle = angle * 0.5;
  transform.quat[0] = 0;
  transform.quat[1] = Math.sin(halfAngle);
  transform.quat[2] = 0;
  transform.quat[3] = Math.cos(halfAngle);
}

function yawQuaternion(angle: number): readonly [number, number, number, number] {
  const halfAngle = angle * 0.5;
  return [0, Math.sin(halfAngle), 0, Math.cos(halfAngle)];
}

function spawnEnemyNow(
  world: World,
  materials: BrotatoMaterials,
  meshes: BrotatoMeshes,
  angle: number,
  radius: number,
  elite: boolean,
): EntityHandle {
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  const scale = elite ? ([0.86, 0.86, 0.86] as const) : ([0.62, 0.62, 0.62] as const);
  return world
    .spawn(
      { component: Transform, data: { pos: [x, elite ? 0.86 : 0.62, z], scale } },
      { component: MeshFilter, data: { assetHandle: elite ? meshes.elite : meshes.enemy } },
      { component: MeshRenderer, data: { materials: [elite ? materials.elite : materials.enemy, materials.weapon] } },
      { component: BrotatoEnemy, data: {} },
      {
        component: BrotatoEnemyStats,
        data: {
          health: elite ? 4 : 2,
          maxHealth: elite ? 4 : 2,
          speed: elite ? 1.15 : 1.65,
          attackCooldown: 0,
        },
      },
    )
    .unwrap();
}

function spawnEnemyDeferred(
  commands: CommandBuffer,
  materials: BrotatoMaterials,
  meshes: BrotatoMeshes,
  angle: number,
  radius: number,
  elite: boolean,
): void {
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  const scale = elite ? ([0.86, 0.86, 0.86] as const) : ([0.62, 0.62, 0.62] as const);
  commands.spawn(
    { component: Transform, data: { pos: [x, elite ? 0.86 : 0.62, z], scale } },
    { component: MeshFilter, data: { assetHandle: elite ? meshes.elite : meshes.enemy } },
    { component: MeshRenderer, data: { materials: [elite ? materials.elite : materials.enemy, materials.weapon] } },
    { component: BrotatoEnemy, data: {} },
    {
      component: BrotatoEnemyStats,
      data: {
        health: elite ? 4 : 2,
        maxHealth: elite ? 4 : 2,
        speed: elite ? 1.15 : 1.65,
        attackCooldown: 0,
      },
    },
  );
}

function spawnPickup(commands: CommandBuffer, materials: BrotatoMaterials, meshes: BrotatoMeshes, x: number, z: number): void {
  commands.spawn(
    {
      component: Transform,
      data: {
        pos: [x, 0.35, z],
        scale: [0.3, 0.22, 0.3],
      },
    },
    { component: MeshFilter, data: { assetHandle: meshes.pickup } },
    { component: MeshRenderer, data: { materials: [materials.pickup] } },
    { component: BrotatoPickupTag, data: {} },
    { component: BrotatoPickupMotion, data: { value: 8, spin: 0 } },
  );
}

function nextRandom(state: BrotatoState): number {
  state.randomState = (state.randomState * 1664525 + 1013904223) >>> 0;
  return state.randomState / 4294967296;
}

function countAndDespawn(world: World, tag: typeof BrotatoEnemy | typeof BrotatoProjectileTag | typeof BrotatoPickupTag): void {
  const result = world.query({ read: [Transform], with: [tag] });
  if (!result.ok) return;
  const entities: EntityHandle[] = [];
  for (const row of result.value) entities.push(row.entity);
  for (const entity of entities) world.despawn(entity);
}

function snapshot(world: World, state: BrotatoState, player: EntityHandle): BrotatoHudSnapshot {
  const stats = world.get(player, BrotatoStats);
  const health = stats.ok ? stats.value.health : 0;
  const maxHealth = stats.ok ? stats.value.maxHealth : PLAYER_MAX_HEALTH;
  return {
    phase: state.phase,
    score: state.score,
    kills: state.kills,
    wave: state.wave,
    elapsed: state.elapsed,
    health,
    maxHealth,
    enemies: state.enemyCount,
    projectiles: state.projectileCount,
  };
}

function resetRun(
  world: World,
  state: BrotatoState,
  player: EntityHandle,
  enemies: Iterable<{ readonly entity: EntityHandle }>,
  projectiles: Iterable<{ readonly entity: EntityHandle }>,
  pickups: Iterable<{ readonly entity: EntityHandle }>,
  commands: CommandBuffer,
  materials: BrotatoMaterials,
  meshes: BrotatoMeshes,
): void {
  for (const row of enemies) commands.despawn(row.entity);
  for (const row of projectiles) commands.despawn(row.entity);
  for (const row of pickups) commands.despawn(row.entity);
  state.phase = 'playing';
  state.score = 0;
  state.kills = 0;
  state.wave = 1;
  state.elapsed = 0;
  state.enemyCount = 0;
  state.projectileCount = 0;
  state.spawnTimer = 0.5;
  state.fireTimer = 0.05;
  state.fireTargetCursor = 0;
  state.randomState = 0xdecafbad;
  state.resetRequested = false;
  state.hitFlash = 0;
  state.playerHitVisual = false;
  world.set(player, BrotatoStats, {
    health: PLAYER_MAX_HEALTH,
    maxHealth: PLAYER_MAX_HEALTH,
    invulnerability: 0,
  });
  world.set(player, BrotatoInput, { moveX: 0, moveZ: 0, fire: 0 });
  world.set(player, Transform, { pos: [0, 0.72, 0], quat: [0, 0, 0, 1] });
  for (let index = 0; index < 10; index += 1) {
    spawnEnemyDeferred(commands, materials, meshes, index * Math.PI * 0.2, 7.6 + (index % 2) * 1.1, index === 0);
  }
}

function installInputSystem(
  world: World,
  player: EntityHandle,
  state: BrotatoState,
  materials: BrotatoMaterials,
  meshes: BrotatoMeshes,
): void {
  world
    .addSystem(Update, {
      name: INPUT_SYSTEM_NAME,
      after: ['input-frame-start-scan'],
      queries: [
        { read: [BrotatoEnemyStats, Transform], with: [BrotatoEnemy] },
        { read: [BrotatoProjectileMotion, Transform], with: [BrotatoProjectileTag] },
        { read: [BrotatoPickupMotion, Transform], with: [BrotatoPickupTag] },
      ],
      fn: (world, [enemies, projectiles, pickups], commands) => {
        if (!world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)) return;
        const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        if (state.resetRequested || input.action('restart').justPressed()) {
          resetRun(world, state, player, enemies, projectiles, pickups, commands, materials, meshes);
          return;
        }
        if (state.phase !== 'playing') {
          world.set(player, BrotatoInput, { moveX: 0, moveZ: 0, fire: 0 });
          return;
        }
        const vector = input.getVector('moveLeft', 'moveRight', 'moveUp', 'moveDown');
        world.set(player, BrotatoInput, {
          moveX: vector.x,
          moveZ: vector.y,
          fire: input.action('fire').isPressed() ? 1 : 0,
        });
      },
    })
    .unwrap();
}

function installCombatSystem(
  world: World,
  player: EntityHandle,
  state: BrotatoState,
  materials: BrotatoMaterials,
  meshes: BrotatoMeshes,
  impact: BrotatoVfx['impact'],
  survivalMode: boolean,
  disablePickupDrops: boolean,
): void {
  const deadEnemies: EntityHandle[] = [];
  const fireTargetEntities: EntityHandle[] = [];
  const fireTargetXs: number[] = [];
  const fireTargetZs: number[] = [];
  world
    .addSystem(FixedUpdate, {
      name: COMBAT_SYSTEM_NAME,
      queries: [
        { write: [Transform, BrotatoStats], read: [BrotatoInput], with: [BrotatoPlayer] },
        { write: [Transform], with: [BrotatoWeapon] },
        { write: [Transform, BrotatoEnemyStats], with: [BrotatoEnemy] },
        { write: [Transform, BrotatoProjectileMotion], with: [BrotatoProjectileTag] },
        { write: [Transform, BrotatoPickupMotion], with: [BrotatoPickupTag] },
      ],
      fn: (world, [players, weapons, enemies, projectiles, pickups], commands) => {
        const dt = world.getResource(FixedTime).delta;
        state.elapsed += dt;
        state.wave = 1 + Math.floor(state.elapsed / 18);
        state.hitFlash = Math.max(0, state.hitFlash - dt);
        if (state.phase !== 'playing') return;
        const playerRow = [...players][0];
        if (playerRow === undefined) return;
        const playerTransform = playerRow.mut(Transform);
        const playerStats = playerRow.mut(BrotatoStats);
        const input = playerRow.get(BrotatoInput);
        playerStats.invulnerability = Math.max(0, playerStats.invulnerability - dt);
        playerTransform.pos[0] = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, (playerTransform.pos[0] ?? 0) + input.moveX * PLAYER_SPEED * dt));
        playerTransform.pos[2] = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, (playerTransform.pos[2] ?? 0) + input.moveZ * PLAYER_SPEED * dt));
        playerTransform.pos[1] = 0.72;

        let enemyCount = 0;
        let nearestDistance = Number.POSITIVE_INFINITY;
        const playerX = playerTransform.pos[0] ?? 0;
        const playerZ = playerTransform.pos[2] ?? 0;
        let targetX = playerX;
        let targetZ = playerZ - 1;
        fireTargetEntities.length = 0;
        fireTargetXs.length = 0;
        fireTargetZs.length = 0;
        for (const enemyRow of enemies) {
          enemyCount += 1;
          const enemyTransform = enemyRow.mut(Transform);
          const enemyStats = enemyRow.mut(BrotatoEnemyStats);
          enemyStats.attackCooldown = Math.max(0, enemyStats.attackCooldown - dt);
          const enemyX = enemyTransform.pos[0] ?? 0;
          const enemyZ = enemyTransform.pos[2] ?? 0;
          const dx = playerX - enemyX;
          const dz = playerZ - enemyZ;
          const distance = Math.hypot(dx, dz);
          if (distance > 0.001) {
            const step = enemyStats.speed * dt / distance;
            enemyTransform.pos[0] = enemyX + dx * step;
            enemyTransform.pos[2] = enemyZ + dz * step;
            setYaw(enemyTransform, state.elapsed * (enemyStats.speed * 0.4));
          }
          const movedEnemyX = enemyTransform.pos[0] ?? 0;
          const movedEnemyZ = enemyTransform.pos[2] ?? 0;
          const movedDx = playerX - movedEnemyX;
          const movedDz = playerZ - movedEnemyZ;
          const movedDistance = Math.hypot(movedDx, movedDz);
          fireTargetEntities.push(enemyRow.entity);
          fireTargetXs.push(movedEnemyX);
          fireTargetZs.push(movedEnemyZ);
          if (movedDistance < nearestDistance) {
            nearestDistance = movedDistance;
            targetX = movedEnemyX;
            targetZ = movedEnemyZ;
          }
          if (!survivalMode && movedDistance < 1.15 && enemyStats.attackCooldown <= 0 && playerStats.invulnerability <= 0) {
            playerStats.health = Math.max(0, playerStats.health - 1);
            playerStats.invulnerability = 0.95;
            enemyStats.attackCooldown = 1.1;
            state.hitFlash = 0.22;
            if (playerStats.health <= 0) state.phase = 'defeated';
          }
        }
        state.enemyCount = enemyCount;
        if (state.phase !== 'playing') {
          if (!state.playerHitVisual) {
            world.set(player, MeshRenderer, { materials: [materials.playerHit, materials.weapon] });
            state.playerHitVisual = true;
          }
          return;
        }
        const playerHitVisual = state.hitFlash > 0;
        if (state.playerHitVisual !== playerHitVisual) {
          world.set(player, MeshRenderer, {
            materials: [playerHitVisual ? materials.playerHit : materials.player, materials.weapon],
          });
          state.playerHitVisual = playerHitVisual;
        }

        const fireTargetIndex = fireTargetEntities.length > 0 ? state.fireTargetCursor % fireTargetEntities.length : -1;
        const aimX = fireTargetIndex >= 0 ? (fireTargetXs[fireTargetIndex] ?? targetX) : targetX;
        const aimZ = fireTargetIndex >= 0 ? (fireTargetZs[fireTargetIndex] ?? targetZ) : targetZ;
        const dx = aimX - playerX;
        const dz = aimZ - playerZ;
        const distance = Math.hypot(dx, dz) || 1;
        const directionX = dx / distance;
        const directionZ = dz / distance;
        for (const row of weapons) {
          const weaponTransform = row.mut(Transform);
          weaponTransform.pos[0] = playerX + directionX * 1.05;
          weaponTransform.pos[1] = 1.16 + Math.sin(state.elapsed * 6) * 0.08;
          weaponTransform.pos[2] = playerZ + directionZ * 1.05;
          setYaw(weaponTransform, Math.atan2(directionX, directionZ));
          break;
        }

        let oldestProjectile: EntityHandle | undefined;
        let oldestProjectileLifetime = Number.POSITIVE_INFINITY;
        for (const projectileRow of projectiles) {
          const lifetime = projectileRow.get(BrotatoProjectileMotion).lifetime;
          if (lifetime < oldestProjectileLifetime) {
            oldestProjectileLifetime = lifetime;
            oldestProjectile = projectileRow.entity;
          }
        }
        let recycledProjectile: EntityHandle | undefined;
        state.fireTimer -= dt;
        if (state.fireTimer <= 0 && enemyCount > 0) {
          const cadence = survivalMode
            ? (input.fire > 0.5 ? 0.05 : 0.08)
            : input.fire > 0.5
              ? 0.12
              : 0.24;
          // Attack speed is this cooldown. Projectile travel speed stays independent.
          const projectileSpeed = 14;
          state.fireTimer = cadence;
          state.fireTargetCursor = (state.fireTargetCursor + 1) % fireTargetEntities.length;
          if (state.projectileCount >= MAX_PROJECTILES && oldestProjectile !== undefined) {
            recycledProjectile = oldestProjectile;
            commands.despawn(recycledProjectile);
          }
          commands.spawn(
            {
              component: Transform,
              data: {
                pos: [playerX + directionX * 0.9, 0.76, playerZ + directionZ * 0.9],
                scale: [0.42, 0.42, 0.42],
                quat: yawQuaternion(Math.atan2(directionX, directionZ)),
              },
            },
            { component: MeshFilter, data: { assetHandle: meshes.projectile } },
            { component: MeshRenderer, data: { materials: [materials.projectile, materials.weaponAccent] } },
            { component: BrotatoProjectileTag, data: {} },
            {
              component: BrotatoProjectileMotion,
              data: {
                vx: directionX * projectileSpeed,
                vz: directionZ * projectileSpeed,
                damage: 1,
                lifetime: 2.2,
              },
            },
          );
        }

        deadEnemies.length = 0;
        let activeProjectileCount = 0;
        for (const projectileRow of projectiles) {
          if (projectileRow.entity === recycledProjectile) continue;
          const projectileTransform = projectileRow.mut(Transform);
          const projectile = projectileRow.mut(BrotatoProjectileMotion);
          projectileTransform.pos[0] = (projectileTransform.pos[0] ?? 0) + projectile.vx * dt;
          projectileTransform.pos[2] = (projectileTransform.pos[2] ?? 0) + projectile.vz * dt;
          projectile.lifetime -= dt;
          const projectileX = projectileTransform.pos[0] ?? 0;
          const projectileZ = projectileTransform.pos[2] ?? 0;
          if (projectile.lifetime <= 0 || Math.abs(projectileX) > 13 || Math.abs(projectileZ) > 13) {
            commands.despawn(projectileRow.entity);
            continue;
          }
          let consumed = false;
          for (const enemyRow of enemies) {
            if (deadEnemies.includes(enemyRow.entity)) continue;
            const enemyTransform = enemyRow.mut(Transform);
            const enemyStats = enemyRow.mut(BrotatoEnemyStats);
            const enemyX = enemyTransform.pos[0] ?? 0;
            const enemyZ = enemyTransform.pos[2] ?? 0;
            const projectileDx = projectileX - enemyX;
            const projectileDz = projectileZ - enemyZ;
            if (projectileDx * projectileDx + projectileDz * projectileDz > 0.78 * 0.78) continue;
            enemyStats.health -= projectile.damage;
            impact([enemyX, 0.55, enemyZ], commands);
            commands.despawn(projectileRow.entity);
            consumed = true;
            if (enemyStats.health <= 0) {
              deadEnemies.push(enemyRow.entity);
              state.kills += 1;
              state.score += enemyStats.maxHealth >= 4 ? 30 : 10;
              if (!disablePickupDrops && nextRandom(state) > 0.48) {
                spawnPickup(commands, materials, meshes, enemyX, enemyZ);
              }
            }
            break;
          }
          if (!consumed) activeProjectileCount += 1;
        }
        for (const enemy of deadEnemies) commands.despawn(enemy);
        state.projectileCount = activeProjectileCount;

        for (const pickupRow of pickups) {
          const pickupTransform = pickupRow.mut(Transform);
          const pickup = pickupRow.mut(BrotatoPickupMotion);
          pickup.spin += dt * 3.2;
          setYaw(pickupTransform, pickup.spin);
          pickupTransform.pos[1] = 0.38 + Math.sin(state.elapsed * 4 + pickup.spin) * 0.08;
          if (Math.hypot((pickupTransform.pos[0] ?? 0) - playerX, (pickupTransform.pos[2] ?? 0) - playerZ) < 1.1) {
            state.score += pickup.value;
            playerStats.health = Math.min(playerStats.maxHealth, playerStats.health + 1);
            commands.despawn(pickupRow.entity);
          }
        }

        state.spawnTimer -= dt;
        if (state.spawnTimer <= 0 && enemyCount < MAX_ENEMIES) {
          const spawnCount = Math.min(MAX_ENEMIES - enemyCount, state.wave >= 4 && nextRandom(state) > 0.65 ? 2 : 1);
          for (let index = 0; index < spawnCount; index += 1) {
            const angle = nextRandom(state) * Math.PI * 2;
            const radius = ENEMY_SPAWN_RADIUS + nextRandom(state) * 2.1;
            const elite = state.wave >= 2 && nextRandom(state) > 0.84;
            spawnEnemyDeferred(commands, materials, meshes, angle, radius, elite);
          }
          const spawnCadence = survivalMode
            ? Math.max(0.18, 0.42 - state.wave * 0.025)
            : Math.max(0.24, 0.72 - state.wave * 0.045);
          state.spawnTimer = spawnCadence;
        }
      },
    })
    .unwrap();
}

function installPresentationSystem(world: World, player: EntityHandle, state: BrotatoState, hud: BrotatoHud): void {
  world
    .addSystem(Update, {
      name: PRESENTATION_SYSTEM_NAME,
      after: [FixedUpdate],
      queries: [],
      fn: (world) => hud.update(snapshot(world, state, player)),
    })
    .unwrap();
}

function installCameraFollowSystem(world: World): void {
  world
    .addSystem(Update, {
      name: CAMERA_SYSTEM_NAME,
      after: [FixedUpdate],
      queries: [
        { read: [Transform], with: [BrotatoPlayer] },
        { write: [Transform], with: [Camera] },
      ],
      fn: (world, [players, cameras]) => {
        const playerRow = [...players][0];
        const cameraRow = [...cameras][0];
        if (playerRow === undefined || cameraRow === undefined) return;
        const playerTransform = playerRow.get(Transform);
        const cameraTransform = cameraRow.mut(Transform);
        const playerX = playerTransform.pos[0] ?? 0;
        const playerZ = playerTransform.pos[2] ?? 0;
        const desiredX = Math.max(
          -CAMERA_MAX_OFFSET,
          Math.min(CAMERA_MAX_OFFSET, Math.sign(playerX) * Math.max(0, Math.abs(playerX) - CAMERA_DEAD_ZONE) * 0.42),
        );
        const desiredZ = Math.max(
          -CAMERA_MAX_OFFSET * 0.7,
          Math.min(CAMERA_MAX_OFFSET * 0.7, Math.sign(playerZ) * Math.max(0, Math.abs(playerZ) - CAMERA_DEAD_ZONE) * 0.3),
        );
        const dt = world.getResource(Time).delta;
        const alpha = 1 - Math.exp(-Math.max(0, dt) * 8);
        const cameraX = cameraTransform.pos[0] ?? 0;
        const cameraZ = cameraTransform.pos[2] ?? 7;
        cameraTransform.pos[0] = cameraX + (desiredX - cameraX) * alpha;
        cameraTransform.pos[2] = cameraZ + (7 + desiredZ - cameraZ) * alpha;
        // Keep the authored top-down orientation parallel while the camera
        // translates only after the player leaves the dead zone. Rebuilding a
        // look-at target from the camera position here makes the view orbit
        // and reads as rotation instead of the intended bounded follow.
      },
    })
    .unwrap();
}

export async function createBrotatoGame(
  context: Context,
  world: World,
  host: GameHost,
  assets: AssetRegistry,
  options: BrotatoGameOptions = {},
): Promise<BrotatoRuntime> {
  const [materials, meshes, scenes] = await Promise.all([
    loadMaterials(world, assets),
    loadMeshes(world, assets),
    loadScenes(assets),
  ]);
  const ownedEntities: EntityHandle[] = [];
  const ownedSceneRoots: EntityHandle[] = [];
  const cameraQuat = quat.fromLookAt(quat.create(), [0, 24, 7], [0, 0, 0], [0, 1, 0]);
  const canvas = host.canvas;
  if (canvas === undefined) throw new Error('Brotato scene requires a presentation canvas');
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 24, 7], quat: cameraQuat } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: canvas.width / Math.max(1, canvas.height), near: 0.1, far: 100 }),
          clearColor: [0.018, 0.035, 0.075, 1],
          tonemap: TONEMAP_ACES_FILMIC,
          antialias: ANTIALIAS_FXAA,
          exposure: 1.22,
        },
      },
    )
    .unwrap();
  ownedEntities.push(camera);
  const arena = await instantiateSceneMember(world, assets, scenes.arena);
  ownedSceneRoots.push(arena.root);
  const playerScene = await instantiateSceneMember(world, assets, scenes.player);
  ownedSceneRoots.push(playerScene.root);
  const player = playerScene.member;
  world.set(player, Transform, { pos: [0, 0.72, 0], scale: [0.72, 0.72, 0.72] });
  world.addComponent(player, { component: BrotatoPlayer, data: {} });
  world.addComponent(player, { component: BrotatoInput, data: { moveX: 0, moveZ: 0, fire: 0 } });
  world.addComponent(player, { component: BrotatoStats, data: { health: PLAYER_MAX_HEALTH, maxHealth: PLAYER_MAX_HEALTH, invulnerability: 0 } });
  const weaponScene = await instantiateSceneMember(world, assets, scenes.weapon);
  ownedSceneRoots.push(weaponScene.root);
  const weapon = weaponScene.member;
  world.set(weapon, Transform, { pos: [0, 1.08, 0.72], scale: [0.92, 0.92, 0.92] });
  world.addComponent(weapon, { component: BrotatoWeapon, data: {} });

  for (let index = 0; index < 10; index += 1) {
    spawnEnemyNow(world, materials, meshes, index * Math.PI * 0.2, 7.6 + (index % 2) * 1.1, index === 0);
  }
  const state: BrotatoState = {
    phase: 'playing',
    score: 0,
    kills: 0,
    wave: 1,
    elapsed: 0,
    enemyCount: 10,
    projectileCount: 0,
    spawnTimer: 0.5,
    fireTimer: 0.05,
    fireTargetCursor: 0,
    randomState: 0xdecafbad,
    resetRequested: false,
    hitFlash: 0,
    playerHitVisual: false,
  };
  world.insertResource(BROTATO_STATE_KEY, state);
  world.insertResource(INPUT_MAP_KEY, BROTATO_INPUT_MAP);
  const hudAsset = await loadUiAsset(assets, brotatoUiAssetGuid("ui/hud"));
  const hud = createBrotatoHud(host, hudAsset);
  const vfx: BrotatoVfx = options.disableParticles
    ? { impact: () => undefined, dispose: async () => undefined }
    : await createBrotatoVfx(context, world, assets, camera);
  installInputSystem(world, player, state, materials, meshes);
  installCombatSystem(
    world,
    player,
    state,
    materials,
    meshes,
    vfx.impact,
    options.survivalMode === true,
    options.disablePickupDrops === true,
  );
  installCameraFollowSystem(world);
  installPresentationSystem(world, player, state, hud);

  const projectionDisposers: Array<() => void> = [];
  if (host.gameProjection !== undefined) {
    projectionDisposers.push(host.gameProjection.registerRead({
      id: 'brotato-3d.snapshot',
      title: 'Read Brotato 3D gameplay snapshot',
      description: 'Read the current run phase, score, health, wave, and active combat counts.',
      read: () => snapshot(world, state, player) as unknown as GameProjectionValue,
    }));
    projectionDisposers.push(host.gameProjection.registerAction({
      id: 'brotato-3d.reset',
      title: 'Restart Brotato 3D run',
      description: 'Request the same ECS reset path used by the R key.',
      run: () => {
        state.resetRequested = true;
        return { requested: true };
      },
    }));
  }

  let disposed = false;
  return {
    snapshot: () => snapshot(world, state, player),
    requestReset: () => {
      state.resetRequested = true;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (let index = projectionDisposers.length - 1; index >= 0; index -= 1) projectionDisposers[index]?.();
      world.removeSystem(Update, PRESENTATION_SYSTEM_NAME);
      world.removeSystem(Update, CAMERA_SYSTEM_NAME);
      world.removeSystem(FixedUpdate, COMBAT_SYSTEM_NAME);
      world.removeSystem(Update, INPUT_SYSTEM_NAME);
      void vfx.dispose();
      countAndDespawn(world, BrotatoEnemy);
      countAndDespawn(world, BrotatoProjectileTag);
      countAndDespawn(world, BrotatoPickupTag);
      for (const root of ownedSceneRoots) worldDespawnScene(world, root);
      for (const entity of ownedEntities) world.despawn(entity);
      world.removeResource(BROTATO_STATE_KEY);
      world.removeResource(INPUT_MAP_KEY);
      hud.dispose();
    },
  };
}
