import { readFileSync } from 'node:fs';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid, validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { publishRuntimeAssets } from '../../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { constructRuntimeRendererHost } from '../../renderer-host';
import { testAssets } from '../helpers/runtime-assets';

type CookedRecord = {
  readonly specializationKey: string;
  readonly artifactDigest: string;
  readonly programs: readonly {
    readonly artifact: { readonly digest: string; readonly bytes: readonly number[] };
  }[];
  readonly resolved?: {
    readonly values?: unknown;
  };
  readonly receipt?: {
    readonly identity?: {
      readonly layoutIdentity?: string;
      readonly programIdentity?: string;
      readonly pipelineIdentity?: string;
      readonly cookIdentity?: string;
      readonly compilerFingerprint?: string;
    };
    readonly schemaVersion?: string;
  };
};

type MaterialRow = {
  readonly guid: string;
  readonly kind: 'material';
  readonly payload: {
    readonly parent?: string;
    readonly cooked?: CookedRecord;
  };
};

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../../apps/hello/custom-shader/assets/pulse-material.pack.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as { readonly assets: readonly MaterialRow[] };

const authoredShaderPackage = fileURLToPath(
  new URL(
    '../../../../../apps/hello/custom-shader/src/pulse-material.shader.pack.json',
    import.meta.url,
  ),
);

const materialRows = fixture.assets.filter((asset) => asset.kind === 'material');
const root = materialRows.find((asset) => asset.payload.parent === undefined);
const derived = materialRows.find((asset) => asset.payload.parent === root?.guid);

