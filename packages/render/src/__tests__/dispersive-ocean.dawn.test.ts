import { mat4 } from '@forgeax/engine-math';
import type { WaterDispersiveOceanConfig } from '@forgeax/engine-types';
import type { WaterOceanPatchFrame } from '@forgeax/engine-water';
import { expect, it } from 'vitest';
import type {
  RenderFeaturePassDeclaration,
  RenderFeatureResourceDeclaration,
} from '../features/plan';
import { packSdfScene } from '../raytracing/sdf-query';
import {
  ADVANCED_COLLISION_FLOATS,
  type AdvancedCollisionSnapshot,
} from '../water/advanced-collisions';
import {
  buffer,
  compute,
  program,
  read,
  storage,
  texture,
  view,
  write,
} from '../water/advanced-graph';
import {
  appendDispersiveOcean,
  type DispersiveOceanInput,
  dispersiveExternalSources,
} from '../water/dispersive-ocean';
import { dispersiveOceanShader } from '../water/dispersive-ocean-shader';
import { dispersiveGpuFixture } from './dispersive-ocean-gpu.fixture';

const CONFIG: WaterDispersiveOceanConfig = {
  algorithm: 'mode-projected-gravity/1',
  fftResolution: 256,
  domainLengthM: 4,
  centerXZ: [0, 0],
  baseHeightM: 0,
  referenceDepthM: 4,
  gravityMPerSec2: 9.81,
  sourceSlabBoundariesM: [-4, -3, -2, -1, 0],
  collisions: {
    kind: 'simple',
    collisionGroups: 0xffffffff,
    maxElements: 10,
    fieldStepM: 0.01,
    maximumFieldSamplesPerColumn: 128,
  },
  maximumIntervalSeconds: 0.2,
  boundary: { kind: 'periodic' },
  foam: { slopeThreshold: 0.001, emissionPerSecond: 1, decayPerSecond: 0.1 },
  normalRtFormat: 'rgba32float',
  gridMesh: null,
};
const OUTPUTS = {
  normal: 'test-normal',
  grid: 'test-height',
  foam: 'test-foam',
  mapping: 'test-mapping',
};
const RADIUS = 0.31;

it('evolves a localized zero-volume momentum impulse into outward gravity waves without replaying it', async () => {
  const gpu = await dispersiveGpuFixture();
  const config = { ...CONFIG, fftResolution: 64, domainLengthM: 16 };
  try {
    const run = async (
      dt: number,
      reset: boolean,
      impulses?: WaterOceanPatchFrame['waveImpulses'],
    ) => {
      const frame = work(config, [], reset, dt, undefined, undefined, { waveImpulses: impulses });
      await gpu.run(frame.resources, frame.passes);
      return gpu.read('test-wake-state');
    };
    await run(0, true);
    const start = await run(0, false, [
      { sequence: 1, positionXZ: [0, 0], radiusM: 0.6, velocityImpulseMps: 3, timeSeconds: 0 },
    ]);
    const sum = (values: Float32Array, laneIndex: number) =>
      values.reduce((total, value, index) => total + (index % 4 === laneIndex ? value : 0), 0);
    expect(Math.abs(sum(start, 0))).toBeLessThan(0.00001);
    expect(Math.abs(sum(start, 1))).toBeLessThan(0.0001);
    expect(start.some((value, index) => index % 4 === 1 && value > 0.1)).toBe(true);
    let state = start;
    for (let step = 0; step < 30; step++) state = await run(1 / 60, false);
    expect(Math.abs(sum(state, 0))).toBeLessThan(0.0001);
    expect(state.some((value, index) => index % 4 === 0 && value > 0.02)).toBe(true);
    expect(state.some((value, index) => index % 4 === 0 && value < -0.1)).toBe(true);
    const held = await run(0, false);
    const maxError = held.reduce(
      (maximum, value, index) => Math.max(maximum, Math.abs(value - (state[index] ?? 0))),
      0,
    );
    expect(maxError).toBeLessThan(0.00001);
  } finally {
    gpu.dispose();
  }
});
it('projects subcell physical impulses onto the same resolved gravity modes at coarse and fine resolutions', async () => {
  const gpu = await dispersiveGpuFixture();
  const radiusM = 0.72,
    velocityImpulseMps = 3,
    age = 0.25,
    lengthM = 64;
  try {
    for (const resolution of [32, 64]) {
      const config = {
        ...CONFIG,
        fftResolution: resolution,
        domainLengthM: lengthM,
        waveDampingPerSecond: 0,
      };
      const frame = work(config, [], true, age, undefined, undefined, {
        waveImpulses: [
          { sequence: 1, positionXZ: [0, 0], radiusM, velocityImpulseMps, timeSeconds: 0 },
        ],
      });
      await gpu.run(frame.resources, frame.passes);
      const field = await gpu.read('test-wake-state');
      expect(Array.from(field).every(Number.isFinite)).toBe(true);
      expect(Math.abs(field.reduce((sum, v, i) => sum + (i % 4 === 0 ? v : 0), 0))).toBeLessThan(
        1e-5,
      );
      for (const [modeX, modeZ] of [
        [1, 0],
        [2, 1],
        [3, -2],
      ] as const) {
        const k = (Math.hypot(modeX, modeZ) * 2 * Math.PI) / lengthM;
        const omega = Math.sqrt(9.81 * k * Math.tanh(k * config.referenceDepthM));
        const expected =
          (((velocityImpulseMps *
            Math.PI *
            radiusM ** 4 *
            k ** 2 *
            Math.exp(-0.5 * radiusM ** 2 * k ** 2)) /
            lengthM ** 2) *
            Math.sin(omega * age)) /
          omega;
        let real = 0,
          imaginary = 0;
        for (let z = 0; z < resolution; z++)
          for (let x = 0; x < resolution; x++) {
            const phase = (-2 * Math.PI * (modeX * x + modeZ * z)) / resolution;
            const height = field[(z * resolution + x) * 4] ?? 0;
            real += height * Math.cos(phase);
            imaginary += height * Math.sin(phase);
          }
        const actual = Math.hypot(real, imaginary) / resolution ** 2;
        expect(Math.abs(actual - expected) / expected).toBeLessThan(0.0001);
      }
    }
  } finally {
    gpu.dispose();
  }
});

