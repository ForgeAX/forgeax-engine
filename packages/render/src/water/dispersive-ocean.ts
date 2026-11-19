import { mat4 } from '@forgeax/engine-math';
import type { WaterDispersiveOceanConfig } from '@forgeax/engine-types';
import { canonicalJson, sha256 } from '@forgeax/engine-types';
import type { WaterOceanPatchFrame, WaterResidualQueryReceiver } from '@forgeax/engine-water';
import type {
  RenderFeaturePassDeclaration,
  RenderFeatureResourceDeclaration,
} from '../features/plan';
import type { SdfSceneFieldPayload } from '../raytracing/sdf-query';
import { SDF_INSTANCE_STRIDE } from '../raytracing/sdf-query';
import {
  ADVANCED_COLLISION_FLOATS,
  type AdvancedCollisionSnapshot,
  deriveAdvancedCollisionSnapshot,
} from './advanced-collisions';
import {
  buffer,
  compute,
  initializedBuffer,
  program,
  read,
  storage,
  texture,
  view,
  write,
} from './advanced-graph';
import { DISPERSIVE_MAX_COLUMN_INTERVALS, dispersiveOceanShader } from './dispersive-ocean-shader';

export interface DispersiveOceanInput {
  readonly prefix: string;
  readonly size: number;
  readonly generation: number;
  readonly frame: WaterOceanPatchFrame;
  readonly config: WaterDispersiveOceanConfig;
  readonly collisions: AdvancedCollisionSnapshot;
  readonly fieldInitialization?: SdfSceneFieldPayload['initialization'];
  readonly deltaSeconds: number;
  readonly reset: boolean;
  readonly reseedSource: boolean;
  readonly outputs: Readonly<{ normal: string; grid: string; foam: string; mapping: string }>;
  readonly queryOnly?: boolean;
}

/** Remove only the receiving native source; other generations and all compound identities remain distinct. */
export function dispersiveExternalSources(
  snapshot: AdvancedCollisionSnapshot,
  receiver: WaterResidualQueryReceiver,
): AdvancedCollisionSnapshot {
  const elements = snapshot.roster.flatMap((row, index) =>
    row.entity === receiver.entity && row.bodyGeneration === receiver.generation
      ? []
      : [{ row, index }],
  );
  if (elements.length === snapshot.roster.length) return snapshot;
  return deriveAdvancedCollisionSnapshot(snapshot, {
    roster: elements.map(({ row }) => row),
    primitives:
      elements.length === 0
        ? new Float32Array(ADVANCED_COLLISION_FLOATS)
        : new Float32Array(
            elements.flatMap(({ index }) =>
              Array.from(
                snapshot.primitives.subarray(
                  index * ADVANCED_COLLISION_FLOATS,
                  (index + 1) * ADVANCED_COLLISION_FLOATS,
                ),
              ),
            ),
          ),
  });
}

export function dispersiveQueryPrefix(
  prefix: string,
  receiver: WaterResidualQueryReceiver,
): string {
  return `water-ocean-receiver-${sha256(canonicalJson([prefix, receiver.entity, receiver.generation]))}`;
}

/** Refuse geometry whose worst-case ray work or interval storage exceeds its saved budget. */
export function dispersiveSourceBudget(
  config: WaterDispersiveOceanConfig,
  snapshot: AdvancedCollisionSnapshot,
): string | undefined {
  const fields = new Set<number>();
  let intervals = 0;
  for (let index = 0; index < snapshot.roster.length; index++) {
    const encoded = snapshot.primitives[index * ADVANCED_COLLISION_FLOATS + 36];
    if (encoded === undefined) return 'complete packed native primitives';
    if (encoded < 0.5) {
      intervals++;
      continue;
    }
    const field = Math.round(encoded) - 1;
    if (fields.has(field)) continue;
    fields.add(field);
    const offset = field * SDF_INSTANCE_STRIDE;
    const instance = new Float32Array(
      snapshot.sdfInstances.buffer,
      snapshot.sdfInstances.byteOffset + offset,
      SDF_INSTANCE_STRIDE / 4,
    );
    const transform = mat4.invert(mat4.create(), instance.subarray(0, 16));
    let low = Infinity,
      high = -Infinity;
    for (const x of [instance[24], instance[28]])
      for (const y of [instance[25], instance[29]])
        for (const z of [instance[26], instance[30]]) {
          if (x === undefined || y === undefined || z === undefined)
            return 'finite accepted distance-field bounds';
          const height =
            (transform[1] ?? NaN) * x +
            (transform[5] ?? NaN) * y +
            (transform[9] ?? NaN) * z +
            (transform[13] ?? NaN);
          low = Math.min(low, height);
          high = Math.max(high, height);
        }
    const count = Math.ceil(
      Math.max(0, Math.min(0, high) - Math.max(-config.referenceDepthM, low)) /
        config.collisions.fieldStepM,
    );
    if (!Number.isFinite(count) || count > config.collisions.maximumFieldSamplesPerColumn)
      return `distance-field columns within ${config.collisions.maximumFieldSamplesPerColumn} samples at ${config.collisions.fieldStepM} m`;
    intervals += Math.floor(count / 2) + 1;
  }
  return intervals > DISPERSIVE_MAX_COLUMN_INTERVALS
    ? `at most ${DISPERSIVE_MAX_COLUMN_INTERVALS} worst-case column intervals`
    : undefined;
}

