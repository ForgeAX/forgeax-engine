import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  Fog,
  type FrameReceiptObservation,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  type RenderResult,
  TRANSPARENCY_SORTED,
  TRANSPARENCY_WEIGHTED_BLENDED,
} from '@forgeax/engine-render';
import type { EncodedTape, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialRenderState } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { type OitFragment, oitComposite, sortedComposite } from '../../../render/src/oit/weight';

export const OIT_SIZE = 96;
const CAMERA_Z = 5;
const TILT = (35 * Math.PI) / 180;
const BACKGROUND: [number, number, number] = [0.25, 0.25, 0.25];
const OCCLUDER: [number, number, number] = [0.9, 0.9, 0.1];

export const STRAIGHT_OVER: NonNullable<MaterialRenderState['blend']> = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/** One transparent layer; `tilt` rotates the plane about +Y (interpenetration). */
interface Layer {
  readonly name: 'red' | 'green' | 'blue';
  readonly color: [number, number, number];
  readonly alpha: number;
  readonly tilt: number;
}

/**
 * Three layers crossing at the origin with a shared bounds center: red is in
 * front on the left, green in front on the right, blue between them. No object
 * order composes both halves correctly.
 */
export const OIT_LAYERS: readonly Layer[] = [
  { name: 'red', color: [1, 0, 0], alpha: 0.6, tilt: TILT },
  { name: 'green', color: [0, 1, 0], alpha: 0.5, tilt: -TILT },
  { name: 'blue', color: [0, 0, 1], alpha: 0.4, tilt: 0 },
];

export interface OitProbe {
  readonly name: 'left' | 'right' | 'background' | 'occluded';
  readonly x: number;
  readonly y: number;
}

export const OIT_PROBES: readonly OitProbe[] = [
  { name: 'left', x: 20, y: 48 },
  { name: 'right', x: 60, y: 44 },
  { name: 'background', x: 30, y: 8 },
  { name: 'occluded', x: 84, y: 48 },
];

function worldPoint(probe: OitProbe): [number, number] {
  return [((probe.x + 0.5) / OIT_SIZE) * 2 - 1, 1 - ((probe.y + 0.5) / OIT_SIZE) * 2];
}

/** The fragments the probe ray crosses, with the shader's camera distance. */
export function probeFragments(probe: OitProbe): OitFragment[] {
  const [x, y] = worldPoint(probe);
  if (probe.name === 'background' || probe.name === 'occluded') return [];
  return OIT_LAYERS.map((layer) => {
    const z = -x * Math.tan(layer.tilt);
    return {
      color: layer.color,
      alpha: layer.alpha,
      viewDistance: Math.hypot(x, y, CAMERA_Z - z),
    };
  });
}

export function probeReference(probe: OitProbe): {
  readonly weighted: [number, number, number];
  readonly exact: [number, number, number];
} {
  if (probe.name === 'occluded') return { weighted: [...OCCLUDER], exact: [...OCCLUDER] };
  const fragments = probeFragments(probe);
  return {
    weighted: oitComposite(fragments, BACKGROUND),
    exact: sortedComposite(fragments, BACKGROUND),
  };
}

function unwrap<T>(result: RenderResult<T, unknown> | undefined): T {
  if (result === undefined) throw new Error('Required Renderer operation unavailable');
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function halfToFloat(bits: number): number {
  const exponent = (bits >>> 10) & 31;
  const mantissa = bits & 1023;
  const sign = bits & 0x8000 ? -1 : 1;
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return (
    sign * (exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15))
  );
}

/** Read an RGBA pixel from rgba16float or rgba8 bytes. */
export function readPixel(
  bytes: Uint8Array,
  metadata: { readonly bytesPerRow: number; readonly format: string },
  x: number,
  y: number,
): [number, number, number, number] {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const row = y * metadata.bytesPerRow;
  if (metadata.format === 'rgba16float') {
    const at = (c: number) => halfToFloat(data.getUint16(row + x * 8 + c * 2, true));
    return [at(0), at(1), at(2), at(3)];
  }
  const at = (c: number) => data.getUint8(row + x * 4 + c) / 255;
  return [at(0), at(1), at(2), at(3)];
}

export type ProbeValues = Record<OitProbe['name'], [number, number, number]>;

export interface OitSceneOptions {
  readonly msaa: boolean;
  readonly renderPath: 'forward' | 'deferred';
}