describe('custom-shader cooked MaterialAsset fixture', () => {
  let manifest: Awaited<ReturnType<typeof buildEngineShaderManifest>>;
  // Authored packages compile from source. Keep that cold preparation outside
  // the unchanged 60-second GPU test budget and fail once if compilation fails.
  beforeAll(async () => {
    manifest = await buildEngineShaderManifest({
      materialPackages: [authoredShaderPackage],
    });
  }, 300_000);

  it('keeps browser and Dawn on the same cooked payload with the child override', () => {
    expect(root?.payload.cooked).toBeDefined();
    expect(derived?.payload.cooked).toBeDefined();

    const cookedRecords = [root?.payload.cooked, derived?.payload.cooked];
    for (const cooked of cookedRecords) {
      expect(cooked).toBeDefined();
      expect(cooked?.programs?.[0]?.artifact?.digest).toMatch(/^sha256:/);
      expect(cooked?.artifactDigest).toMatch(/^sha256:/);
      expect(cooked?.receipt?.schemaVersion).toBe('material-cook/4');
      expect(cooked?.receipt?.identity?.layoutIdentity).toMatch(/^sha256-/);
      expect(cooked?.receipt?.identity?.programIdentity).toMatch(/^sha256:/);
      expect(cooked?.receipt?.identity?.pipelineIdentity).toMatch(/^sha256:/);
      expect(cooked?.receipt?.identity?.cookIdentity).toMatch(/^sha256:/);
      expect(cooked?.receipt?.identity?.compilerFingerprint).toMatch(/^sha256-/);
    }
    expect(derived?.payload.cooked?.specializationKey).toBe(
      root?.payload.cooked?.specializationKey,
    );
    expect(derived?.payload.cooked?.artifactDigest).toBe(root?.payload.cooked?.artifactDigest);
    expect(derived?.payload.cooked?.programs?.[0]?.artifact?.bytes).toEqual(
      root?.payload.cooked?.programs?.[0]?.artifact?.bytes,
    );
    expect(root?.payload.cooked?.resolved?.values).toMatchObject({
      baseColor: [0.95, 0.45, 0.2, 1],
      time: 0,
      speed: 2,
    });
    expect(derived?.payload.cooked?.resolved?.values).toMatchObject({
      baseColor: [0.2, 0.55, 0.95, 1],
      time: 0,
      speed: 2,
    });
  });

  it('keeps cooked layout identity and authored coordinate transforms', () => {
    const cooked = root?.payload.cooked;
    expect(cooked?.receipt?.schemaVersion).toBe('material-cook/4');
    expect(cooked?.receipt?.identity?.layoutIdentity).toMatch(/^sha256-/);
    expect(cooked?.receipt?.identity?.programIdentity).toMatch(/^sha256:/);
    expect(cooked?.receipt?.identity?.pipelineIdentity).toMatch(/^sha256:/);
    expect(cooked?.receipt?.identity?.cookIdentity).toMatch(/^sha256:/);
    expect(cooked?.receipt?.identity?.compilerFingerprint).toMatch(/^sha256-/);
    expect(cooked?.resolved?.values).toMatchObject({
      baseColorUvTransform: [0, 0, 1, 1],
      normalUvTransform: [0.125, 0.25, 2, 2],
    });
  });

  it('loads the published material and draws 60 real Engine frames', async () => {
    const shaderManifestUrl = URL.createObjectURL(
      new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
    );
    onTestFinished(() => URL.revokeObjectURL(shaderManifestUrl));
    const gpuErrors: string[] = [];
    let device: GPUDevice | undefined;
    let target: GPUTexture | undefined;
    const canvas = {
      width: 64,
      height: 64,
      getContext: () => ({
        configure(descriptor: GPUCanvasConfiguration) {
          device = descriptor.device;
          device.addEventListener('uncapturederror', (event) =>
            gpuErrors.push(event.error.message),
          );
          target = device.createTexture({
            size: [64, 64],
            format: descriptor.format,
            viewFormats: [
              descriptor.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb',
            ],
            usage: 0x10 | 0x01,
          });
        },
        unconfigure() {},
        getCurrentTexture: () => target,
      }),
      addEventListener() {},
      removeEventListener() {},
    };
    const constructed = await constructRuntimeRendererHost(
      canvas as never,
      {},
      { shaderManifestUrl },
    );
    if (!constructed.ok) throw constructed.error;
    const { renderer, assets } = constructed.value;
    const errors: unknown[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    const world = new World({ assets });
    try {
      // The fixture's parent-less material is the publication root. Keep the
      // runtime smoke on the same authority used by the contract assertions
      // above; the pack payload does not carry a second `role` discriminator.
      if (root === undefined) throw new Error('missing root publication');
      const textureEntries = [
        ['01935b00-7d8c-7c4e-9f12-345678abcd11', [220, 100, 40, 255]],
        ['01935b00-7d8c-7c4e-9f12-345678abcd12', [128, 128, 255, 255]],
      ] as const;
      publishRuntimeAssets(assets, [
        ...textureEntries.map(([guid, color]) => ({
          guid,
          asset: {
            kind: 'texture' as const,
            shape: { viewDimension: '2d' as const, extent: { width: 1, height: 1 } },
            format: 'rgba8unorm' as const,
            data: new Uint8Array(color),
            colorSpace: 'linear' as const,
            mips: { kind: 'none' as const },
          },
        })),
        ...materialRows.map((row) => ({
          guid: row.guid,
          asset: {
            ...row.payload,
            kind: row.kind,
          } as MaterialAsset,
          refs: textureEntries.map(([guid]) => guid),
        })),
      ]);
      const rootGuid = AssetGuid.parse(root.guid);
      if (!rootGuid.ok) throw rootGuid.error;
      const loaded = await assets.load(rootGuid.value, 'material');
      if (!loaded.ok) throw loaded.error;
      const payload = runtimeAssets(assets).borrow<MaterialAsset>(loaded.value).unwrap();
      const projection = assets.getMaterialProjectionForPayload(payload);
      expect(projection?.artifactHash).toBe(root.payload.cooked?.artifactDigest);
      const record = validateCookedMaterialRecord(root.payload.cooked).unwrap();
      const module = assets.read(loaded.value).unwrap().passes?.[0]?.program.module;
      if (module === undefined) throw new Error('material has no program');
      const forwardPrograms = record.programs.filter((candidate) =>
        candidate.selections.some((selection) => selection.pass === 'Forward'),
      );
      expect(forwardPrograms.length).toBeGreaterThan(0);
      for (const program of forwardPrograms) {
        const installed = assets.shaderRegistry.findMaterialArtifact(program.specializationKey);
        if (!installed.ok) throw installed.error;
        expect(installed.value.source).toBe(new TextDecoder().decode(program.artifact.bytes));
      }
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();
      const attached = renderer.attach(world);
      if (!attached.ok) throw attached.error;
      const lease = attached.value;
      const frame = { leases: [lease], camera: { lease }, environment: { lease } };
      const draw = () => {
        world.update().unwrap();
        const rendered = renderer.draw(frame);
        if (!rendered.ok) throw rendered.error;
      };
      const readPixel = async () => {
        if (device === undefined || target === undefined) throw new Error('missing GPU surface');
        const readback = device.createBuffer({
          size: 256,
          usage: 0x08 | 0x01,
        });
        try {
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer(
            { texture: target, origin: [32, 32] },
            { buffer: readback, bytesPerRow: 256 },
            [1, 1],
          );
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(0x01);
          const pixel = [...new Uint8Array(readback.getMappedRange()).slice(0, 4)];
          readback.unmap();
          return pixel;
        } finally {
          readback.destroy();
        }
      };
      draw();
      const background = await readPixel();
      const mesh = createBoxGeometry(1, 1, 1).unwrap();
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
          { component: MeshFilter, data: { assetHandle: testAssets(world).create(mesh).unwrap() } },
          {
            component: MeshRenderer,
            data: { materials: [loaded.value] },
          },
        )
        .unwrap();
      for (let index = 0; index < 60; index++) {
        draw();
        // Match the host's frame boundary so queued shader/texture preparation runs.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const pixel = await readPixel();
      expect(errors).toEqual([]);
      expect(gpuErrors).toEqual([]);
      expect(
        pixel
          .slice(0, 3)
          .reduce((delta, value, index) => delta + Math.abs(value - (background[index] ?? 0)), 0),
      ).toBeGreaterThan(32);
      world.despawn(entity).unwrap();
      draw();
      const removed = await readPixel();
      expect(removed).toEqual(background);
      expect(errors).toEqual([]);
      expect(gpuErrors).toEqual([]);
      if (process.env.FORGEAX_MATERIAL_SMOKE_EVIDENCE === '1') {
        stdout.write(
          `MATERIAL_DRAW_EVIDENCE=${JSON.stringify({
            status: 'pass',
            renderer: 'forgeax-runtime',
            backend: 'dawn-webgpu',
            frames: 60,
            rootGuid: root.guid,
            rootArtifactDigest: readiness.record.artifactDigest,
            materialIdentity: { ...readiness.record.receipt.identity, materialGuid: root.guid },
            pixel,
            background,
            removed,
            observed: { enumerate: true, load: true, bind: true, draw: true, readback: true },
          })}\n`,
        );
      }
    } finally {
      await renderer.dispose();
      target?.destroy();
    }
  }, 60000);
});