export function dispersiveStateResources(
  prefix: string,
  size: number,
  generation: number,
): RenderFeatureResourceDeclaration[] {
  return ['state', 'source-state'].flatMap((suffix) => {
    const name = `${prefix}-${suffix}`;
    return [
      texture(name, size, size, 'rgba32float', `${name}-g${generation}-s${size}`, true),
      view(`${name}-view`, name),
    ];
  });
}

export function dispersiveSourceIdentity(snapshot: AdvancedCollisionSnapshot): string {
  return JSON.stringify(
    snapshot.roster
      .map((row, index) =>
        JSON.stringify([
          row.entity,
          row.bodyGeneration,
          row.identity,
          row.motionDiscontinuity,
          row.mesh === undefined
            ? undefined
            : [row.mesh.handle, row.mesh.contentRevision ?? row.mesh.revision],
          row.representation,
          row.sourceMotion?.kind,
          Array.from(
            snapshot.primitives.subarray(
              index * ADVANCED_COLLISION_FLOATS + 32,
              index * ADVANCED_COLLISION_FLOATS + 36,
            ),
          ),
        ]),
      )
      .sort(),
  );
}

/** Birth contributes displaced volume; only retirement, replacement or teleport reseeds history. */
export function dispersiveSourceRequiresReseed(previous: string, current: string): boolean {
  const old = JSON.parse(previous) as string[],
    next = new Set(JSON.parse(current) as string[]);
  return old.some((identity) => !next.has(identity));
}