function spheres(
  centers: readonly (readonly [number, number, number])[],
): AdvancedCollisionSnapshot {
  const fields = packSdfScene([]).unwrap();
  return {
    originM: [0, 0, 0],
    sdfInstances: fields.instances,
    sdfFields: fields.fields,
    primitives:
      centers.length === 0
        ? new Float32Array(ADVANCED_COLLISION_FLOATS)
        : new Float32Array(
            centers.flatMap((center) => {
              const pose = mat4.compose(mat4.create(), center, [0, 0, 0, 1], [1, 1, 1]);
              return [...mat4.invert(mat4.create(), pose), ...pose, 0, RADIUS, 0, 0, 0, 0, 0, 0];
            }),
          ),
    roster: centers.map((_center, index) => ({
      entity: index,
      bodyGeneration: 1,
      completedStep: 1,
      motionDiscontinuity: 0,
      identity: {
        kind: 'native-collider',
        colliderId: `sphere-${index}`,
        generation: 1,
        elementIndex: 0,
      },
      representation: 'sphere',
    })),
  };
}
function work(
  config: WaterDispersiveOceanConfig,
  centers: readonly (readonly [number, number, number])[],
  reset: boolean,
  dt = 0,
  receiver?: { entity: number; generation: number },
  transport?: {
    translating: boolean;
    velocityXZ?: readonly [number, number];
    groupVelocities?: readonly (readonly [number, number])[];
    compound?: boolean;
  },
  options: {
    captureStages?: boolean;
    reseedSource?: boolean;
    bodyGeneration?: number;
    waveImpulses?: WaterOceanPatchFrame['waveImpulses'];
  } = {},
) {
  const resources: RenderFeatureResourceDeclaration[] = [];
  const passes: RenderFeaturePassDeclaration[] = [];
  for (const name of Object.values(OUTPUTS)) {
    const size = name === OUTPUTS.mapping ? 2 : config.fftResolution;
    resources.push(
      texture(name, size, size, 'rgba32float', name, true),
      view(`${name}-view`, name),
    );
  }
  const rawCollisions = spheres(centers);
  const bodyGeneration = options.bodyGeneration;
  const captured =
    bodyGeneration === undefined
      ? rawCollisions
      : {
          ...rawCollisions,
          roster: rawCollisions.roster.map((row) => ({ ...row, bodyGeneration })),
        };
  const center = centers[0];
  const collisions =
    transport && center
      ? {
          ...captured,
          roster: captured.roster.map((row, index) => {
            const velocityXZ =
              transport.groupVelocities?.[index] ??
              (index === 0 || transport.compound
                ? (transport.velocityXZ ??
                  (transport.translating ? ([1, 0] as const) : ([0, 0] as const)))
                : undefined);
            return velocityXZ === undefined
              ? row
              : {
                  ...row,
                  ...(transport.compound ? { entity: 0 } : {}),
                  sourceMotion: {
                    kind: 'surface-transport' as const,
                    velocityXZ,
                  },
                };
          }),
        }
      : captured;
  const input: DispersiveOceanInput = {
    prefix: 'test-wake',
    size: config.fftResolution,
    generation: 1,
    config,
    collisions,
    deltaSeconds: dt,
    reset,
    reseedSource: options.reseedSource ?? reset,
    outputs: OUTPUTS,
    frame: {
      recipe: {
        guid: '019ffa97-7000-7000-8000-000000000011',
        contentVersion: 'native-oracle',
        asset: {
          kind: 'water-simulation-recipe',
          system: 'water-advanced',
          configurationVersion: 1,
          enabledFeatures: ['oceanPatch'],
          materialGuids: [],
          textureGuids: [],
          oceanPatchConfig: config,
        },
      },
      generation: 1,
      sequence: 1,
      timeSeconds: dt,
      paused: false,
      reset,
      reseedSource: options.reseedSource ?? reset,
      sourceRevision: 1,
      captureRequest: null,
      noiseRevision: null,
      captureStages: options.captureStages ?? false,
      ...(options.waveImpulses === undefined ? {} : { waveImpulses: options.waveImpulses }),
    },
  };
  appendDispersiveOcean(input, resources, passes);
  if (receiver)
    appendDispersiveOcean(
      {
        ...input,
        prefix: 'test-external',
        queryOnly: true,
        collisions: dispersiveExternalSources(input.collisions, receiver),
      },
      resources,
      passes,
    );
  return { resources, passes, collisions };
}

