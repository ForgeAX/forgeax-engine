import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import {
  Camera,
  DirectionalLight,
  DirectionalShadowFilterValue,
  Materials,
  MeshFilter,
  MeshRenderer,
  type RenderResult,
} from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import {
  type MaterialAsset,
  standardSurfaceParameters,
  type TerrainAsset,
} from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { constructRuntimeRendererHost } from '../renderer-host';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const SIZE = 192;
const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());

function unwrap<T>(result: RenderResult<T, unknown> | undefined): T {
  if (result === undefined) throw new Error('required Renderer operation is unavailable');
  if (!result.ok) throw result.error;
  return result.value;
}

// The original coarse-cascade gate remains at eight centimetres. The opt-in
// one-centimetre control retains the same light, map, geometry and coverage budgets.
const PLATE_HEIGHT = process.env.TERRAIN_NEAR_PLATE_HEIGHT === '0.01' ? 0.01 : 0.08;
// Explicit diagnostic control only: retain the default 5 cm negative result
// separately when a 1 cm plate is entirely below the authored receiver offset.
const NORMAL_BIAS = process.env.TERRAIN_NEAR_NORMAL_BIAS === '0' ? 0 : 0.05;

// A thin plate 8 cm over the ground in the far cascade, lit at 20 degrees: its
// blockers sit about 0.25 m above the ground in light depth. Scaling receiver
// depth bias by the PCF5 kernel radius detached most of that shadow (59 vs 100
// PCF1 pixels); per-tap receiver-plane depth keeps PCF5 at PCF1's coverage.
it.each([
  { receiver: 'mesh', renderPath: 'deferred' },
  { receiver: 'mesh', renderPath: 'forward' },
  { receiver: 'terrain', renderPath: 'deferred' },
  { receiver: 'terrain', renderPath: 'forward' },
] as const)('keeps wide-PCF $receiver $renderPath near-caster shadows in coarse cascades', {
  timeout: 900_000,
}, async ({ receiver, renderPath }) => {
  const artifactDir = process.env.TERRAIN_NEAR_ARTIFACT_DIR;
  const recorder = artifactDir === undefined ? undefined : attachRecorder(webgpu).unwrap();
  const target = offscreenCanvas(SIZE);
  const host = await constructRuntimeRendererHost(
    target.canvas,
    { rhi: recorder?.backend.rhi ?? webgpu },
    { shaderManifestUrl: manifestUrl },
  );
  if (!host.ok) throw new Error(JSON.stringify(host.error));
  const renderer = host.value.renderer;
  const original = renderer.inspect().profile;
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const rows: { filter: string; lit: number; dark: number }[] = [];
  try {
    const world = new World();
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.7, 0.7, 0.7, 1], metallic: 0, roughness: 0.9 }),
    );
    if (receiver === 'terrain') {
      world.components.register(Terrain).unwrap();
      expect(world.components.resolve('Terrain')).toBe(Terrain);
      const packageId = definePackageId('019fca53-7400-7000-8000-000000000011');
      const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
      const layer: MaterialAsset = {
        kind: 'material',
        colorSpace: 'linear',
        parameters: standardSurfaceParameters([]),
        values: { baseColor: [0.7, 0.7, 0.7, 1], metallic: 0, roughness: 0.9 },
        passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
      };
      host.value.assets.catalog(guid('layer'), layer).unwrap();
      const closure = buildTerrainAssets(
        {
          columns: 8,
          rows: 8,
          subsectionVertices: 8,
          spacing: 120 / 7,
          heights: new Float32Array(64),
          weights: new Float32Array(64).fill(1),
          layers: [{ material: guid('layer'), blend: 'weight' }],
        },
        guid,
        { [guid('layer')]: layer },
      ).unwrap();
      for (const [key, asset] of Object.entries(closure))
        host.value.assets.catalog(guid(key), asset).unwrap();
      const table: Record<string, MaterialAsset> = { [guid('layer')]: layer };
      for (const [key, asset] of Object.entries(closure))
        if (asset.kind === 'material') table[guid(key)] = asset;
      const cooker = createMaterialPackCooker();
      for (const [materialGuid, source] of Object.entries(table)) {
        const cooked = await cooker.cook({ guid: materialGuid, source, table });
        const record = validateCookedMaterialRecord(
          (cooked.payload as { cooked: unknown }).cooked,
        ).unwrap();
        const ready = await createMaterialLoader({
          loadPublication: async () => ({
            guid: materialGuid,
            record,
            artifacts: cooked.artifacts,
          }),
          loadReference: async (reference) =>
            !AssetGuid.parse(reference).ok || host.value.assets.lookup(reference) !== undefined,
        }).load({ guid: materialGuid, specializationKey: record.specializationKey ?? '' });
        expect(ready.status).toBe('Ready');
        host.value.assets.recordMaterialReadiness(materialGuid, ready);
        const projection = host.value.assets.getMaterialProjection(materialGuid);
        expect(projection).toBeDefined();
        if (materialGuid !== guid('layer')) {
          for (const passName of ['forward', 'deferred', 'shadow-caster']) {
            const pass = projection?.passes.find((value) => value.name === passName);
            expect(
              pass?.programs.some(
                (program) => program.context.geometry === 'terrain' && program.address === 'direct',
              ),
            ).toBe(true);
          }
        }
      }
      const adopted = host.value.assets.lookup<TerrainAsset>(guid('terrain'));
      if (adopted === undefined) throw new Error('missing adopted Terrain root');
      expect(host.value.assets.terrainClosureCurrent(adopted)).toBe(true);
      world
        .spawn(
          { component: Transform, data: { pos: [-60, 0, -90] } },
          {
            component: Terrain,
            data: {
              asset: world.allocSharedRef('TerrainAsset', adopted),
              forcedLod: 0,
            },
          },
        )
        .unwrap();
    }
    for (const [size, pos] of [
      [
        [120, 0.2, 120],
        [0, -0.1, -30],
      ],
      [
        [0.6, 0.02, 3],
        [0, PLATE_HEIGHT + 0.01, -26],
      ],
    ] as const) {
      if (receiver === 'terrain' && size[0] === 120) continue;
      world
        .spawn(
          { component: Transform, data: { pos: [...pos] } },
          {
            component: MeshFilter,
            data: {
              assetHandle: world.allocSharedRef(
                'MeshAsset',
                createBoxGeometry(size[0], size[1], size[2]).unwrap(),
              ),
            },
          },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    }
    const pitch = (-12 * Math.PI) / 180;
    world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 5, 0], quat: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] },
        },
        {
          component: Camera,
          data: {
            fov: Math.PI / 12,
            aspect: 1,
            near: 0.1,
            far: 80,
            tonemap: 1,
            antialias: 0,
            bloom: 0,
            clearColor: [0, 0, 0, 1],
          },
        },
      )
      .unwrap();
    const elevation = (20 * Math.PI) / 180;
    const light = world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [-Math.cos(elevation), -Math.sin(elevation), 0],
          intensity: 3,
          castShadow: true,
          mapSize: 1024,
          cascadeCount: 4,
          shadowDistance: 40,
          normalBias: NORMAL_BIAS,
        },
      })
      .unwrap();
    const lease = unwrap(renderer.attach(world));
    const sample = async (castShadow: boolean, label: string): Promise<Float32Array> => {
      world.set(light, DirectionalLight, { castShadow }).unwrap();
      unwrap(renderer.setProfile({ ...original, renderPath, ssao: false }));
      for (let index = 0; ; index++) {
        world.update(1 / 60).unwrap();
        propagateTransforms(world).unwrap();
        const last = index === 3;
        if (last) unwrap(renderer.requestObservation?.(['linear-hdr']));
        const capture =
          receiver === 'terrain' && ((!castShadow && last) || (castShadow && index === 0))
            ? recorder?.captureFrame()
            : undefined;
        if (capture !== undefined && recorder !== undefined)
          (await recorder.frameBoundary()).unwrap();
        const frame = unwrap(
          renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
        );
        unwrap(await frame.completed);
        if (capture !== undefined && artifactDir !== undefined && recorder !== undefined) {
          (await recorder.frameBoundary()).unwrap();
          const tape = (await capture).unwrap();
          mkdirSync(artifactDir, { recursive: true });
          writeFileSync(
            resolve(artifactDir, `${receiver}-${renderPath}-${label}.rhitape`),
            tape.bytes,
          );
          const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
          const terrainDraws = model.works.filter(
            (work) =>
              work.kind.startsWith('draw') &&
              work.pipeline.shaders.some(
                (shader) =>
                  shader.stage === 'vertex' &&
                  shader.source !== undefined &&
                  shader.source !== null &&
                  /(?:return|=)\s+terrainVertex\w*\(/.test(shader.source),
              ),
          );
          expect(
            terrainDraws.some((work) => (work.attachments?.colorViewHandleIds.length ?? 0) > 0),
          ).toBe(true);
          if (label === 'pcf1')
            expect(
              model.works.some(
                (work) =>
                  work.kind.startsWith('draw') &&
                  work.attachments?.colorViewHandleIds.length === 0 &&
                  work.pipeline.shaders.some(
                    (shader) => shader.stage === 'fragment' && shader.entryPoint === 'fs_shadow',
                  ),
              ),
            ).toBe(true);
          const work = model.works.map((w) => ({
            index: w.workIndex,
            kind: w.kind,
            colorTargets: w.attachments?.colorViewHandleIds.length,
            shaders: w.pipeline.shaders.map((shader) => ({
              entry: shader.entryPoint,
              terrainKernel: shader.source?.includes('fn terrainDecodeHeight'),
              terrainVertexCall:
                shader.source !== undefined &&
                shader.source !== null &&
                /(?:return|=)\s+terrainVertex\w*\(/.test(shader.source),
              source: shader.source,
            })),
          }));
          writeFileSync(
            resolve(artifactDir, `${receiver}-${renderPath}-${label}-work.json`),
            JSON.stringify(work),
          );
        }
        if (!last) continue;
        const observation = unwrap(
          await renderer.observe(frame, { include: ['linear-hdr'] }),
        ).observations?.find((value) => value.domain === 'linear-hdr');
        if (observation === undefined) throw new Error('missing linear-hdr readback');
        return luminanceRgba16f(observation.bytes, SIZE, SIZE, observation.metadata.bytesPerRow);
      }
    };
    const unshadowed = await sample(false, 'off');
    let max = 0;
    for (const value of unshadowed) max = Math.max(max, value);
    for (const filter of ['pcf1', 'pcf5'] as const) {
      world.set(light, DirectionalLight, {
        shadowFilter: DirectionalShadowFilterValue[filter],
      });
      const shadowed = await sample(true, filter);
      let lit = 0;
      let dark = 0;
      for (let i = 0; i < unshadowed.length; i++) {
        const reference = unshadowed[i] ?? 0;
        if (reference <= 0.15 * max) continue;
        lit++;
        if ((shadowed[i] ?? 0) / reference < 0.5) dark++;
      }
      rows.push({ filter, lit, dark });
    }
    lease.dispose();
  } finally {
    unsubscribe();
    unwrap(renderer.setProfile(original));
    renderer.dispose();
    if (recorder !== undefined) (await recorder.dispose()).unwrap();
    target.destroy();
  }
  if (artifactDir !== undefined) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      resolve(artifactDir, `${receiver}-${renderPath}-coverage.json`),
      JSON.stringify(
        {
          receiver,
          renderPath,
          plateHeight: PLATE_HEIGHT,
          normalBias: NORMAL_BIAS,
          lightElevationDegrees: 20,
          mapSize: 1024,
          rows,
        },
        null,
        2,
      ),
    );
  }
  expect(errors).toEqual([]);
  const dark = (filter: string) => Number(rows.find((row) => row.filter === filter)?.dark);
  for (const row of rows) expect(row.lit, JSON.stringify(rows)).toBeGreaterThan(0.75 * SIZE * SIZE);
  expect(dark('pcf1'), JSON.stringify(rows)).toBeGreaterThan(50);
  expect(dark('pcf5'), JSON.stringify(rows)).toBeGreaterThanOrEqual(0.85 * dark('pcf1'));
});
