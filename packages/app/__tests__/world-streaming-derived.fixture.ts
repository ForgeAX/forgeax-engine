import { defineSystem, Update, type World } from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { vec3 } from '@forgeax/engine-math';
import { Collider, ColliderShapeValue } from '@forgeax/engine-physics';
import type { RapierPhysicsWorld3D } from '@forgeax/engine-physics-rapier3d';
import { ChildOf, Mobility, Transform } from '@forgeax/engine-scene';
import type { LevelService } from '../src/levels/level-service';
import type { RuntimePackAssembly } from '../src/runtime-packs';
import { createWorldStreaming } from '../src/streaming/world-streaming';

const home = { x: 27, z: 0, activeRadius: 1, prepareRadius: 2 };
const destination = { ...home, x: 401 };

function holdAdmission(producer: RuntimePackAssembly['producer']) {
  let resume = () => {};
  const wait = new Promise<void>((resolve) => { resume = resolve; });
  let signal: AbortSignal | undefined;
  let packageId: string | undefined;
  let published = false;
  let withdrawn = false;
  let armed = true;
  return {
    async admit(content: Parameters<typeof producer.admit>[0], abort?: AbortSignal) {
      if (!armed) return producer.admit(content, abort);
      armed = false;
      signal = abort;
      packageId = content.source.packageId;
      const result = await producer.admit(content, abort);
      published = result.ok;
      await wait;
      return result;
    },
    withdraw(id: string) {
      producer.withdraw(id);
      if (id === packageId) withdrawn = true;
    },
    inspect: () => ({ published, cancelled: signal?.aborted === true, withdrawn }),
    release: () => resume(),
  };
}

export function installDerivedStreamingFixture(
  world: World,
  physics: RapierPhysicsWorld3D,
  levels: LevelService,
  producer: RuntimePackAssembly['producer'],
) {
  let held: ReturnType<typeof holdAdmission> | undefined;
  let publishAllPages = false;
  let running = false;
  const stream = createWorldStreaming(levels, {
    grid: { cellSize: 8, pageSize: 1 },
    buildUnitsPerStep: 1,
    scene: {
      namespace: '9ed86422-41ac-4697-9fc8-294ddfa58a75',
      revision: 'source-1',
      producer: {
        admit: (content, signal) => held?.admit(content, signal) ?? producer.admit(content, signal),
        withdraw: (id) => {
          if (held === undefined) producer.withdraw(id);
          else held.withdraw(id);
        },
      },
      packOptions: {
        sceneComponents: [ChildOf, Collider, Mobility, Transform].map((component) =>
          ({ name: component.name, fields: componentSchema(component) })),
      },
      scene: {
        kind: 'scene',
        entities: {
          origin: { components: { Transform: { pos: [16, 0, 0] } } },
          floor: { components: {
            Transform: { pos: [11, 0, 0] }, ChildOf: { parent: 'origin' },
            Mobility: { kind: 0 }, Collider: { shape: ColliderShapeValue.cuboid },
          } },
          nextFloor: { components: {
            Transform: { pos: [destination.x, 0, 0] },
            Mobility: { kind: 0 }, Collider: { shape: ColliderShapeValue.cuboid },
          } },
        },
      },
      placements: [
        { key: 'origin', bounds: { minX: 16, maxX: 16, minZ: 0, maxZ: 0 }, role: 'collision' },
        { key: 'floor', bounds: { minX: 26, maxX: 28, minZ: -1, maxZ: 1 }, role: 'collision' },
        { key: 'nextFloor', bounds: { minX: 400, maxX: 402, minZ: -1, maxZ: 1 }, role: 'collision' },
      ],
    },
  }).unwrap();
  const system = defineSystem({ name: 'derived-streaming-fixture', queries: [], fn() {
    // Four buckets cover the cross-boundary home group. Pause before the destination pages.
    if (running && (publishAllPages || stream.inspect().index.pages < 4)) stream.step().unwrap();
  } });
  world.addSystem(Update, system).unwrap();
  const origin = vec3.create(home.x, 3, 0);
  const nextOrigin = vec3.create(destination.x, 3, 0);
  const down = vec3.create(0, -1, 0);

  return {
    request(kind: string) {
      if (kind === 'derived-enter') {
        running = true;
        stream.setSource('player', home).unwrap();
      }
      if (kind === 'derived-unread') {
        stream.setSource('player', destination).unwrap();
        // One publish grant opens only one of the two destination buckets.
        stream.step().unwrap();
      }
      if (kind === 'derived-restore-home') {
        stream.setSource('player', home).unwrap();
        publishAllPages = true;
      }
      if (kind === 'derived-share-home') stream.setSource('shared', home).unwrap();
      if (kind === 'derived-exit') stream.setSource('player', undefined).unwrap();
      if (kind === 'derived-exit-shared') stream.setSource('shared', undefined).unwrap();
      if (kind === 'derived-hold-destination') {
        held = holdAdmission(producer);
        stream.setSource('destination', destination).unwrap();
      }
      if (kind === 'derived-cancel-destination') stream.setSource('destination', undefined).unwrap();
      if (kind === 'derived-release-destination') held?.release();
      if (kind === 'derived-retry-destination') stream.setSource('destination', destination).unwrap();
      const state = stream.inspect();
      return {
        derived: {
          state: stream.inspectEntry('player').state,
          shared: stream.inspectEntry('shared').state,
          destination: stream.inspectEntry('destination').state,
          hit: physics.raycast(origin, down, 6)?.entity,
          nextHit: physics.raycast(nextOrigin, down, 6)?.entity,
          cells: state.index.cells,
          pendingPages: state.index.pendingPages,
          started: state.started,
          retired: state.retired,
          admission: held?.inspect(),
          error: state.failures[0]?.cause ?? state.active.find(({ failure }) => failure)?.failure,
        },
      };
    },
    dispose() {
      stream.close();
      held?.release();
      world.removeSystem(Update, system).unwrap();
    },
  };
}
