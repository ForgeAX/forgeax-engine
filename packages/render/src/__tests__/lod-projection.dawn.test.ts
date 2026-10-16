import { vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { projectedHeightForCandidate } from '../gpu-driven/batch-topology';
import {
  LOD_PROJECTION_ROW_CAPACITY,
  type LodViewCamera,
  writeLodViewConstants,
} from '../gpu-driven/lod-projection.wgsl';
import { shadowLodHeightFloor } from '../gpu-driven/production-raster-lod';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import {
  buildGpuLodRows,
  encodeGpuLodRows,
  type GpuLodRow,
  selectGpuLod,
} from '../scene/visibility/gpu-lod';
import { lodDraws } from '../scene/visibility/lod-selector';
import {
  equivalentOriginProjectionCases,
  LOD_CHAIN_BYTES,
  LOD_PROJECTION_CASE_BYTES,
  LOD_PROJECTION_HARNESS_WGSL,
  LOD_SELECTION_CASE_BYTES,
} from './lod-projection-harness';

// Portable WebGPU bit values; the Dawn project installs navigator.gpu only.
const COMPUTE_STAGE = 0x4;
const BUFFER_MAP_READ = 0x1;
const BUFFER_COPY_SRC = 0x4;
const BUFFER_COPY_DST = 0x8;
const BUFFER_STORAGE = 0x80;
const INVALID_LEVEL = 0xffffffff;
const f = Math.fround;

interface Chain {
  readonly name: string;
  readonly coverages: readonly number[];
  readonly hysteresis: number;
  readonly ready: readonly boolean[];
}

const CHAINS: readonly Chain[] = [
  { name: 'regular', coverages: [1, 0.5, 0.25, 0.1], hysteresis: 0.08, ready: [] },
  { name: 'dense-midpoint', coverages: [1, 0.3, 0.28, 0.05], hysteresis: 0.2, ready: [] },
  {
    name: 'unready-level',
    coverages: [1, 0.6, 0.2, 0.05, 0.01],
    hysteresis: 0.1,
    ready: [true, true, false, true, true],
  },
  { name: 'no-hysteresis', coverages: [1, 0.4], hysteresis: 0, ready: [] },
  { name: 'root-only', coverages: [1], hysteresis: 0.1, ready: [] },
  {
    name: 'full-capacity',
    coverages: [1, 0.7, 0.5, 0.35, 0.2, 0.12, 0.06, 0.02],
    hysteresis: 0.5,
    ready: [],
  },
  { name: 'clamped-hysteresis', coverages: [1, 0.5, 0.1], hysteresis: 0.995, ready: [] },
];

function chainRows(chain: Chain): readonly GpuLodRow[] {
  return buildGpuLodRows({
    generation: 1,
    hysteresis: f(chain.hysteresis),
    ranges: chain.coverages.map((_, level) => ({
      firstIndex: level * 3,
      indexCount: 3,
      baseVertex: 0,
    })),
    coverages: chain.coverages.map(f),
    ready: chain.coverages.map((_, level) => chain.ready[level] ?? true),
  });
}

function crossfadeReference(rows: readonly GpuLodRow[], height: number) {
  return lodDraws({
    levels: rows.slice(1),
    projectedHeight: height,
    hysteresis: rows[0]?.hysteresis ?? 0,
    ready: rows.map((row) => row.ready),
  });
}

/**
 * Heights around every threshold, band edge and hysteresis edge. Offsets are
 * 1e-4 relative or larger: the f32 kernel and the f64 reference agree on any
 * comparison against the shared f32 thresholds, but a derived band edge such
 * as `threshold * (1 + hysteresis)` rounds differently, so a height exactly on
 * that product is a one-ulp tie rather than a behaviour.
 */
function sweepHeights(rows: readonly GpuLodRow[]): number[] {
  const heights = [0, -1, 1e-8, 2, 1e4, Number.NaN, Number.POSITIVE_INFINITY];
  const hysteresis = rows[0]?.hysteresis ?? 0;
  const epsilons = [0, 1e-4, -1e-4, 1e-2, -1e-2];
  for (let level = 1; level < rows.length; level += 1) {
    const threshold = rows[level]?.screenCoverage ?? 0;
    const previous = rows[level - 1]?.screenCoverage ?? Number.POSITIVE_INFINITY;
    const next = rows[level + 1]?.screenCoverage ?? 0;
    const halfWidth = Math.min(
      threshold * Math.min(hysteresis, 0.99),
      level > 1 ? (previous - threshold) / 2 : Number.POSITIVE_INFINITY,
      (threshold - next) / 2,
    );
    const edges = [
      threshold,
      threshold * (1 + hysteresis),
      threshold * (1 - hysteresis),
      threshold * (1 + hysteresis / 2),
      threshold * (1 - hysteresis / 2),
      threshold + halfWidth,
      threshold - halfWidth,
      threshold + halfWidth / 3,
      threshold - halfWidth / 3,
    ];
    for (const edge of edges) {
      for (const epsilon of epsilons) {
        // Exact threshold ties are comparisons against the same f32 value.
        if (epsilon === 0 && edge !== threshold) continue;
        heights.push(edge * (1 + epsilon));
      }
    }
  }
  return heights.map(f);
}

function rampHeights(): number[] {
  const heights: number[] = [];
  const steps = 160;
  for (let step = 0; step <= steps; step += 1) heights.push(1.5 * (0.004 / 1.5) ** (step / steps));
  for (let step = steps; step >= 0; step -= 1) heights.push(1.5 * (0.004 / 1.5) ** (step / steps));
  // Oscillate inside every regular threshold's hysteresis band.
  for (const threshold of [0.5, 0.25, 0.1, 0.3, 0.28, 0.6, 0.2, 0.05]) {
    for (let step = 0; step < 6; step += 1)
      heights.push(threshold * (step % 2 === 0 ? 1.03 : 0.97));
  }
  return heights.map(f);
}

interface ProjectionCase {
  readonly aabb: Float32Array;
  readonly world: Float32Array;
  readonly camera: LodViewCamera;
}

function projectionCases(): ProjectionCase[] {
  let seed = 0x2545f491;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const range = (low: number, high: number) => low + (high - low) * random();
  const cases: ProjectionCase[] = [];
  const makeCase = (
    projection: LodViewCamera['projection'],
    overrides: Partial<{
      aabb: Float32Array;
      world: Float32Array;
      camera: Partial<LodViewCamera>;
    }> = {},
  ): ProjectionCase => {
    const min = [range(-2, 1), range(-2, 1), range(-2, 1)];
    const aabb =
      overrides.aabb ??
      new Float32Array([...min, ...min.map((value) => value + range(0.01, 3))] as number[]);
    const world = overrides.world ?? new Float32Array(16);
    if (overrides.world === undefined) {
      // General affine (rotation, scale and shear), including the transformed center.
      for (let column = 0; column < 3; column += 1) {
        for (let row = 0; row < 3; row += 1) world[column * 4 + row] = range(-2, 2);
      }
      world[12] = range(-50, 50);
      world[13] = range(-50, 50);
      world[14] = range(-50, 50);
      world[15] = 1;
    }
    const orthoHalf = range(0.5, 40);
    const camera: LodViewCamera = {
      position: vec3.create(range(-60, 60), range(-60, 60), range(-60, 60)),
      projection,
      fov: range(0.2, 2.8),
      orthoTop: orthoHalf,
      orthoBottom: -orthoHalf * range(0.5, 1.5),
      ...overrides.camera,
    };
    return { aabb, world, camera };
  };
  for (let index = 0; index < 256; index += 1) cases.push(makeCase('perspective'));
  for (let index = 0; index < 128; index += 1) cases.push(makeCase('orthographic'));
  const flat = new Float32Array([0, 0, 0, 0, 0, 0]);
  const atCamera = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1]);
  const cameraAt = { position: vec3.create(3, 4, 5) };
  cases.push(
    makeCase('perspective', { aabb: flat }),
    makeCase('orthographic', { aabb: flat }),
    makeCase('perspective', { camera: { fov: 0 } }),
    makeCase('perspective', { camera: { fov: Number.NaN } }),
    makeCase('perspective', {
      aabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      world: atCamera,
      camera: cameraAt,
    }),
    makeCase('orthographic', { world: atCamera, camera: cameraAt }),
    makeCase('orthographic', { camera: { orthoTop: 2, orthoBottom: 2 } }),
  );
  return cases;
}