/** Deterministic cyclic scene through the real Renderer. */
export async function createOitScene(renderer: Renderer, options: OitSceneOptions) {
  const world = new World();
  const lease = unwrap(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const quad = (w: number, h: number) =>
    world.allocSharedRef('MeshAsset', createPlaneGeometry(w, h).unwrap());
  const opaque = (color: [number, number, number]) =>
    world.allocSharedRef(
      'MaterialAsset',
      Materials.unlit([...color, 1], { renderState: { cullMode: 'none' } }),
    );
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -3] } },
      { component: MeshFilter, data: { assetHandle: quad(4, 4) } },
      { component: MeshRenderer, data: { materials: [opaque(BACKGROUND)] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0.75, 0, 2] } },
      { component: MeshFilter, data: { assetHandle: quad(0.4, 3) } },
      { component: MeshRenderer, data: { materials: [opaque(OCCLUDER)] } },
    )
    .unwrap();
  const layerMesh = quad(3, 1.2);
  const layerMaterial = (layer: Layer, renderState: MaterialRenderState = {}) =>
    world.allocSharedRef(
      'MaterialAsset',
      Materials.unlit([...layer.color, layer.alpha], {
        renderState: { cullMode: 'none', blend: STRAIGHT_OVER, ...renderState },
      }),
    );
  let layers: EntityHandle[] = [];
  const spawnLayers = (order: readonly number[], renderState: MaterialRenderState = {}) => {
    for (const entity of layers) world.despawn(entity).unwrap();
    layers = order.map((index) => {
      const layer = OIT_LAYERS[index];
      if (layer === undefined) throw new Error(`Missing layer ${index}`);
      return world
        .spawn(
          {
            component: Transform,
            data: {
              pos: [0, 0, 0],
              quat: [0, Math.sin(layer.tilt / 2), 0, Math.cos(layer.tilt / 2)],
            },
          },
          { component: MeshFilter, data: { assetHandle: layerMesh } },
          { component: MeshRenderer, data: { materials: [layerMaterial(layer, renderState)] } },
        )
        .unwrap();
    });
  };
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, CAMERA_Z] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
          near: 0.1,
          far: 10,
          aspect: 1,
          antialias: options.msaa ? 2 : 0,
          tonemap: 1,
          bloom: 0,
          clearColor: [0, 0, 0, 1],
          transparency: TRANSPARENCY_WEIGHTED_BLENDED,
        },
      },
    )
    .unwrap();
  const profile = renderer.inspect().profile;
  unwrap(renderer.setProfile({ ...profile, renderPath: options.renderPath, ssao: false }));
  const setTransparency = (mode: 'sorted' | 'weighted-blended') =>
    world
      .set(camera, Camera, {
        transparency: mode === 'sorted' ? TRANSPARENCY_SORTED : TRANSPARENCY_WEIGHTED_BLENDED,
      })
      .unwrap();
  let completedFrames = 0;
  const sample = async (capture?: {
    readonly recorder: RecorderAttachment;
    readonly onTape: (tape: EncodedTape, probes: ProbeValues) => Promise<void>;
  }): Promise<{
    probes: ProbeValues;
    observation: NonNullable<FrameReceiptObservation['observations']>[number];
  }> => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    unwrap(renderer.requestObservation?.(['linear-hdr']));
    const pending = capture?.recorder.captureFrame();
    if (pending !== undefined) (await capture?.recorder.frameBoundary())?.unwrap();
    const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!drawn.ok)
      throw new Error(
        `draw failed: ${JSON.stringify(drawn.error)} events=${JSON.stringify(errors, (_k, v) => (v instanceof Error ? { ...v, message: v.message, stack: v.stack } : v))}`,
      );
    const frame = drawn.value;
    unwrap(await frame.completed);
    completedFrames++;
    if (pending !== undefined) (await capture?.recorder.frameBoundary())?.unwrap();
    const observation = unwrap(
      await renderer.observe(frame, { include: ['linear-hdr'] }),
    ).observations?.find((entry) => entry.domain === 'linear-hdr');
    if (observation === undefined) throw new Error('Missing linear-hdr observation');
    const probes = Object.fromEntries(
      OIT_PROBES.map((probe) => [
        probe.name,
        readPixel(observation.bytes, observation.metadata, probe.x, probe.y).slice(0, 3),
      ]),
    ) as ProbeValues;
    if (pending !== undefined && capture !== undefined)
      await capture.onTape((await pending).unwrap(), probes);
    return { probes, observation };
  };
  const spawnFog = () =>
    world
      .spawn({
        component: Fog,
        data: { color: [1, 1, 1], density: 0.15, heightFalloff: 0, maxOpacity: 1 },
      })
      .unwrap();
  return {
    world,
    camera,
    errors,
    spawnLayers,
    spawnFog,
    setTransparency,
    sample,
    get completedFrames() {
      return completedFrames;
    },
    dispose() {
      unsubscribe();
      lease.dispose();
      unwrap(renderer.setProfile(profile));
    },
  };
}

export function maxProbeDelta(a: ProbeValues, b: ProbeValues, names = OIT_PROBES) {
  let delta = 0;
  for (const probe of names)
    for (let c = 0; c < 3; c++)
      delta = Math.max(delta, Math.abs((a[probe.name][c] ?? 0) - (b[probe.name][c] ?? 0)));
  return delta;
}