/** All spectra use raw forward sums of metre-valued cells; inverse divides by N squared once. */
export function appendDispersiveOcean(
  input: DispersiveOceanInput,
  resources: RenderFeatureResourceDeclaration[],
  passes: RenderFeaturePassDeclaration[],
): void {
  const { prefix, size, frame, config, collisions, outputs } = input;
  const source = dispersiveOceanShader(config.normalRtFormat);
  const captureTransportGroups = (
    collisions: AdvancedCollisionSnapshot,
    frame: DispersiveOceanInput['frame'],
  ) => {
    // Compound elements share one submerged union and velocity. The field's last
    // lane is a local group ordinal, never a truncated native entity identity.
    const groups = new Map<string, { ordinal: number; velocityXZ: readonly [number, number] }>();
    const primitives = collisions.primitives.slice();
    let hasEntrySources = false;
    for (const [index, row] of collisions.roster.entries()) {
      if (!row.sourceMotion) {
        hasEntrySources = true;
        continue;
      }
      const key = canonicalJson([row.entity, row.bodyGeneration]);
      let group = groups.get(key);
      if (!group) {
        group = { ordinal: groups.size + 1, velocityXZ: row.sourceMotion.velocityXZ };
        groups.set(key, group);
      }
      primitives[index * ADVANCED_COLLISION_FLOATS + 39] = group.ordinal;
    }
    // The diagnostic producer retains every stage. Ordinary frames omit only
    // mathematically empty source work; the persistent wave state still advances.
    const entrySourcesRequired = hasEntrySources || frame.captureStages;
    const transportGroupsRequired = frame.captureStages
      ? [...groups.values()]
      : [...groups.values()].filter(({ velocityXZ }) => velocityXZ[0] !== 0 || velocityXZ[1] !== 0);
    return { groups, primitives, entrySourcesRequired, transportGroupsRequired };
  };
  const { groups, primitives, entrySourcesRequired, transportGroupsRequired } =
    captureTransportGroups(collisions, frame);
  const base = new Float32Array([
    size,
    config.domainLengthM,
    input.deltaSeconds,
    config.baseHeightM,
    config.referenceDepthM,
    config.gravityMPerSec2,
    config.boundary.kind === 'absorbing' ? config.boundary.widthM : 0,
    config.boundary.kind === 'absorbing' ? config.boundary.dampingPerSecond : 0,
    config.entryWaveMultiplier ?? 1,
    config.foam.slopeThreshold,
    config.foam.emissionPerSecond,
    config.foam.decayPerSecond,
    0,
    0,
    0,
    0,
    -1,
    Number(input.reset),
    Number(input.reseedSource),
    0,
    0,
    0,
    0,
    0,
    collisions.roster.length,
    config.collisions.fieldStepM,
    config.collisions.maximumFieldSamplesPerColumn,
    groups.size,
    ...config.centerXZ,
    config.waveDampingPerSecond ?? 0.35,
    config.surfaceTransportMultiplier ?? 1,
  ]);
  const uploadWaveImpulses = () => {
    const impulses = frame.waveImpulses ?? [];
    base[19] = impulses.length;
    const impulseValues = new Float32Array(Math.max(1, impulses.length) * 8);
    impulses.forEach((impulse, index) => {
      impulseValues.set(
        [
          impulse.positionXZ[0] - config.centerXZ[0],
          impulse.positionXZ[1] - config.centerXZ[1],
          impulse.radiusM,
          impulse.velocityImpulseMps,
          Math.max(0, frame.timeSeconds - impulse.timeSeconds),
          0,
          0,
          0,
        ],
        index * 8,
      );
    });
    resources.push(buffer(`${prefix}-wave-impulses`, impulseValues));
  };
  uploadWaveImpulses();
  const params = `${prefix}-params`;
  resources.push(
    ...dispersiveStateResources(prefix, size, input.generation),
    buffer(params, base),
    buffer(`${prefix}-slabs`, new Float32Array(config.sourceSlabBoundariesM)),
    buffer(`${prefix}-primitives`, primitives),
    buffer(`${prefix}-instances`, collisions.sdfInstances),
    ...(input.fieldInitialization === undefined
      ? [buffer(`${prefix}-fields`, collisions.sdfFields)]
      : [initializedBuffer(`${prefix}-fields`, input.fieldInitialization)]),
  );
  const declareTransportTextures = () => {
    for (const suffix of ['a', 'b', 'source-a', 'source-b', 'occupancy']) {
      const name = `${prefix}-${suffix}`;
      resources.push(
        texture(name, size, size, 'rgba32float', `${name}-g${input.generation}-s${size}`),
        view(`${name}-view`, name),
      );
    }
    if (transportGroupsRequired.length > 0)
      for (const suffix of ['flux-x', 'flux-z']) {
        const name = `${prefix}-${suffix}`;
        resources.push(
          texture(name, size, size, 'rgba32float', `${name}-g${input.generation}-s${size}`),
          view(`${name}-view`, name),
        );
      }
  };
  declareTransportTextures();
  const layouts = {
    clear: [write(1, 'rgba32float'), storage(2)],
    columns: [
      write(1, 'rgba32float'),
      storage(2),
      storage(11),
      write(12, 'rgba32float'),
      storage(17),
      storage(18),
      storage(19),
    ],
    transportcolumns: [
      write(1, 'rgba32float'),
      storage(2),
      storage(11),
      write(12, 'rgba32float'),
      storage(17),
      storage(18),
      storage(19),
    ],
    transportdivergence: [read(0), write(1, 'rgba32float'), storage(2), read(3)],
    butterfly: [read(0), write(1, 'rgba32float'), storage(2)],
    project: [read(0), write(1, 'rgba32float'), storage(2), read(3), storage(11)],
    prepare: [write(1, 'rgba32float'), storage(2), read(5)],
    advance: [
      read(0),
      write(1, 'rgba32float'),
      storage(2),
      read(3),
      read(6),
      write(7, 'rgba32float'),
      storage(20),
    ],
    publish: [
      read(0),
      storage(2),
      write(4, config.normalRtFormat),
      read(5),
      write(8, 'rgba32float'),
      write(9, 'rgba32float'),
      write(10, 'rgba32float'),
    ],
    publishquery: [read(0), storage(2), write(8, 'rgba32float')],
    mapping: [storage(2), write(14, 'rgba32float')],
  };
  for (const [entry, entries] of Object.entries(layouts))
    resources.push(program(`${prefix}-${entry}-program`, source, entry, entries));
  const dispatch = (
    name: string,
    entry: keyof typeof layouts,
    bindings: readonly (readonly [number, string])[],
  ) =>
    compute(
      resources,
      passes,
      `${prefix}-${name}`,
      `${prefix}-${entry}-program`,
      entry,
      bindings.map(([binding, resource]) => ({ binding, resource })),
      size,
      size,
    );
  const fft = (name: string, start: 'a' | 'b', direction: -1 | 1): 'a' | 'b' => {
    let prior = start;
    for (const axis of [0, 1])
      for (let span = 1; span < size; span *= 2) {
        const next = prior === 'a' ? 'b' : 'a';
        const step = `${name}-${axis}-${span}`;
        const stepParams = base.slice();
        stepParams[14] = axis;
        stepParams[15] = span;
        stepParams[16] = direction;
        resources.push(buffer(`${prefix}-${step}-params`, stepParams));
        dispatch(step, 'butterfly', [
          [0, `${prefix}-${prior}-view`],
          [1, `${prefix}-${next}-view`],
          [2, `${prefix}-${step}-params`],
        ]);
        prior = next;
      }
    return prior;
  };
  const capture = (stage: string, target: string) => {
    if (frame.captureStages)
      passes.push({
        kind: 'copy',
        name: `${prefix}-${stage}-capture`,
        copies: [],
        textureReadbacks: [{ name: `${prefix}-${stage}`, target }],
      });
  };
  dispatch('clear-projection', 'clear', [
    [1, `${prefix}-source-a-view`],
    [2, params],
  ]);
  let accumulation = 'source-a';
  for (let layer = 0; layer < config.sourceSlabBoundariesM.length - 1; layer += 4) {
    const batch = `${prefix}-source-${layer}-params`;
    const batchParams = base.slice();
    batchParams[20] = layer;
    if (entrySourcesRequired) {
      resources.push(buffer(batch, batchParams));
      dispatch(`columns-${layer}`, 'columns', [
        [1, `${prefix}-a-view`],
        [2, batch],
        [11, `${prefix}-slabs`],
        [12, `${prefix}-occupancy-view`],
        [17, `${prefix}-primitives`],
        [18, `${prefix}-instances`],
        [19, `${prefix}-fields`],
      ]);
      capture(`columns-${layer}`, `${prefix}-a`);
      const transformed = fft(`source-${layer}-fft`, 'a', -1);
      capture(`source-fft-${layer}`, `${prefix}-${transformed}`);
      const next = accumulation === 'source-a' ? 'source-b' : 'source-a';
      dispatch(`project-${layer}`, 'project', [
        [0, `${prefix}-${transformed}-view`],
        [1, `${prefix}-${next}-view`],
        [2, batch],
        [3, `${prefix}-${accumulation}-view`],
        [11, `${prefix}-slabs`],
      ]);
      capture(`projected-${layer}`, `${prefix}-${next}`);
      accumulation = next;
    }
    for (const group of transportGroupsRequired) {
      const moving = `${prefix}-transport-${group.ordinal}-${layer}-params`;
      const movingParams = batchParams.slice();
      movingParams[12] = group.velocityXZ[0];
      movingParams[13] = group.velocityXZ[1];
      movingParams[21] = 1;
      movingParams[27] = group.ordinal;
      resources.push(buffer(moving, movingParams));
      dispatch(`transport-${group.ordinal}-${layer}-columns`, 'transportcolumns', [
        [1, `${prefix}-flux-x-view`],
        [2, moving],
        [11, `${prefix}-slabs`],
        [12, `${prefix}-flux-z-view`],
        [17, `${prefix}-primitives`],
        [18, `${prefix}-instances`],
        [19, `${prefix}-fields`],
      ]);
      capture(`transport-${group.ordinal}-${layer}-flux-x`, `${prefix}-flux-x`);
      capture(`transport-${group.ordinal}-${layer}-flux-z`, `${prefix}-flux-z`);
      dispatch(`transport-${group.ordinal}-${layer}-divergence`, 'transportdivergence', [
        [0, `${prefix}-flux-x-view`],
        [1, `${prefix}-a-view`],
        [2, moving],
        [3, `${prefix}-flux-z-view`],
      ]);
      capture(`transport-${group.ordinal}-${layer}-rate`, `${prefix}-a`);
      const fluxSpectrum = fft(`transport-${group.ordinal}-${layer}-fft`, 'a', -1);
      const destination = accumulation === 'source-a' ? 'source-b' : 'source-a';
      dispatch(`transport-${group.ordinal}-${layer}-project`, 'project', [
        [0, `${prefix}-${fluxSpectrum}-view`],
        [1, `${prefix}-${destination}-view`],
        [2, moving],
        [3, `${prefix}-${accumulation}-view`],
        [11, `${prefix}-slabs`],
      ]);
      accumulation = destination;
    }
  }
  if (input.reset)
    dispatch('clear-state', 'clear', [
      [1, `${prefix}-state-view`],
      [2, params],
    ]);
  if (input.reset || input.reseedSource)
    dispatch('clear-source', 'clear', [
      [1, `${prefix}-source-state-view`],
      [2, params],
    ]);
  dispatch('prepare-wave', 'prepare', [
    [1, `${prefix}-a-view`],
    [2, params],
    [5, `${prefix}-state-view`],
  ]);
  capture('prepared-wave', `${prefix}-a`);
  const transformed = fft('wave-forward', 'a', -1);
  capture('forward-wave', `${prefix}-${transformed}`);
  const evolved = transformed === 'a' ? 'b' : 'a';
  dispatch('advance-wave', 'advance', [
    [0, `${prefix}-${transformed}-view`],
    [1, `${prefix}-${evolved}-view`],
    [2, params],
    [3, `${prefix}-${accumulation}-view`],
    [6, `${prefix}-source-state-view`],
    [7, `${prefix}-source-b-next-view`],
    [20, `${prefix}-wave-impulses`],
  ]);
  capture('advanced-wave', `${prefix}-${evolved}`);
  const nextSource = `${prefix}-source-b-next`;
  resources.push(
    texture(nextSource, size, size, 'rgba32float', `${nextSource}-g${input.generation}-s${size}`),
    view(`${nextSource}-view`, nextSource),
  );
  const inverse = fft('wave-inverse', evolved, 1);
  capture('inverse-wave', `${prefix}-${inverse}`);
  if (input.queryOnly)
    dispatch('publish-query-state', 'publishquery', [
      [0, `${prefix}-${inverse}-view`],
      [2, params],
      [8, `${prefix}-state-next-view`],
    ]);
  else {
    dispatch('publish', 'publish', [
      [0, `${prefix}-${inverse}-view`],
      [2, params],
      [4, `${outputs.normal}-view`],
      [5, `${prefix}-state-view`],
      [8, `${prefix}-state-next-view`],
      [9, `${outputs.grid}-view`],
      [10, `${outputs.foam}-view`],
    ]);
    dispatch('mapping', 'mapping', [
      [2, params],
      [14, `${outputs.mapping}-view`],
    ]);
  }
  const nextState = `${prefix}-state-next`;
  resources.push(
    texture(nextState, size, size, 'rgba32float', `${nextState}-g${input.generation}-s${size}`),
    view(`${nextState}-view`, nextState),
  );
  for (const [name, from, target] of [
    ['commit-state', nextState, `${prefix}-state`],
    ['commit-source', nextSource, `${prefix}-source-state`],
  ] as const) {
    resources.push(
      program(
        `${prefix}-${name}-program`,
        `@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var destination:texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn commit(@builtin(global_invocation_id) id:vec3<u32>){if(all(id.xy<textureDimensions(source))){textureStore(destination,vec2<i32>(id.xy),textureLoad(source,vec2<i32>(id.xy),0));}}`,
        'commit',
        [read(0), write(1, 'rgba32float')],
      ),
    );
    compute(
      resources,
      passes,
      `${prefix}-${name}`,
      `${prefix}-${name}-program`,
      'commit',
      [
        { binding: 0, resource: `${from}-view` },
        { binding: 1, resource: `${target}-view` },
      ],
      size,
      size,
    );
  }
  if (frame.captureStages)
    passes.push({
      kind: 'copy',
      name: `${prefix}-state-capture`,
      copies: [],
      textureReadbacks: [`${prefix}-state`, `${prefix}-source-state`, `${prefix}-occupancy`].map(
        (name) => ({ name, target: name }),
      ),
    });
}