it('elides only exact empty source work outside diagnostic captures while preserving GPU fields', async () => {
  const gpu = await dispersiveGpuFixture();
  const config = {
    ...CONFIG,
    fftResolution: 32,
    sourceSlabBoundariesM: Array.from({ length: 17 }, (_, index) => -4 * (1 - index / 16) ** 3),
  };
  type SourceFrame = Readonly<{
    centers: readonly (readonly [number, number, number])[];
    reset: boolean;
    dt: number;
    reseedSource: boolean;
    transport?: Readonly<{
      translating: boolean;
      velocityXZ: readonly [number, number];
    }>;
    bodyGeneration?: number;
  }>;
  const frames: readonly SourceFrame[] = [
    {
      centers: [[0.1, -0.05, 0]],
      reset: true,
      dt: 1 / 60,
      reseedSource: true,
      transport: { translating: true, velocityXZ: [1, 0] },
    },
    {
      centers: [[0.1, -0.05, 0]],
      reset: false,
      dt: 1 / 60,
      reseedSource: false,
      transport: { translating: false, velocityXZ: [0, -0] },
    },
    { centers: [], reset: false, dt: 1 / 60, reseedSource: true },
    {
      centers: [[0.15, -0.05, 0]],
      reset: false,
      dt: 1 / 60,
      reseedSource: true,
      bodyGeneration: 2,
    },
  ];
  const outputNames = [
    'test-wake-state',
    'test-wake-source-state',
    OUTPUTS.normal,
    OUTPUTS.grid,
    OUTPUTS.foam,
    OUTPUTS.mapping,
  ] as const;
  const run = async (captureStages: boolean) => {
    const observations: Float32Array[][] = [];
    for (const [index, frame] of frames.entries()) {
      const source = work(
        config,
        frame.centers,
        frame.reset,
        frame.dt,
        undefined,
        frame.transport,
        {
          captureStages,
          reseedSource: frame.reseedSource,
          ...(frame.bodyGeneration === undefined ? {} : { bodyGeneration: frame.bodyGeneration }),
        },
      );
      const computeNames = source.passes
        .filter((pass) => pass.kind === 'compute')
        .map((pass) => pass.name);
      if (!captureStages && (index === 1 || index === 2)) {
        expect(computeNames.some((name) => name.includes('-columns-'))).toBe(false);
        expect(computeNames.some((name) => name.includes('-transport-'))).toBe(false);
      }
      if (!captureStages && index === 3) {
        expect(computeNames.some((name) => name.endsWith('-columns-0'))).toBe(true);
        expect(computeNames.some((name) => name.includes('-transport-'))).toBe(false);
      }
      if (captureStages && index === 1) {
        const names = source.passes.map((pass) => pass.name);
        const readbacks = source.passes.flatMap((pass) =>
          pass.kind === 'copy' ? (pass.textureReadbacks ?? []).map((entry) => entry.name) : [],
        );
        expect(names).toContain('test-wake-columns-0-capture');
        expect(names).toContain('test-wake-transport-1-0-flux-x-capture');
        expect(readbacks).toEqual(
          expect.arrayContaining([
            'test-wake-transport-1-0-flux-x',
            'test-wake-transport-1-0-flux-z',
            'test-wake-occupancy',
            'test-wake-state',
            'test-wake-source-state',
          ]),
        );
      }
      await gpu.run(source.resources, source.passes);
      observations.push(await Promise.all(outputNames.map((name) => gpu.read(name))));
    }
    return observations;
  };
  try {
    const diagnostic = await run(true);
    const ordinary = await run(false);
    expect(ordinary).toEqual(diagnostic);
  } finally {
    gpu.dispose();
  }
});

it('keeps transport ordinals and receiver filtering equivalent across diagnostic and ordinary GPU plans', async () => {
  const gpu = await dispersiveGpuFixture();
  const config = { ...CONFIG, fftResolution: 32 };
  const makeWork = (captureStages: boolean) =>
    work(
      config,
      [
        [0.1, -0.05, 0],
        [-0.35, -0.05, 0],
      ],
      true,
      1 / 60,
      { entity: 0, generation: 1 },
      {
        translating: true,
        groupVelocities: [
          [0, -0],
          [1, 0],
        ],
      },
      { captureStages, reseedSource: true },
    );
  const inspect = (source: ReturnType<typeof makeWork>, captureStages: boolean) => {
    const computeNames = source.passes
      .filter((pass) => pass.kind === 'compute')
      .map((pass) => pass.name);
    const dataFor = (name: string) => {
      const value = source.resources.find(
        (resource) => resource.kind === 'buffer' && resource.name === name,
      );
      if (value?.kind !== 'buffer' || !(value.data instanceof Float32Array))
        throw new Error(`Expected packed GPU buffer ${name}`);
      return value.data;
    };
    const mainPrimitives = dataFor('test-wake-primitives');
    const externalPrimitives = dataFor('test-external-primitives');
    expect(mainPrimitives[39]).toBe(1);
    expect(mainPrimitives[ADVANCED_COLLISION_FLOATS + 39]).toBe(2);
    expect(externalPrimitives[39]).toBe(1);
    if (captureStages) {
      expect(computeNames).toContain('test-wake-transport-1-0-columns');
      expect(computeNames).toContain('test-wake-transport-2-0-columns');
      expect(computeNames).toContain('test-external-transport-1-0-columns');
      expect(source.passes.map((pass) => pass.name)).toContain(
        'test-wake-transport-1-0-flux-x-capture',
      );
    } else {
      expect(computeNames).not.toContain('test-wake-transport-1-0-columns');
      expect(computeNames).toContain('test-wake-transport-2-0-columns');
      expect(computeNames).toContain('test-external-transport-1-0-columns');
      expect(computeNames).not.toContain('test-external-transport-2-0-columns');
    }
  };
  const outputNames = [
    'test-wake-state',
    'test-external-state',
    OUTPUTS.normal,
    OUTPUTS.grid,
    OUTPUTS.foam,
  ] as const;
  try {
    const diagnostic = makeWork(true);
    inspect(diagnostic, true);
    await gpu.run(diagnostic.resources, diagnostic.passes);
    const occupancy = await gpu.read('test-wake-occupancy');
    expect(
      Math.max(...Array.from(occupancy).filter((_, index) => index % 4 === 0)),
    ).toBeGreaterThan(0);
    const diagnosticFields = await Promise.all(outputNames.map((name) => gpu.read(name)));

    const ordinary = makeWork(false);
    inspect(ordinary, false);
    await gpu.run(ordinary.resources, ordinary.passes);
    const ordinaryFields = await Promise.all(outputNames.map((name) => gpu.read(name)));
    expect(ordinaryFields).toEqual(diagnosticFields);
  } finally {
    gpu.dispose();
  }
});

