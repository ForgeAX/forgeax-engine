import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import type {
  RenderPipelineDescriptor,
  Result,
  RhiAdapter,
  RhiCaps,
  RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import {
  rhi as nullRhi,
  RhiNullCommandEncoder,
  RhiNullDevice,
  RhiNullQueue,
} from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { type MaterialAsset, type MaterialRenderState, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../components';
import {
  ANTIALIAS_MSAA,
  Camera,
  perspective,
  TRANSPARENCY_SORTED,
  TRANSPARENCY_WEIGHTED_BLENDED,
} from '../components/camera';
import { constructRendererHost } from '../construct-renderer';
import { Materials } from '../materials';
import { OIT_ACCUMULATE_PASS, OIT_COMPOSITE_PASS } from '../pipeline/standard-transparency';
import { testAssets } from './helpers/runtime-assets';
import { standardPbrFixtureVariants } from './shader-manifest-fixture';

const STRAIGHT_OVER: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

const WIDTH = 64;
const HEIGHT = 48;
/** rgba16float accum + r16float weight, one sample. */
const OIT_BYTES_PER_PIXEL = 8 + 2;

const MANIFEST = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    entries: [
      { hash: 'pbr00000', wgsl: '/* f_schlick( */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit */', glsl: '', bindings: '' },
      { hash: 'tonemap0', wgsl: 'struct TonemapParams {}', glsl: '', bindings: '' },
    ],
    materialShaders: [
      ['forgeax::default-standard-pbr', DEFAULT_STANDARD_PBR_PARAM_SCHEMA, '/* f_schlick( */'],
      ['forgeax::default-unlit', DEFAULT_UNLIT_PARAM_SCHEMA, '/* unlit */'],
    ].map(([identifier, schema, wgsl]) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: wgsl,
      paramSchema: JSON.stringify(schema),
      variants:
        identifier === 'forgeax::default-standard-pbr'
          ? standardPbrFixtureVariants(wgsl as string)
          : [],
    })),
  }),
)}`;

type LostInfo = { readonly reason: 'destroyed' | 'unknown'; readonly message: string };

/** Null device with a caps mask, a pipeline log and a controllable loss. */
class OitNullDevice extends RhiNullDevice {
  readonly pipelines: RenderPipelineDescriptor[] = [];
  private readonly loss: { promise: Promise<LostInfo>; resolve: (info: LostInfo) => void };

  constructor(private readonly capsMask: Partial<RhiCaps>) {
    super(
      new RhiNullQueue(),
      (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device),
    );
    let resolve!: (info: LostInfo) => void;
    const promise = new Promise<LostInfo>((next) => {
      resolve = next;
    });
    this.loss = { promise, resolve };
  }

  override get caps(): RhiCaps {
    return { ...super.caps, ...this.capsMask };
  }

  override get lost(): Promise<LostInfo> {
    return this.loss.promise;
  }

  override createRenderPipeline(descriptor: RenderPipelineDescriptor) {
    this.pipelines.push(descriptor);
    return super.createRenderPipeline(descriptor);
  }

  lose(): void {
    this.loss.resolve({ reason: 'unknown', message: 'OIT lifecycle probe' });
  }
}

class OitNullAdapter implements RhiAdapter {
  readonly features: ReadonlySet<GPUFeatureName> = new Set();
  readonly limits: Readonly<Record<string, number>> = {};
  readonly devices: OitNullDevice[] = [];

  constructor(private readonly capsMask: Partial<RhiCaps> = {}) {}

  requestDevice(): Promise<Result<RhiDevice, RhiError>> {
    const device = new OitNullDevice(this.capsMask);
    this.devices.push(device);
    return Promise.resolve(ok(device));
  }
}

type Draw = 'eligible' | 'additive' | 'depth-write' | 'custom-entry';

function transparentMaterial(kind: Draw): MaterialAsset {
  const renderState: MaterialRenderState = {
    cullMode: 'none',
    blend: kind === 'additive' ? ADDITIVE : STRAIGHT_OVER,
    ...(kind === 'depth-write' ? { depthWriteEnabled: true } : {}),
  };
  const material = Materials.unlit([0.2, 0.4, 0.8, 0.5], { renderState });
  if (kind !== 'custom-entry') return material;
  return {
    ...material,
    passes: (material.passes ?? []).map((pass) => ({
      ...pass,
      program: { ...pass.program, fragmentEntry: 'fs_custom' },
    })),
  } as unknown as MaterialAsset;
}

async function oitRenderer(capsMask: Partial<RhiCaps> = {}) {
  const adapter = new OitNullAdapter(capsMask);
  const canvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext: () => null,
  } as unknown as HTMLCanvasElement;
  const created = await constructRendererHost(
    canvas,
    { rhi: { ...nullRhi, requestAdapter: async () => ok(adapter) } },
    { shaderManifestUrl: MANIFEST },
  );
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const { renderer } = created.value;
  const world = new World();
  const assets = testAssets(world);
  const lease = renderer.attach(world);
  if (!lease.ok) throw new Error(JSON.stringify(lease.error));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: WIDTH / HEIGHT }),
          transparency: TRANSPARENCY_WEIGHTED_BLENDED,
        },
      },
    )
    .unwrap();
  const mesh = assets.create(createPlaneGeometry(1, 1).unwrap()).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -1] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      {
        component: MeshRenderer,
        data: { materials: [assets.create(Materials.unlit([1, 1, 1, 1])).unwrap()] },
      },
    )
    .unwrap();
  const spawned: ReturnType<World['spawn']>[] = [];
  const spawnDraws = (kinds: readonly Draw[]) => {
    for (const result of spawned.splice(0)) world.despawn(result.unwrap()).unwrap();
    kinds.forEach((kind, index) => {
      spawned.push(
        world.spawn(
          { component: Transform, data: { pos: [index * 0.1, 0, index * 0.1] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          {
            component: MeshRenderer,
            data: { materials: [assets.create(transparentMaterial(kind)).unwrap()] },
          },
        ),
      );
    });
  };
  const request = {
    leases: [lease.value],
    camera: { lease: lease.value },
    environment: { lease: lease.value },
  } as const;
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const frame = renderer.draw(request);
    if (!frame.ok) throw new Error(JSON.stringify(frame.error));
    const completed = await frame.value.completed;
    if (!completed.ok) throw new Error(JSON.stringify(completed.error));
    return renderer.inspect();
  };
  const setTransparency = (mode: 'sorted' | 'weighted-blended') =>
    world
      .set(camera, Camera, {
        transparency: mode === 'sorted' ? TRANSPARENCY_SORTED : TRANSPARENCY_WEIGHTED_BLENDED,
      })
      .unwrap();
  return {
    adapter,
    canvas,
    renderer,
    request,
    errors,
    spawnDraws,
    draw,
    setTransparency,
    setMsaa() {
      world.set(camera, Camera, { antialias: ANTIALIAS_MSAA }).unwrap();
    },
    dispose() {
      unsubscribe();
      lease.value.dispose();
      renderer.dispose();
      assets.dispose();
    },
  };
}

function oitPipelines(device: OitNullDevice | undefined) {
  const entries = (device?.pipelines ?? []).map((descriptor) => descriptor.fragment?.entryPoint);
  return {
    accumulate: entries.filter((entry) => entry === 'fs_oit' || entry === 'fs_oit_premultiplied')
      .length,
    composite: entries.filter((entry) => entry === 'fs_oit_composite').length,
  };
}

function liveGraphBytes(inspection: { renderGraphResourceAllocation?: { liveBytes: number } }) {
  const bytes = inspection.renderGraphResourceAllocation?.liveBytes;
  if (bytes === undefined) throw new Error('Missing render-graph allocation facts');
  return bytes;
}

const NO_INELIGIBLE = {
  'blend-not-eligible': 0,
  'depth-write-enabled': 0,
  'program-without-oit-output': 0,
};

describe('weighted blended OIT on the real Renderer (rhi-null)', () => {
  it('elides only empty sorted load/store passes across live transparent membership changes', async () => {
    const host = await oitRenderer();
    try {
      host.setTransparency('sorted');
      for (const kinds of [[], ['eligible'], []] as const) {
        host.spawnDraws(kinds);
        await host.draw();
        const device = host.adapter.devices.at(-1);
        if (device === undefined) throw new Error('Missing live device');
        const first = device.framePassNames.length;
        await host.draw();
        const executed = device.framePassNames.slice(first);
        expect(executed.includes('transparent')).toBe(kinds.length > 0);
        expect(executed).toContain('main');
      }
      expect(host.errors).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('preserves the empty sorted pass when it owns an MSAA resolve', async () => {
    const host = await oitRenderer();
    try {
      host.setTransparency('sorted');
      host.setMsaa();
      host.spawnDraws([]);
      await host.draw();
      const device = host.adapter.devices.at(-1);
      if (device === undefined) throw new Error('Missing live device');
      const first = device.framePassNames.length;
      await host.draw();
      expect(device.framePassNames.slice(first)).toContain('transparent');
      expect(host.errors).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('accumulates eligible draws and records the shared-blend target pipeline', async () => {
    const host = await oitRenderer();
    try {
      host.spawnDraws(['eligible', 'eligible']);
      await host.draw();
      const inspection = await host.draw();
      expect(inspection.transparency).toEqual({
        requested: 'weighted-blended',
        resolved: 'weighted-blended',
        accumulatedDrawCount: 2,
        sortedDrawCount: 0,
        ineligible: NO_INELIGIBLE,
      });
      const names = inspection.perFramePassNames;
      expect(names).toEqual(expect.arrayContaining([OIT_ACCUMULATE_PASS, OIT_COMPOSITE_PASS]));
      expect(names.indexOf(OIT_COMPOSITE_PASS)).toBeGreaterThan(names.indexOf(OIT_ACCUMULATE_PASS));
      expect(names).not.toContain('transparent');
      const accumulate = host.adapter.devices[0]?.pipelines.find(
        (descriptor) => descriptor.fragment?.entryPoint === 'fs_oit',
      );
      expect(accumulate?.fragment?.targets.map((target) => target?.format)).toEqual([
        'rgba16float',
        'r16float',
      ]);
      expect(accumulate?.depthStencil?.depthWriteEnabled).toBe(false);
      expect(host.errors).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('keeps every ineligible reason in the sorted residual after the composite', async () => {
    const host = await oitRenderer();
    try {
      host.spawnDraws(['eligible', 'additive', 'depth-write', 'custom-entry']);
      await host.draw();
      const inspection = await host.draw();
      expect(inspection.transparency).toEqual({
        requested: 'weighted-blended',
        resolved: 'weighted-blended',
        accumulatedDrawCount: 1,
        sortedDrawCount: 3,
        ineligible: {
          'blend-not-eligible': 1,
          'depth-write-enabled': 1,
          'program-without-oit-output': 1,
        },
      });
      const names = inspection.perFramePassNames;
      expect(names.indexOf(OIT_ACCUMULATE_PASS)).toBeGreaterThanOrEqual(0);
      expect(names.indexOf('transparent')).toBeGreaterThan(names.indexOf(OIT_COMPOSITE_PASS));
      expect(host.errors).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it.each([
    ['only ineligible draws', ['additive', 'depth-write'] as Draw[], 'weighted-blended', 2],
    ['zero transparent draws', [] as Draw[], 'weighted-blended', 0],
    ['a sorted view', ['eligible', 'eligible'] as Draw[], 'sorted', 2],
  ] as const)('adds no OIT pass, pipeline or target for %s', async (_label, kinds, mode, sorted) => {
    const host = await oitRenderer();
    try {
      host.setTransparency(mode);
      host.spawnDraws(kinds);
      await host.draw();
      const inspection = await host.draw();
      expect(inspection.transparency).toMatchObject({
        requested: mode,
        resolved: mode,
        accumulatedDrawCount: 0,
        sortedDrawCount: sorted,
      });
      expect(inspection.perFramePassNames).not.toContain(OIT_ACCUMULATE_PASS);
      expect(inspection.perFramePassNames).not.toContain(OIT_COMPOSITE_PASS);
      expect(oitPipelines(host.adapter.devices[0])).toEqual({ accumulate: 0, composite: 0 });
      expect(host.errors).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('falls back to sorted with capability-absent when rgba16float is not renderable', async () => {
    const host = await oitRenderer({ rgba16floatRenderable: false });
    try {
      host.spawnDraws(['eligible', 'eligible']);
      await host.draw();
      const inspection = await host.draw();
      expect(inspection.capabilities.rgba16floatRenderable).toBe(false);
      expect(inspection.transparency).toEqual({
        requested: 'weighted-blended',
        resolved: 'sorted',
        reason: 'capability-absent',
        capability: 'rgba16floatRenderable',
        accumulatedDrawCount: 0,
        sortedDrawCount: 2,
        ineligible: NO_INELIGIBLE,
      });
      expect(inspection.perFramePassNames).toContain('transparent');
      expect(inspection.perFramePassNames).not.toContain(OIT_ACCUMULATE_PASS);
      expect(oitPipelines(host.adapter.devices[0])).toEqual({ accumulate: 0, composite: 0 });
      expect(host.errors).toEqual([]);
    } finally {
      host.dispose();
    }
  });
});

describe('weighted blended OIT lifecycle', () => {
  it('owns exactly the OIT target bytes across mode toggles and resizes', async () => {
    const host = await oitRenderer();
    try {
      host.spawnDraws(['eligible', 'eligible']);
      host.setTransparency('sorted');
      await host.draw();
      const sortedBytes = liveGraphBytes(await host.draw());
      for (let cycle = 0; cycle < 3; cycle += 1) {
        host.setTransparency('weighted-blended');
        await host.draw();
        const oit = await host.draw();
        expect(oit.perFramePassNames).toContain(OIT_COMPOSITE_PASS);
        expect(liveGraphBytes(oit) - sortedBytes).toBe(WIDTH * HEIGHT * OIT_BYTES_PER_PIXEL);
        host.setTransparency('sorted');
        await host.draw();
        const sorted = await host.draw();
        expect(sorted.perFramePassNames).not.toContain(OIT_ACCUMULATE_PASS);
        expect(liveGraphBytes(sorted)).toBe(sortedBytes);
      }

      host.setTransparency('weighted-blended');
      for (const [width, height] of [
        [80, 60],
        [33, 17],
        [WIDTH, HEIGHT],
      ] as const) {
        host.canvas.width = width;
        host.canvas.height = height;
        await host.draw();
        const resized = await host.draw();
        expect(resized.transparency?.accumulatedDrawCount).toBe(2);
        expect(resized.perFramePassNames).toContain(OIT_COMPOSITE_PASS);
        host.setTransparency('sorted');
        await host.draw();
        const baseline = liveGraphBytes(await host.draw());
        host.setTransparency('weighted-blended');
        await host.draw();
        expect(liveGraphBytes(await host.draw()) - baseline).toBe(
          width * height * OIT_BYTES_PER_PIXEL,
        );
      }
      // Pipeline state belongs to the compiled graph: a stable topology
      // records frames without creating another OIT pipeline.
      const settled = oitPipelines(host.adapter.devices[0]);
      for (let frame = 0; frame < 10; frame += 1) await host.draw();
      expect(oitPipelines(host.adapter.devices[0])).toEqual(settled);
      expect(host.errors).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('rebuilds the OIT lane on the recovered device', async () => {
    const host = await oitRenderer();
    try {
      host.spawnDraws(['eligible', 'additive']);
      await host.draw();
      const before = await host.draw();
      expect(before.transparency?.accumulatedDrawCount).toBe(1);
      for (let recovery = 0; recovery < 2; recovery += 1) {
        host.adapter.devices.at(-1)?.lose();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(host.renderer.state()).toBe('device-lost');
        expect((await host.renderer.recover()).ok).toBe(true);
        expect(host.renderer.state()).toBe('alive');
        await host.draw();
        const after = await host.draw();
        expect(after.frame.deviceGeneration).toBeGreaterThan(before.frame.deviceGeneration);
        expect(after.transparency).toEqual(before.transparency);
        expect(after.perFramePassNames).toEqual(
          expect.arrayContaining([OIT_ACCUMULATE_PASS, OIT_COMPOSITE_PASS, 'transparent']),
        );
        const device = host.adapter.devices.at(-1);
        expect(oitPipelines(device).composite).toBe(1);
        expect(oitPipelines(device).accumulate).toBeGreaterThan(0);
      }
      expect(host.adapter.devices).toHaveLength(3);
    } finally {
      host.dispose();
    }
  });
});
