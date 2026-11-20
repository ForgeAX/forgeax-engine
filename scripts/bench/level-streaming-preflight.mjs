// Run with Bun after build:engine. This source-owner diagnostic does not qualify Render/native frames.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEVEL_STREAMING_SOURCE_COMPONENTS,
  preflightLevelRosterSteps,
  preflightLevelVocabularySteps,
} from '../../packages/app/src/levels/source-preflight.ts';
import { AssetRegistry } from '../../packages/assets-runtime/dist/index.mjs';
import {
  createSceneContentPublicationTask,
  runtimeAssets,
} from '../../packages/assets-runtime/dist/internal.mjs';
import { Disabled, Entity, World } from '../../packages/ecs/dist/index.mjs';
import { createStateProjection } from '../../packages/ecs/dist/projection/index.mjs';
import { buildMeshCollision, createBoxGeometry } from '../../packages/geometry/dist/index.mjs';
import { Collider, ColliderShapeValue, RigidBody } from '../../packages/physics/dist/index.mjs';
import {
  Instances,
  Layer,
  Materials,
  MeshFilter,
  MeshRenderer,
  SceneInstance,
  ShadowParticipation,
  Visibility,
} from '../../packages/render/dist/index.mjs';
import {
  ChildOf,
  Children,
  GlobalTransform,
  Mobility,
  Name,
  registerPropagateTransforms,
  Transform,
  worldApplyMountOverride,
} from '../../packages/scene/dist/index.mjs';
import {
  captureSceneSourceGuard,
  createSceneRetirement,
  prepareSceneTransformsSteps,
  retainSceneSourceReferences,
  worldInstantiateSceneSteps,
} from '../../packages/scene/dist/internal.mjs';
import { err, ok } from '../../packages/types/dist/index.mjs';

const profile = JSON.parse(
  await readFile(new URL('./level-streaming-profile.json', import.meta.url), 'utf8'),
);
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = resolve(process.argv[2] ?? '/tmp/forgeax-level-source-preflight-20261115.json');
if (output === root || output.startsWith(`${root}/`))
  throw new Error('raw measurements must be outside the source checkout');
const workload = profile.streetBlock;
const assets = new AssetRegistry(),
  world = new World({ assets }),
  records = runtimeAssets(assets);
for (const component of [
  Disabled,
  Name,
  Transform,
  ChildOf,
  Children,
  SceneInstance,
  Mobility,
  MeshFilter,
  MeshRenderer,
  Instances,
  Layer,
  ShadowParticipation,
  Visibility,
  Collider,
  RigidBody,
])
  world.components.register(component).unwrap();
const unregister = registerPropagateTransforms(world);
const created = [];
const create = (asset) => {
  const handle = assets.create(asset).unwrap();
  created.push(handle);
  return handle;
};
const textures = Array.from({ length: workload.textureAssets }, (_, index) => {
  const [width, height] = workload.textureExtent,
    data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    data[pixel * 4] = 40 + index * 20;
    data[pixel * 4 + 1] = 100 + index * 11;
    data[pixel * 4 + 2] = 190 - index * 7;
    data[pixel * 4 + 3] =
      ((Math.floor(pixel / width / 16) + Math.floor((pixel % width) / 16)) % 2) * 255;
  }
  return create({
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height } },
    format: 'rgba8unorm',
    colorSpace: 'srgb',
    mips: { kind: 'none' },
    data,
  });
});
const meshes = Array.from({ length: workload.meshAssets }, (_, i) => {
  const mesh = createBoxGeometry(
    0.8 + (i % 4) * 0.05,
    1 + (i % 3) * 0.1,
    0.8 + (i % 5) * 0.04,
  ).unwrap();
  return create({ ...mesh, collision: buildMeshCollision(mesh).unwrap() });
});
const maskedMaterials = workload.maskedEntities / (workload.meshEntities / workload.materialAssets);
if (!Number.isInteger(maskedMaterials))
  throw new Error('masked roster must match the frozen material distribution');
const materials = Array.from({ length: workload.materialAssets }, (_, i) =>
  create(
    Materials.standard({
      baseColor: [0.4, 0.5, 0.6, 1],
      roughness: 0.55 + i * 0.02,
      baseColorTexture: { texture: textures[i % textures.length] },
      alphaCutoff: i < maskedMaterials ? 0.5 : 0,
    }),
  ),
);
const shapeNames = Object.keys(workload.colliders);
const shapeAt = (index) => {
  let first = 0;
  for (const shape of shapeNames) {
    first += workload.colliders[shape];
    if (index < first) return shape;
  }
};
const groupSize = workload.meshEntities / workload.nestedInstances;
if (!Number.isInteger(groupSize) || workload.hierarchyDepth !== 4)
  throw new Error('fixture must preserve the frozen nested roster and four-edge hierarchy');