it('scales entry and sailing waves independently with matching external receiver feedback', async () => {
  const gpu = await dispersiveGpuFixture();
  const config = { ...CONFIG, fftResolution: 32 };
  const run = async (
    entryWaveMultiplier: number,
    transport: boolean,
    surfaceTransportMultiplier = 1,
  ) => {
    const selected = { ...config, entryWaveMultiplier, surfaceTransportMultiplier };
    const initial = work(selected, [[0, 2, 0]], true, 0, { entity: 999, generation: 1 });
    await gpu.run(initial.resources, initial.passes);
    const entering = work(
      selected,
      [[0, -0.1, 0]],
      false,
      1 / 60,
      { entity: 999, generation: 1 },
      transport ? { translating: true, velocityXZ: [1, 0] } : undefined,
    );
    await gpu.run(entering.resources, entering.passes);
    return {
      visible: await gpu.read('test-wake-state'),
      receiver: await gpu.read('test-external-state'),
    };
  };
  try {
    const baseline = await run(1, false);
    const amplified = await run(4, false);
    expect(Math.max(...Array.from(baseline.visible).filter((_, i) => i % 4 === 0))).toBeGreaterThan(
      0.001,
    );
    for (let at = 0; at < baseline.visible.length; at += 4) {
      expect(amplified.visible[at]).toBeCloseTo((baseline.visible[at] ?? NaN) * 4, 5);
      expect(amplified.visible[at + 1]).toBeCloseTo((baseline.visible[at + 1] ?? NaN) * 4, 5);
      expect(amplified.receiver[at]).toBeCloseTo(amplified.visible[at] ?? NaN, 5);
    }
    const sailing = await run(1, true);
    const unchanged = await run(4, true);
    const strongerSailing = await run(4, true, 2);
    const unchangedEntry = await run(1, false, 2);
    for (let at = 0; at < sailing.visible.length; at += 4) {
      expect(unchanged.visible[at]).toBeCloseTo(sailing.visible[at] ?? NaN, 5);
      expect(unchanged.visible[at + 1]).toBeCloseTo(sailing.visible[at + 1] ?? NaN, 5);
      expect(strongerSailing.visible[at]).toBeCloseTo((sailing.visible[at] ?? NaN) * 2, 5);
      expect(strongerSailing.visible[at + 1]).toBeCloseTo((sailing.visible[at + 1] ?? NaN) * 2, 5);
      expect(strongerSailing.receiver[at]).toBeCloseTo(strongerSailing.visible[at] ?? NaN, 5);
      expect(unchangedEntry.visible[at]).toBeCloseTo(baseline.visible[at] ?? NaN, 5);
    }
  } finally {
    gpu.dispose();
  }
});

it('drives sailing from a conservative facing-boundary flux instead of whole-hull entry volume', async () => {
  const gpu = await dispersiveGpuFixture();
  const config = { ...CONFIG, fftResolution: 32 };
  try {
    const initial = work(config, [[0, -0.2, 0]], true, 0, undefined, {
      translating: false,
      velocityXZ: [0, 0],
    });
    await gpu.run(initial.resources, initial.passes);
    const moving = work(config, [[0.1, -0.05, 0]], false, 1 / 60, undefined, {
      translating: true,
      velocityXZ: [1, 0],
    });
    await gpu.run(moving.resources, moving.passes);
    const source = await gpu.read('test-wake-source-state');
    expect(
      Math.max(
        ...Array.from(source)
          .filter((_, i) => i % 4 >= 2)
          .map(Math.abs),
      ),
    ).toBeGreaterThan(0.001);
    expect(
      Array.from(source)
        .filter((_, i) => i % 4 < 2)
        .every((v) => v === 0),
    ).toBe(true);
    expect(Math.abs(source[2] ?? NaN)).toBeLessThan(0.00001);
    expect(Math.abs(source[3] ?? NaN)).toBeLessThan(0.00001);
    const fx = await gpu.read('test-wake-flux-x');
    const fz = await gpu.read('test-wake-flux-z');
    let front = 0,
      rear = 0,
      port = 0,
      starboard = 0;
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++) {
        const px = ((x + 0.5) / 32 - 0.5) * config.domainLengthM - 0.1;
        const pz = ((z + 0.5) / 32 - 0.5) * config.domainLengthM;
        for (let slab = 0; slab < 4; slab++) {
          const index = (z * 32 + x) * 4 + slab;
          const outward = fx[index] ?? NaN;
          if (px > 0) front += outward;
          else rear += Math.abs(outward);
          if (pz < 0) port -= fz[index] ?? NaN;
          else starboard += fz[index] ?? NaN;
        }
      }
    expect(front).toBeGreaterThan(0.01);
    expect(rear).toBe(0);
    expect(port).toBeGreaterThan(0.01);
    expect(starboard).toBeGreaterThan(0.01);
    expect(port).toBeCloseTo(starboard, 5);
    const duplicated = work(
      config,
      [
        [0.1, -0.05, 0],
        [0.1, -0.05, 0],
      ],
      false,
      1 / 60,
      undefined,
      {
        translating: true,
        velocityXZ: [1, 0],
        compound: true,
      },
    );
    await gpu.run(duplicated.resources, duplicated.passes);
    expect(await gpu.read('test-wake-source-state')).toEqual(source);
    expect(await gpu.read('test-wake-flux-x')).toEqual(fx);
    // Reset from a different entry pose: forcing depends on current native
    // geometry and velocity, not the first submerged envelope.
    const differentStart = work(config, [[0, 0.15, 0]], true, 0, undefined, { translating: false });
    await gpu.run(differentStart.resources, differentStart.passes);
    await gpu.run(moving.resources, moving.passes);
    expect(await gpu.read('test-wake-source-state')).toEqual(source);
  } finally {
    gpu.dispose();
  }
});