function projectionReference(item: ProjectionCase): number {
  type Slot = Parameters<typeof projectedHeightForCandidate>[0];
  type Camera = Parameters<typeof projectedHeightForCandidate>[1];
  const slot = { snapshot: { localAabb: item.aabb, transform: { world: item.world } } };
  return projectedHeightForCandidate(slot as unknown as Slot, item.camera as unknown as Camera);
}

interface Evidence {
  readonly projection: Float32Array;
  readonly selection: Uint32Array;
  readonly ramp: Uint32Array;
}

async function runHarness(
  projections: readonly ProjectionCase[],
  selections: ReadonlyArray<{
    height: number;
    previousLevel: number;
    historyValid: boolean;
    chain: number;
  }>,
  chains: readonly (readonly GpuLodRow[])[],
  ramp: readonly number[],
): Promise<Evidence> {
  const adapter = await globalThis.navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable for LOD projection parity');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: LOD_PROJECTION_HARNESS_WGSL });
  const errors = (await module.getCompilationInfo()).messages.filter(
    (message) => message.type === 'error',
  );
  expect(errors.map((message) => message.message).join('\n')).toBe('');

  const projectionBytes = new ArrayBuffer(projections.length * LOD_PROJECTION_CASE_BYTES);
  const projectionView = new DataView(projectionBytes);
  projections.forEach((item, index) => {
    const base = index * LOD_PROJECTION_CASE_BYTES;
    for (let axis = 0; axis < 3; axis += 1) {
      projectionView.setFloat32(base + axis * 4, item.aabb[axis] ?? 0, true);
      projectionView.setFloat32(base + 16 + axis * 4, item.aabb[axis + 3] ?? 0, true);
    }
    item.world.forEach((value, offset) => {
      projectionView.setFloat32(base + 32 + offset * 4, value, true);
    });
    writeLodViewConstants(projectionView, base + 96, item.camera);
  });
  const selectionBytes = new ArrayBuffer(selections.length * LOD_SELECTION_CASE_BYTES);
  const selectionView = new DataView(selectionBytes);
  selections.forEach((item, index) => {
    const base = index * LOD_SELECTION_CASE_BYTES;
    selectionView.setFloat32(base, item.height, true);
    selectionView.setUint32(base + 4, item.previousLevel, true);
    selectionView.setUint32(base + 8, item.historyValid ? 1 : 0, true);
    selectionView.setUint32(base + 12, item.chain, true);
  });
  const chainBytes = new Uint8Array(chains.length * LOD_CHAIN_BYTES);
  chains.forEach((rows, index) => {
    chainBytes.set(encodeGpuLodRows(rows), index * LOD_CHAIN_BYTES);
    new DataView(chainBytes.buffer).setUint32(
      index * LOD_CHAIN_BYTES + LOD_PROJECTION_ROW_CAPACITY * GPU_SCENE_LAYOUTS.lod.stride,
      rows.length,
      true,
    );
  });

  const input = (data: ArrayBufferView | ArrayBuffer) => {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const buffer = device.createBuffer({
      size: Math.max(16, Math.ceil(bytes.byteLength / 4) * 4),
      usage: BUFFER_STORAGE,
      mappedAtCreation: true,
    });
    new Uint8Array(buffer.getMappedRange()).set(bytes);
    buffer.unmap();
    return buffer;
  };
  const output = (size: number) =>
    device.createBuffer({ size, usage: BUFFER_STORAGE | BUFFER_COPY_SRC });
  const buffers = [
    input(projectionBytes),
    input(selectionBytes),
    input(chainBytes),
    input(new Float32Array(ramp)),
    output(projections.length * 4),
    output(selections.length * 32),
    output(chains.length * ramp.length * 4),
  ];
  const layout = device.createBindGroupLayout({
    entries: buffers.map((_, binding) => ({
      binding,
      visibility: COMPUTE_STAGE,
      buffer: { type: binding < 4 ? ('read-only-storage' as const) : ('storage' as const) },
    })),
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const bindGroup = device.createBindGroup({
    layout,
    entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const pipeline = (entryPoint: string) =>
    device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
  const readbacks = buffers
    .slice(4)
    .map((buffer) =>
      device.createBuffer({ size: buffer.size, usage: BUFFER_MAP_READ | BUFFER_COPY_DST }),
    );
  try {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, bindGroup);
    pass.setPipeline(pipeline('project'));
    pass.dispatchWorkgroups(Math.ceil(projections.length / 64));
    pass.setPipeline(pipeline('select_lod'));
    pass.dispatchWorkgroups(Math.ceil(selections.length / 64));
    pass.setPipeline(pipeline('round_trip'));
    pass.dispatchWorkgroups(chains.length);
    pass.end();
    readbacks.forEach((readback, index) => {
      const source = buffers[index + 4];
      if (source !== undefined) encoder.copyBufferToBuffer(source, 0, readback, 0, readback.size);
    });
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    expect(await device.popErrorScope()).toBeNull();
    const read = async (index: number) => {
      const readback = readbacks[index];
      if (readback === undefined) throw new Error('missing readback');
      await readback.mapAsync(BUFFER_MAP_READ);
      const copy = readback.getMappedRange().slice(0);
      readback.unmap();
      return copy;
    };
    return {
      projection: new Float32Array(await read(0)),
      selection: new Uint32Array(await read(1)),
      ramp: new Uint32Array(await read(2)),
    };
  } finally {
    for (const buffer of [...buffers, ...readbacks]) buffer.destroy();
    device.destroy();
  }
}

describe('GPU LOD projection kernels (Dawn parity)', () => {
  it('preserves projected coverage for translated local origins with equivalent world bounds', async () => {
    const pairs = equivalentOriginProjectionCases();
    const evidence = await runHarness(
      pairs.flatMap((pair) => [pair.baseline, pair.shifted]),
      [{ height: 1, previousLevel: 0, historyValid: false, chain: 0 }],
      CHAINS.slice(0, 1).map(chainRows),
      [1],
    );
    for (let index = 0; index < pairs.length; index++) {
      const baseline = evidence.projection[index * 2] ?? Number.NaN;
      expect(baseline).toBeGreaterThan(0.3);
      expect(evidence.projection[index * 2 + 1]).toBeCloseTo(baseline, 5);
    }
  });

  it('match the CPU projection, selection, crossfade and hysteresis references', async () => {
    const chains = CHAINS.map(chainRows);
    const projections = projectionCases();
    const selections = chains.flatMap((rows, chain) =>
      sweepHeights(rows).flatMap((height) =>
        [INVALID_LEVEL, ...rows.map((_, level) => level)].flatMap((previousLevel) =>
          [false, true].map((historyValid) => ({ height, previousLevel, historyValid, chain })),
        ),
      ),
    );
    const ramp = rampHeights();
    const evidence = await runHarness(projections, selections, chains, ramp);

    let projectionMaxAbs = 0;
    let projectionMaxRel = 0;
    let invalidCases = 0;
    projections.forEach((item, index) => {
      const expected = projectionReference(item);
      const actual = evidence.projection[index] ?? Number.NaN;
      if (Number.isNaN(expected)) {
        invalidCases += 1;
        expect(actual, `projection case ${index} must report invalid`).toBeLessThan(0);
        return;
      }
      const abs = Math.abs(actual - expected);
      projectionMaxAbs = Math.max(projectionMaxAbs, abs);
      projectionMaxRel = Math.max(projectionMaxRel, abs / Math.abs(expected));
    });
    expect(invalidCases).toBe(6);
    expect(projectionMaxRel).toBeLessThan(1e-5);

    let selectionMismatches = 0;
    let crossfadeMismatches = 0;
    let pairedCases = 0;
    let fadeMaxAbs = 0;
    let hysteresisHeld = 0;
    let clampMismatches = 0;
    selections.forEach((item, index) => {
      const rows = chains[item.chain] ?? [];
      const expected = selectGpuLod(rows, {
        projectedHeight: item.height,
        previousLevel: item.previousLevel === INVALID_LEVEL ? -1 : item.previousLevel,
        historyValid: item.historyValid,
      }).level;
      const actualLevel = evidence.selection[index * 8];
      if (actualLevel !== expected) selectionMismatches += 1;
      const raw = selectGpuLod(rows, {
        projectedHeight: item.height,
        previousLevel: 0,
        historyValid: false,
      });
      if (expected !== raw.level) hysteresisHeld += 1;

      const draws = crossfadeReference(rows, item.height);
      const finest = Math.min(...draws.map((draw) => draw.level));
      const floor = shadowLodHeightFloor(
        { coverages: rows.map((row) => row.screenCoverage), hysteresis: rows[0]?.hysteresis ?? 0 },
        finest,
      );
      const actualFloor =
        new Float32Array(new Uint32Array([evidence.selection[index * 8 + 6] ?? 0]).buffer)[0] ??
        Number.NaN;
      if (
        evidence.selection[index * 8 + 4] !== raw.level ||
        evidence.selection[index * 8 + 5] !== finest ||
        Math.abs(actualFloor - f(floor)) > 1e-6
      ) {
        clampMismatches += 1;
      }
      const crossLevel = evidence.selection[index * 8 + 1];
      const fade =
        new Float32Array(new Uint32Array([evidence.selection[index * 8 + 2] ?? 0]).buffer)[0] ??
        Number.NaN;
      const paired = evidence.selection[index * 8 + 3] === 1;
      const first = draws[0];
      if (first === undefined || crossLevel !== first.level || paired !== (draws.length === 2)) {
        crossfadeMismatches += 1;
        return;
      }
      if (paired) {
        pairedCases += 1;
        expect(draws[1]).toEqual({ level: first.level + 1, fade: -first.fade });
      }
      fadeMaxAbs = Math.max(fadeMaxAbs, Math.abs(fade - first.fade));
    });
    expect(selectionMismatches).toBe(0);
    expect(clampMismatches).toBe(0);
    expect(crossfadeMismatches).toBe(0);
    expect(fadeMaxAbs).toBeLessThan(1e-5);
    // Falsifiers: the sweep must actually exercise the band and the history.
    expect(pairedCases).toBeGreaterThan(50);
    expect(hysteresisHeld).toBeGreaterThan(50);

    let rampMismatches = 0;
    let rampHeld = 0;
    chains.forEach((rows, chain) => {
      let previous = -1;
      ramp.forEach((height, step) => {
        const expected = selectGpuLod(rows, {
          projectedHeight: height,
          previousLevel: previous,
          historyValid: previous >= 0,
        }).level;
        const raw = selectGpuLod(rows, {
          projectedHeight: height,
          previousLevel: 0,
          historyValid: false,
        });
        if (expected !== raw.level) rampHeld += 1;
        if (evidence.ramp[chain * ramp.length + step] !== expected) rampMismatches += 1;
        previous = expected;
      });
    });
    expect(rampMismatches).toBe(0);
    expect(rampHeld).toBeGreaterThan(10);

    // biome-ignore lint/suspicious/noConsole: parity error evidence
    console.info(
      `[lod-projection parity] projection cases=${projections.length} maxAbs=${projectionMaxAbs.toExponential(3)} maxRel=${projectionMaxRel.toExponential(3)}; ` +
        `selection cases=${selections.length} mismatches=${selectionMismatches} held=${hysteresisHeld}; ` +
        `crossfade paired=${pairedCases} fadeMaxAbs=${fadeMaxAbs.toExponential(3)}; ` +
        `ramp steps=${ramp.length}x${chains.length} held=${rampHeld} mismatches=${rampMismatches}`,
    );
  }, 60_000);
});