const children = Array.from({ length: workload.nestedInstances }, (_, group) =>
  create({
    kind: 'scene',
    entities: Object.fromEntries(
      Array.from({ length: groupSize }, (_, local) => {
        const index = group * groupSize + local,
          shape = shapeAt(index);
        return [
          `n${local}`,
          {
            components: {
              Transform: { pos: [local % 8, 0, Math.floor(local / 8)] },
              MeshFilter: { assetHandle: meshes[index % meshes.length] },
              MeshRenderer: { materials: [materials[index % materials.length]] },
              Mobility: { kind: 0 },
              ShadowParticipation: { cast: true, receive: true },
              ...(local === 0 ? {} : { ChildOf: { parent: 'n0' } }),
              ...(local === groupSize - 1 ? { Disabled: {} } : {}),
              ...(shape === undefined
                ? {}
                : {
                    Collider: {
                      shape: ColliderShapeValue[shape],
                      ...(shape === 'trimesh' ? { mesh: meshes[index % meshes.length] } : {}),
                    },
                  }),
            },
          },
        ];
      }),
    ),
  }),
);
const scene = create({
  kind: 'scene',
  entities: Object.fromEntries(
    children.map((source, i) => [
      `cell${i}`,
      {
        components: { Transform: { pos: [(i % 8) * 12, 0, Math.floor(i / 8) * 12] } },
        instance: { source },
      },
    ]),
  ),
});
const constant = Array.from({ length: profile.cpuSubstrate.constantEntities }, (_, index) =>
  world.spawn({ component: Transform, data: { pos: [index, 0, 0] } }).unwrap(),
);
const ordinary = world.query({ read: [Transform, GlobalTransform] }).unwrap();
const disabled = world.query({ read: [Entity], with: [Disabled] }).unwrap();
let frame = 0;
const update = () => {
  frame++;
  for (let i = 0; i < constant.length; i++)
    world.set(constant[i], Transform, { pos: [i, Math.sin(frame * 0.01), 0] }).unwrap();
  world.update(1 / 60).unwrap();
};
for (let i = 0; i < profile.cpuSubstrate.warmupRounds; i++) update();
const samples = [];
function hierarchyDepth(entity) {
  let current = entity,
    depth = 0;
  while (world.hasComponent(current, ChildOf)) {
    current = world.get(current, ChildOf).unwrap().parent;
    depth++;
    if (depth > workload.hierarchyDepth)
      throw new Error('actual hierarchy exceeds the frozen depth');
  }
  return depth;
}
function surfaceCounts(members, content) {
  let masked = 0,
    maxDepth = 0;
  const shapes = Object.fromEntries(shapeNames.map((name) => [name, 0]));
  for (const entity of members) {
    if (world.hasComponent(entity, MeshRenderer)) {
      const handle = world.get(entity, MeshRenderer).unwrap().materials[0];
      if (
        handle !== undefined &&
        handle !== 0 &&
        (content.read(handle).unwrap().values?.alphaCutoff ?? 0) > 0
      )
        masked++;
    }
    if (world.hasComponent(entity, Collider)) {
      const shape = world.get(entity, Collider).unwrap().shape;
      const name = shapeNames.find((name) => ColliderShapeValue[name] === shape);
      if (name === undefined) throw new Error('unexpected shape in the actual source roster');
      shapes[name]++;
    }
    maxDepth = Math.max(maxDepth, hierarchyDepth(entity));
  }
  return { masked, maxDepth, shapes };
}
function assertFrozenRoster(members, authorDisabled, content) {
  const meshCount = members.filter((entity) => world.hasComponent(entity, MeshRenderer)).length;
  const colliderCount = members.filter((entity) => world.hasComponent(entity, Collider)).length;
  const disabledColliders = members.filter(
    (entity) => authorDisabled.has(entity) && world.hasComponent(entity, Collider),
  ).length;
  if (
    meshCount !== workload.meshEntities ||
    colliderCount !== Object.values(workload.colliders).reduce((a, b) => a + b, 0) ||
    authorDisabled.size !== workload.authorDisabledMeshes ||
    disabledColliders !== workload.authorDisabledColliders
  )
    throw new Error('actual source roster differs from the frozen fixture');
  const { masked, maxDepth, shapes } = surfaceCounts(members, content);
  if (
    masked !== workload.maskedEntities ||
    maxDepth !== workload.hierarchyDepth ||
    shapeNames.some((name) => shapes[name] !== workload.colliders[name])
  )
    throw new Error('actual masks, hierarchy or shape counts differ from the frozen fixture');
  return { meshCount, colliderCount, disabledColliders, masked, maxDepth, shapes };
}