it('injects no native wave or foam from passive floating heave, then emits a real sailing wave', async () => {
  const gpu = await dispersiveGpuFixture();
  const config = { ...CONFIG, fftResolution: 32 };
  const run = async (
    center: readonly [number, number, number],
    reset: boolean,
    translating: boolean,
  ) => {
    const frame = work(config, [center], reset, reset ? 0 : 1 / 60, undefined, {
      translating,
    });
    await gpu.run(frame.resources, frame.passes);
    return await gpu.read('test-wake-state');
  };
  try {
    await run([0, -0.2, 0], true, false);
    for (const height of [-0.05, 0.15, -0.2, 0.1]) {
      const state = await run([0, height, 0], false, false);
      expect(Array.from(state).every((value) => value === 0)).toBe(true);
    }
    const sailing = await run([0.2, 0.1, 0], false, true);
    expect(
      Math.max(
        ...Array.from(sailing)
          .filter((_, index) => index % 4 === 0)
          .map(Math.abs),
      ),
    ).toBeGreaterThan(0.0001);
    await run([0.2, -0.2, 0], false, false);
    expect(Array.from(await gpu.read('test-wake-source-state')).every((v) => v === 0)).toBe(true);
  } finally {
    gpu.dispose();
  }
});

it('keeps a moving own source visible while receiving only an external source birth on the native GPU', async () => {
  const gpu = await dispersiveGpuFixture();
  const receiver = { entity: 0, generation: 1 };
  const config = { ...CONFIG, fftResolution: 32 };
  const run = async (
    centers: readonly (readonly [number, number, number])[],
    reset: boolean,
    dt: number,
  ) => {
    const frame = work(config, centers, reset, dt, receiver, {
      translating: true,
      velocityXZ: [2, 0],
    });
    await gpu.run(frame.resources, frame.passes);
    return {
      full: await gpu.read('test-wake-state'),
      external: await gpu.read('test-external-state'),
    };
  };
  const maximumHeight = (field: Float32Array) =>
    Math.max(
      ...Array.from(field)
        .filter((_, index) => index % 4 === 0)
        .map(Math.abs),
    );
  try {
    await run([[0, -0.2, 0]], true, 0);
    const own = await run([[0.2, -0.05, 0]], false, 1 / 60);
    expect(maximumHeight(own.full)).toBeGreaterThan(0.001);
    expect(maximumHeight(own.external)).toBe(0);
    const entry = await run(
      [
        [0.2, -0.05, 0],
        [1, -0.05, 0],
      ],
      false,
      1 / 60,
    );
    expect(maximumHeight(entry.external)).toBeGreaterThan(0.001);
    const coast = await run(
      [
        [0.2, -0.05, 0],
        [1, -0.05, 0],
      ],
      false,
      1 / 60,
    );
    expect(maximumHeight(coast.external)).toBeGreaterThan(0);
    const retired = await run([[0.2, -0.05, 0]], false, 1 / 60);
    expect(maximumHeight(retired.external)).toBeGreaterThan(0);
  } finally {
    gpu.dispose();
  }
});
const lane = (data: Float32Array, index: number) => {
  const value = data[index];
  if (value === undefined) throw new Error('Expected native float lane');
  return value;
};
const volume = (4 / 3) * Math.PI * RADIUS ** 3;
function recordNumericalEvidence(label: string, serialized: string): void {
  // biome-ignore lint/suspicious/noConsole: retain configuration-qualified native measurements in the acceptance log.
  console.info(label, serialized);
}