export function expectMatchesReference(probes: ProbeValues, epsilon = 0.05) {
  for (const probe of OIT_PROBES) {
    const expected = probeReference(probe).weighted;
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs((probes[probe.name][c] ?? 0) - (expected[c] ?? 0)),
        `${probe.name}[${c}] live=${JSON.stringify(probes[probe.name])} ref=${JSON.stringify(expected)}`,
      ).toBeLessThanOrEqual(epsilon);
  }
}

/** The shared AC-1/AC-2 journey for one lane and sample count. */
export async function verifyOit(
  renderer: Renderer,
  options: OitSceneOptions & {
    readonly capture?: {
      readonly recorder: RecorderAttachment;
      readonly onTape: (tape: EncodedTape, probes: ProbeValues) => Promise<void>;
    };
  },
) {
  const scene = await createOitScene(renderer, options);
  try {
    scene.spawnLayers([0, 1, 2]);
    await scene.sample();
    const forward = await scene.sample(options.capture);
    expectMatchesReference(forward.probes);
    const inspection = renderer.inspect();
    expect(inspection.transparency).toMatchObject({
      requested: 'weighted-blended',
      resolved: 'weighted-blended',
      accumulatedDrawCount: 3,
      sortedDrawCount: 0,
    });
    expect(inspection.perFramePassNames).toEqual(
      expect.arrayContaining(['oit-accumulate', 'oit-composite']),
    );
    expect(inspection.perFramePassNames).not.toContain('transparent');
    scene.spawnLayers([2, 1, 0]);
    await scene.sample();
    const reversed = (await scene.sample()).probes;
    const oitOrderDelta = maxProbeDelta(forward.probes, reversed);
    expect(oitOrderDelta).toBeLessThanOrEqual(0.01);

    scene.setTransparency('sorted');
    scene.spawnLayers([0, 1, 2]);
    await scene.sample();
    const sortedA = (await scene.sample()).probes;
    expect(renderer.inspect().perFramePassNames).not.toContain('oit-accumulate');
    scene.spawnLayers([2, 1, 0]);
    await scene.sample();
    const sortedB = (await scene.sample()).probes;
    const sortedOrderDelta = maxProbeDelta(sortedA, sortedB, [
      OIT_PROBES[0] as OitProbe,
      OIT_PROBES[1] as OitProbe,
    ]);
    expect(
      sortedOrderDelta,
      'sorted path must be order dependent at a cyclic probe',
    ).toBeGreaterThan(0.1);
    const exactGap = Object.fromEntries(
      OIT_PROBES.map((probe) => {
        const reference = probeReference(probe);
        return [
          probe.name,
          Math.max(...reference.weighted.map((v, c) => Math.abs(v - (reference.exact[c] ?? 0)))),
        ];
      }),
    );
    expect(scene.errors).toEqual([]);
    return {
      options: { msaa: options.msaa, renderPath: options.renderPath },
      weightedBlended: forward.probes,
      weightedBlendedReversed: reversed,
      reference: Object.fromEntries(OIT_PROBES.map((probe) => [probe.name, probeReference(probe)])),
      oitOrderDelta,
      sortedA,
      sortedB,
      sortedOrderDelta,
      weightedVersusExactGap: exactGap,
      completedFrames: scene.completedFrames,
    };
  } finally {
    scene.dispose();
  }
}

/**
 * A lone layer composites exactly under OIT, so with Fog present its accumulated
 * color must match the sorted pass: the accumulate draw fogs itself at its own
 * depth through the same View copy. The unfogged frame falsifies a no-op fog.
 */
export async function verifyOitFog(renderer: Renderer, options: OitSceneOptions) {
  const scene = await createOitScene(renderer, options);
  try {
    scene.spawnLayers([2]);
    await scene.sample();
    const unfogged = (await scene.sample()).probes;
    scene.spawnFog();
    await scene.sample();
    const weightedBlended = (await scene.sample()).probes;
    expect(renderer.inspect().transparency).toMatchObject({
      accumulatedDrawCount: 1,
      sortedDrawCount: 0,
    });
    scene.setTransparency('sorted');
    await scene.sample();
    const sorted = (await scene.sample()).probes;
    const blueOnly = [OIT_PROBES[0] as OitProbe, OIT_PROBES[1] as OitProbe];
    const fogDelta = maxProbeDelta(unfogged, weightedBlended, blueOnly);
    const sortedDelta = maxProbeDelta(weightedBlended, sorted, blueOnly);
    expect(fogDelta, 'Fog must change the OIT layer pixel').toBeGreaterThan(0.1);
    expect(sortedDelta, 'OIT must fog a lone layer exactly like sorted').toBeLessThanOrEqual(0.01);
    expect(scene.errors).toEqual([]);
    return { unfogged, weightedBlended, sorted, fogDelta, sortedDelta };
  } finally {
    scene.dispose();
  }
}