function distribution(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    count: ordered.length,
    p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
    maxMs: ordered[ordered.length - 1],
  };
}
for (
  let round = 0;
  round < profile.cpuSubstrate.warmupRounds + profile.cpuSubstrate.measuredRounds;
  round++
) {
  const members = [],
    authorDisabled = new Set(),
    custody = [];
  let lease,
    publication,
    schema,
    sourceGuard,
    effective,
    projection,
    phase = 'begin',
    active = false;
  let actualRoster;
  const quanta = [],
    slices = [],
    updates = [],
    transitions = [],
    started = performance.now();
  function current() {
    return schema.isCurrent() && publication.validate().ok && sourceGuard?.isCurrent() !== false;
  }
  function* pipeline() {
    phase = 'capture-begin';
    const capture = records.beginContentCapture(scene).unwrap();
    yield;
    phase = 'capture-copy';
    while (lease === undefined) {
      lease = capture.step(1).unwrap();
      yield;
    }
    phase = 'publication';
    const task = createSceneContentPublicationTask(assets, lease, scene);
    let proof;
    while (proof === undefined) {
      proof = task.step(1).unwrap();
      yield;
    }
    publication = proof;
    phase = 'vocabulary';
    schema = (yield* preflightLevelVocabularySteps(world, lease)).unwrap();
    const context = {
      incremental: true,
      resolveSource: (source) => {
        if (typeof source !== 'number')
          throw new Error('runtime fixture contains an unlinked Scene source');
        return ok(source);
      },
      resolveAsset: (handle) => lease.read(handle),
      materialize: (components) => {
        const authored = components.some(({ component }) => component === Disabled);
        const result = world.spawn(
          ...components,
          ...(authored ? [] : [{ component: Disabled, data: {} }]),
        );
        if (result.ok) {
          members.push(result.value);
          if (authored) authorDisabled.add(result.value);
        }
        return result;
      },
      applyOverride: (entity, override) => {
        const result = worldApplyMountOverride(world, entity, override);
        if (result.ok && override.comp === Disabled.name) authorDisabled.add(entity);
        return result;
      },
      retainSource: (asset) =>
        retainSceneSourceReferences(world, asset, {
          take: (handles, shared) => {
            if (shared.length !== 0)
              throw new Error('static fixture unexpectedly owns shared source values');
            const retirement = records.deferRelease(handles);
            if (!retirement.ok) return err(retirement.error);
            const item = { ready: false, retirement: retirement.value };
            custody.push(item);
            return ok(() => {
              item.ready = true;
            });
          },
        }),
    };
    phase = 'materialize';
    const instantiate = worldInstantiateSceneSteps(world, scene, context);
    for (;;) {
      if (!current()) throw new Error('fixed Scene preparation invalidated');
      const next = instantiate.next();
      if (next.done) {
        next.value.unwrap();
        break;
      }
      yield;
    }
    phase = 'source-guard';
    sourceGuard = captureSceneSourceGuard(
      world,
      members,
      LEVEL_STREAMING_SOURCE_COMPONENTS,
    ).unwrap();
    yield;
    phase = 'roster';
    effective = (yield* preflightLevelRosterSteps(world, lease, {
      members,
      authorDisabled,
      isCurrent: current,
    })).unwrap().effectiveMembers;
    phase = 'transforms';
    (yield* prepareSceneTransformsSteps(world, {
      members,
      authorDisabled,
      isCurrent: current,
    })).unwrap();
    phase = 'roster-assert';
    actualRoster = assertFrozenRoster(members, authorDisabled, lease);
    if (!current()) throw new Error('candidate invalid before acceptance');
    projection = createStateProjection(world, LEVEL_STREAMING_SOURCE_COMPONENTS, [Entity]);
    projection.read().accept();
    sourceGuard.dispose();
    sourceGuard = undefined;
    yield;
    phase = 'activate';
    for (const entity of effective) world.removeComponent(entity, Disabled).unwrap();
    active = true;
    yield { boundary: 'activate' };
    phase = 'deactivate';
    for (const entity of effective)
      world.addComponent(entity, { component: Disabled, data: {} }).unwrap();
    active = false;
    yield { boundary: 'deactivate' };
    phase = 'retire-scene';
    const retiring = createSceneRetirement(world, members, () => !active);
    while (!retiring.inspect().done) {
      retiring.step(1).unwrap();
      yield;
    }
    phase = 'retire-source-holds';
    for (const item of custody) {
      if (!item.ready) throw new Error('Scene source custody callback was not handed off');
      while (!item.retirement.inspect().done) {
        item.retirement.step(1).unwrap();
        yield;
      }
    }
    phase = 'retire-capture';
    schema.dispose();
    task.dispose();

    projection = undefined;
    const retiringContent = capture.retire().unwrap();
    while (!retiringContent.inspect().done) {
      retiringContent.step(1).unwrap();
      yield;
    }
    phase = 'retired';
    if (
      records.inspect().snapshots !== 0 ||
      records.inspect().snapshotBytes !== 0 ||
      [...disabled].length !== 0 ||
      [...ordinary].length !== constant.length
    )
      throw new Error('source retirement leaked content or members');
  }
  const work = pipeline();
  let complete = false;
  while (!complete) {
    const begin = performance.now();
    let boundary,
      acceptanceMs = 0;
    do {
      const before = performance.now(),
        next = work.next(),
        duration = performance.now() - before;
      quanta.push({ phase, ms: duration });
      if (next.done) {
        complete = true;
        break;
      }
      if (next.value?.boundary !== undefined) {
        boundary = next.value.boundary;
        acceptanceMs = duration;
        break;
      }
    } while (performance.now() - begin < profile.budgets.preparationSliceMs);
    const sliceMs = performance.now() - begin;
    slices.push(sliceMs);
    if (complete) break;
    const before = performance.now();
    update();
    const changes = projection?.read();
    changes?.accept();
    const updateMs = performance.now() - before;
    updates.push(updateMs);
    if (boundary !== undefined) {
      const expected = constant.length + (active ? effective.length : 0);
      let count = 0;
      for (const row of ordinary) {
        count++;
        const matrix = row.get(GlobalTransform).world;
        if (!Number.isFinite(matrix[12] + matrix[13] + matrix[14]))
          throw new Error('nonfinite accepted Transform');
      }
      if (count !== expected)
        throw new Error('Disabled membership differs from the accepted effective roster');
      transitions.push({
        boundary,
        acceptanceMs,
        updateMs,
        totalMs: acceptanceMs + updateMs,
        projectionRows: changes?.scannedRows,
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  samples.push({
    round,
    warmup: round < profile.cpuSubstrate.warmupRounds,
    elapsedMs: performance.now() - started,
    members: members.length,
    effectiveMembers: effective.length,
    authorDisabled: authorDisabled.size,
    actualRoster,
    quanta,
    slices,
    updates,
    transitions,
  });
}
for (const handle of created.reverse()) assets.release(handle).unwrap();
if (records.inspect().assets !== 0)
  throw new Error('instance custody outlived every producer grant');
unregister();

assets.dispose();
const git = { cwd: root, encoding: 'utf8' };
const result = {
  scope:
    'CPU source-owner diagnostic with concurrent ordinary World updates; runtime-created content, not cold Pack loading; no Renderer/native/presented-frame or memory qualification',
  profile,
  exercisedCase: {
    geometry: 'ordinary-meshes',
    residentInactiveCopies: 0,
    lifecycle: 'new source instance, prepare, ECS activate, ECS deactivate, retire',
    maintenance:
      'shared launch threshold between ordinary World updates, scheduled with setImmediate',
    excludes: [
      'cold Pack loading',
      'inactive copies 1 and 4',
      'alternate Instances case',
      'Render',
      'native Physics',
      'App frame admission',
      'presentation',
      'memory qualification',
    ],
  },
  source: {
    head: execFileSync('git', ['rev-parse', 'HEAD'], git).trim(),
    workingDiffSha256: createHash('sha256')
      .update(execFileSync('git', ['diff', '--binary', 'HEAD'], git))
      .digest('hex'),
  },
  machine: {
    cpu: os.cpus()[0]?.model,
    release: os.release(),
    runtime: process.versions,
    load: os.loadavg(),
  },
  samples,
};
await writeFile(output, JSON.stringify(result));
const measured = samples.filter((sample) => !sample.warmup),
  allQuanta = samples.flatMap((sample) => sample.quanta),
  allTransitions = samples.flatMap((sample) => sample.transitions),
  measuredTransitions = measured.flatMap((sample) => sample.transitions);
const summary = {
  scope: result.scope,
  output,
  rounds: samples.length,
  preparationQuanta: distribution(allQuanta.map((item) => item.ms)),
  maxSliceMs: samples.reduce(
    (maximum, sample) => sample.slices.reduce((current, ms) => Math.max(current, ms), maximum),
    0,
  ),
  sliceOvershoots: samples
    .flatMap((sample) => sample.slices)
    .filter((ms) => ms > profile.budgets.preparationSliceMs).length,
  activation: distribution(
    measuredTransitions.filter((item) => item.boundary === 'activate').map((item) => item.totalMs),
  ),
  deactivation: distribution(
    measuredTransitions
      .filter((item) => item.boundary === 'deactivate')
      .map((item) => item.totalMs),
  ),
  maxAcceptanceAndUpdateMsAllRounds: allTransitions.reduce(
    (maximum, item) => Math.max(maximum, item.totalMs),
    0,
  ),
  maxWorldUpdateMs: samples.reduce(
    (maximum, sample) => sample.updates.reduce((current, ms) => Math.max(current, ms), maximum),
    0,
  ),
};
console.log(JSON.stringify(summary, null, 2));