it('matches a direct four-real DFT including negative, DC and Nyquist bins, then inverts once', async () => {
  const gpu = await dispersiveGpuFixture();
  try {
    const n = 8;
    const resources: RenderFeatureResourceDeclaration[] = [],
      passes: RenderFeaturePassDeclaration[] = [];
    for (const side of ['a', 'b']) {
      const target = texture(side, n, n, 'rgba32float', side);
      if (target.kind !== 'graph-texture') throw new Error('Expected FFT work texture');
      resources.push(
        {
          ...target,
          descriptor: {
            ...target.descriptor,
            usage: (target.descriptor.usage ?? 0) | GPUTextureUsage.COPY_DST,
          },
        },
        view(`${side}-view`, side),
      );
    }
    resources.push(
      program('fft', dispersiveOceanShader('rgba32float'), 'butterfly', [
        read(0),
        write(1, 'rgba32float'),
        storage(2),
      ]),
    );
    const input = new Float32Array(n * n * 4);
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++)
        input.set(
          [
            0.3 + Math.cos((2 * Math.PI * (x - 2 * z)) / n),
            (x % 2 ? -1 : 1) + 0.2 * z,
            Math.sin((2 * Math.PI * z) / n),
            ((x * 17 + z * 31) % 13) / 13,
          ],
          (z * n + x) * 4,
        );
    let previous = 'a';
    const transform = (direction: -1 | 1, label: string) => {
      for (const axis of [0, 1])
        for (let span = 1; span < n; span *= 2) {
          const next = previous === 'a' ? 'b' : 'a',
            name = `${label}-${axis}-${span}`;
          const params = new Float32Array(20);
          params[0] = n;
          params[14] = axis;
          params[15] = span;
          params[16] = direction;
          resources.push(buffer(`${name}-params`, params));
          compute(
            resources,
            passes,
            name,
            'fft',
            'butterfly',
            [
              { binding: 0, resource: `${previous}-view` },
              { binding: 1, resource: `${next}-view` },
              { binding: 2, resource: `${name}-params` },
            ],
            n,
            n,
          );
          previous = next;
        }
    };
    transform(-1, 'forward');
    await gpu.run(resources, []);
    gpu.write('a', input);
    await gpu.run(resources, passes);
    const frequency = await gpu.read(previous);
    for (let kz = 0; kz < n; kz++)
      for (let kx = 0; kx < n; kx++) {
        const at = (kz * n + kx) * 4,
          opposite = (((n - kz) % n) * n + ((n - kx) % n)) * 4;
        for (const component of [0, 1, 2, 3]) {
          const pair = component < 2 ? 0 : 2;
          const actual =
            component % 2 === 0
              ? [
                  (lane(frequency, at + pair) + lane(frequency, opposite + pair)) / 2,
                  (lane(frequency, at + pair + 1) - lane(frequency, opposite + pair + 1)) / 2,
                ]
              : [
                  (lane(frequency, at + pair + 1) + lane(frequency, opposite + pair + 1)) / 2,
                  (lane(frequency, opposite + pair) - lane(frequency, at + pair)) / 2,
                ];
          const expected = [0, 0];
          for (let z = 0; z < n; z++)
            for (let x = 0; x < n; x++) {
              const angle = (-2 * Math.PI * (kx * x + kz * z)) / n,
                value = lane(input, (z * n + x) * 4 + component);
              expected[0] = (expected[0] ?? 0) + value * Math.cos(angle);
              expected[1] = (expected[1] ?? 0) + value * Math.sin(angle);
            }
          expect(actual[0]).toBeCloseTo(expected[0] ?? NaN, 4);
          expect(actual[1]).toBeCloseTo(expected[1] ?? NaN, 4);
        }
      }
    passes.length = 0;
    transform(1, 'inverse');
    await gpu.run(resources, passes);
    const roundTrip = await gpu.read(previous);
    for (let index = 0; index < input.length; index++)
      expect(lane(roundTrip, index) / (n * n)).toBeCloseTo(lane(input, index), 5);
  } finally {
    gpu.dispose();
  }
});

it('converges to the harmonic submerged-sphere volume, depth and phase oracle without overlap duplication', async () => {
  const gpu = await dispersiveGpuFixture();
  try {
    const center = [0.113, -0.37, -0.267] as const;
    const errors: number[] = [];
    const measurements: unknown[] = [];
    for (const count of [16, 32, 64]) {
      const config = {
        ...CONFIG,
        sourceSlabBoundariesM: Array.from(
          { length: count + 1 },
          (_, index) => -4 * (1 - index / count) ** 3,
        ),
      };
      const step = work(config, [center, center], true);
      await gpu.run(step.resources, step.passes);
      const spectrum = await gpu.read('test-wake-source-state');
      const cellArea = (config.domainLengthM / config.fftResolution) ** 2;
      const actualVolume = lane(spectrum, 0) * cellArea;
      expect(actualVolume).toBeCloseTo(volume, 3);
      let worst = 0;
      for (const [kxIndex, kzIndex] of [
        [1, 0],
        [3, -2],
        [6, 0],
        [-4, -3],
      ] as const) {
        const kx = (kxIndex * 2 * Math.PI) / config.domainLengthM,
          kz = (kzIndex * 2 * Math.PI) / config.domainLengthM,
          k = Math.hypot(kx, kz);
        const amplitude =
          (volume * Math.cosh(k * (center[1] + config.referenceDepthM))) /
          Math.cosh(k * config.referenceDepthM);
        const firstCell = -config.domainLengthM / 2 + Math.sqrt(cellArea) / 2;
        const phase = -kx * (center[0] - firstCell) - kz * (center[2] - firstCell);
        const pixel =
          (((kzIndex + config.fftResolution) % config.fftResolution) * config.fftResolution +
            ((kxIndex + config.fftResolution) % config.fftResolution)) *
          4;
        const real = lane(spectrum, pixel) * cellArea,
          imaginary = lane(spectrum, pixel + 1) * cellArea;
        const error =
          Math.hypot(real - amplitude * Math.cos(phase), imaginary - amplitude * Math.sin(phase)) /
          amplitude;
        worst = Math.max(worst, error);
      }
      errors.push(worst);
      measurements.push({
        fftResolution: config.fftResolution,
        slabCount: count,
        centerM: center,
        deltaSeconds: 0,
        actualVolumeM3: actualVolume,
        expectedVolumeM3: volume,
        volumeErrorM3: actualVolume - volume,
        worstRelativeModeError: worst,
      });
    }
    recordNumericalEvidence(
      '[water-dispersive-sphere]',
      JSON.stringify({ adapter: gpu.adapter, measurements }),
    );
    expect(errors[2]).toBeLessThan(errors[0] ?? 0);
    expect(errors[2]).toBeLessThan(0.02);
    const deep = work(
      {
        ...CONFIG,
        sourceSlabBoundariesM: Array.from({ length: 65 }, (_, index) => -4 + index / 16),
      },
      [[center[0], -2, center[2]]],
      true,
    );
    await gpu.run(deep.resources, deep.passes);
    const field = await gpu.read('test-wake-source-state');
    const k = (2 * Math.PI) / CONFIG.domainLengthM,
      cellArea = (CONFIG.domainLengthM / CONFIG.fftResolution) ** 2;
    const expected = (volume * Math.cosh(k * 2)) / Math.cosh(k * 4);
    const actual = Math.hypot(lane(field, 4), lane(field, 5)) * cellArea;
    recordNumericalEvidence(
      '[water-dispersive-deep-sphere]',
      JSON.stringify({
        adapter: gpu.adapter,
        fftResolution: CONFIG.fftResolution,
        slabCount: 64,
        centerM: [center[0], -2, center[2]],
        deltaSeconds: 0,
        expected,
        actual,
        relativeModeError: (actual - expected) / expected,
      }),
    );
    expect(actual).toBeCloseTo(expected, 4);
  } finally {
    gpu.dispose();
  }
});

it('seeds occupied water at rest, emits entry volume once and derives normals and foam from that height', async () => {
  const gpu = await dispersiveGpuFixture();
  try {
    const config = {
      ...CONFIG,
      sourceSlabBoundariesM: Array.from({ length: 65 }, (_, index) => -4 * (1 - index / 64) ** 3),
    };
    const initial = work(config, [[0.113, 1, -0.267]], true);
    await gpu.run(initial.resources, initial.passes);
    const entry = work(config, [[0.113, -0.37, -0.267]], false, 0.1);
    await gpu.run(entry.resources, entry.passes);
    const state = await gpu.read('test-wake-state'),
      normal = await gpu.read(OUTPUTS.normal),
      foam = await gpu.read(OUTPUTS.foam);
    const n = config.fftResolution,
      dx = config.domainLengthM / n;
    let waterVolume = 0,
      maximumFoam = 0;
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const at = (z * n + x) * 4;
        waterVolume += lane(state, at) * dx * dx;
        maximumFoam = Math.max(maximumFoam, lane(foam, at));
        const h = (px: number, pz: number) =>
          lane(state, (((pz + n) % n) * n + ((px + n) % n)) * 4);
        const sx = (h(x + 1, z) - h(x - 1, z)) / (2 * dx),
          sz = (h(x, z + 1) - h(x, z - 1)) / (2 * dx);
        const length = Math.hypot(sx, sz, 1);
        expect(lane(normal, at)).toBeCloseTo(-sx / length, 4);
        expect(lane(normal, at + 1)).toBeCloseTo(-sz / length, 4);
        expect(lane(normal, at + 3)).toBeCloseTo(lane(state, at), 5);
      }
    recordNumericalEvidence(
      '[water-dispersive-entry]',
      JSON.stringify({
        adapter: gpu.adapter,
        fftResolution: config.fftResolution,
        slabCount: 64,
        centerM: [0.113, -0.37, -0.267],
        deltaSeconds: 0.1,
        waterVolumeM3: waterVolume,
        expectedVolumeM3: volume,
        volumeErrorM3: waterVolume - volume,
        maximumFoam,
      }),
    );
    expect(waterVolume).toBeCloseTo(volume, 3);
    expect(maximumFoam).toBeGreaterThan(0);
    const held = work(config, [[0.113, -0.37, -0.267]], false, 0);
    await gpu.run(held.resources, held.passes);
    const after = await gpu.read('test-wake-state');
    for (let index = 0; index < state.length; index++)
      expect(lane(after, index)).toBeCloseTo(lane(state, index), 4);
  } finally {
    gpu.dispose();
  }
});

it('holds a seeded submerged source at rest over positive solver intervals without injecting height, velocity or foam', async () => {
  const gpu = await dispersiveGpuFixture();
  try {
    const config = {
      ...CONFIG,
      fftResolution: 64,
      sourceSlabBoundariesM: Array.from({ length: 17 }, (_, index) => -4 * (1 - index / 16) ** 3),
    };
    const center = [0.113, -0.37, -0.267] as const;
    const initial = work(config, [center], true);
    await gpu.run(initial.resources, initial.passes);
    const peaks: number[] = [];
    for (const dt of [1 / 120, 1 / 60, 1 / 30, 0.1, 0.2]) {
      const step = work(config, [center], false, dt);
      await gpu.run(step.resources, step.passes);
      const state = await gpu.read('test-wake-state');
      const peak = state.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
      peaks.push(peak);
      expect(peak).toBe(0);
    }
    recordNumericalEvidence(
      '[water-dispersive-static]',
      JSON.stringify({
        adapter: gpu.adapter,
        fftResolution: 64,
        slabCount: 16,
        centerM: center,
        deltaSeconds: [1 / 120, 1 / 60, 1 / 30, 0.1, 0.2],
        maximumStateMagnitude: peaks,
      }),
    );
  } finally {
    gpu.dispose();
  }
});

it('dissipates free wave energy by elapsed time while preserving mean displaced water', async () => {
  const gpu = await dispersiveGpuFixture();
  try {
    const n = 16;
    const config = { ...CONFIG, fftResolution: n, waveDampingPerSecond: 0.35 };
    const k = (2 * Math.PI) / config.domainLengthM;
    const omega = Math.sqrt(config.gravityMPerSec2 * k * Math.tanh(k * config.referenceDepthM));
    for (const intervals of [[1], [0.25, 0.25, 0.25, 0.25]]) {
      const allocationKey = `damping-${intervals.length}`;
      const initial = work(config, [], true);
      initial.resources = initial.resources.map((row) =>
        row.kind === 'graph-texture' && row.name === 'test-wake-state'
          ? {
              ...row,
              allocationKey,
              descriptor: {
                ...row.descriptor,
                usage: (row.descriptor.usage ?? 0) | GPUTextureUsage.COPY_DST,
              },
            }
          : row,
      );
      await gpu.run(initial.resources, initial.passes);
      const seed = new Float32Array(n * n * 4);
      for (let z = 0; z < n; z++)
        for (let x = 0; x < n; x++)
          seed[(z * n + x) * 4] = 0.02 + 0.1 * Math.cos((2 * Math.PI * x) / n);
      gpu.write('test-wake-state', seed);
      for (const dt of intervals) {
        const step = work(
          intervals.length === 1
            ? (({ waveDampingPerSecond: _damping, ...rest }) => rest)(config)
            : config,
          [],
          false,
          dt,
        );
        step.resources = step.resources.map((row) =>
          row.kind === 'graph-texture' && row.name === 'test-wake-state'
            ? { ...row, allocationKey }
            : row,
        );
        await gpu.run(step.resources, step.passes);
      }
      const actual = await gpu.read('test-wake-state');
      const envelope = Math.exp(-config.waveDampingPerSecond);
      let mean = 0,
        maximumError = 0;
      for (let z = 0; z < n; z++)
        for (let x = 0; x < n; x++) {
          const at = (z * n + x) * 4,
            phase = Math.cos((2 * Math.PI * x) / n);
          mean += lane(actual, at) / (n * n);
          maximumError = Math.max(
            maximumError,
            Math.abs(lane(actual, at) - (0.02 + 0.1 * Math.cos(omega) * phase * envelope)),
            Math.abs(lane(actual, at + 1) + 0.1 * omega * Math.sin(omega) * phase * envelope),
          );
        }
      expect(mean).toBeCloseTo(0.02, 6);
      expect(maximumError).toBeLessThan(0.000002);
    }
  } finally {
    gpu.dispose();
  }
});

it('evolves independent Fourier modes at the finite-depth gravity frequency across full native intervals', async () => {
  const gpu = await dispersiveGpuFixture();
  try {
    const n = 16,
      modes = [
        [1, 0, 0.1, 0.2],
        [2, -3, 0.03, -0.04],
        [8, 0, 0.02, 0.01],
      ] as const;
    const measurements: unknown[] = [];
    for (const depth of [1e-8, 0.2, 4, 16]) {
      const config = {
        ...CONFIG,
        fftResolution: n,
        referenceDepthM: depth,
        sourceSlabBoundariesM: [-depth, -depth * 0.75, -depth * 0.5, -depth * 0.25, 0],
      };
      for (const dt of [0.01, 0.1, 0.2]) {
        const initial = work(config, [], true);
        initial.resources = initial.resources.map((row) =>
          row.kind === 'graph-texture' && row.name === 'test-wake-state'
            ? {
                ...row,
                allocationKey: `seed-${depth}-${dt}`,
                descriptor: {
                  ...row.descriptor,
                  usage: (row.descriptor.usage ?? 0) | GPUTextureUsage.COPY_DST,
                },
              }
            : row,
        );
        await gpu.run(initial.resources, initial.passes);
        const seed = new Float32Array(n * n * 4);
        for (let z = 0; z < n; z++)
          for (let x = 0; x < n; x++) {
            const at = (z * n + x) * 4;
            seed[at] = 0.02;
            seed[at + 1] = 0.01;
            for (const [kx, kz, height, velocity] of modes) {
              const phase = Math.cos((2 * Math.PI * (kx * x + kz * z)) / n);
              seed[at] = lane(seed, at) + height * phase;
              seed[at + 1] = lane(seed, at + 1) + velocity * phase;
            }
          }
        gpu.write('test-wake-state', seed);
        const step = work(config, [], false, dt);
        step.resources = step.resources.map((row) =>
          row.kind === 'graph-texture' && row.name === 'test-wake-state'
            ? { ...row, allocationKey: `seed-${depth}-${dt}` }
            : row,
        );
        await gpu.run(step.resources, step.passes);
        const actual = await gpu.read('test-wake-state');
        let maximumError = 0;
        for (let z = 0; z < n; z++)
          for (let x = 0; x < n; x++) {
            let height = 0.02 + 0.01 * dt,
              velocity = 0.01;
            for (const [kx, kz, amplitude, rate] of modes) {
              const k = (Math.hypot(kx, kz) * 2 * Math.PI) / config.domainLengthM;
              const omega = Math.sqrt(config.gravityMPerSec2 * k * Math.tanh(k * depth));
              const phase = Math.cos((2 * Math.PI * (kx * x + kz * z)) / n);
              height +=
                (amplitude * Math.cos(omega * dt) + (rate * Math.sin(omega * dt)) / omega) *
                phase *
                Math.exp(-0.35 * dt);
              velocity +=
                (rate * Math.cos(omega * dt) - amplitude * omega * Math.sin(omega * dt)) *
                phase *
                Math.exp(-0.35 * dt);
            }
            const at = (z * n + x) * 4;
            maximumError = Math.max(
              maximumError,
              Math.abs(lane(actual, at) - height),
              Math.abs(lane(actual, at + 1) - velocity),
            );
          }
        measurements.push({
          fftResolution: n,
          referenceDepthM: depth,
          deltaSeconds: dt,
          maximumHeightVelocityError: maximumError,
        });
        expect(maximumError).toBeLessThan(0.000002);
      }
    }
    recordNumericalEvidence(
      '[water-dispersive-frequency]',
      JSON.stringify({ adapter: gpu.adapter, measurements }),
    );
  } finally {
    gpu.dispose();
  }
});
