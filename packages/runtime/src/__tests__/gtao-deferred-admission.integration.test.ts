import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
  TONEMAP_LINEAR,
} from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it, vi } from 'vitest';
import * as admissionOwner from '../../../render/src/temporal/standard-scene-data-admission';
import { constructRuntimeRendererHost } from '../renderer-host';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

function planeWorld(): World {
  const world = new World();
  const mesh = testAssets(world)
    .create(createBoxGeometry(40, 40, 0.001).unwrap())
    .unwrap();
  const material = testAssets(world)
    .create(Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1 }))
    .unwrap();
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, -4], quat: [Math.sin(-Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)] },
      },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world.spawn({ component: Skylight, data: {} }).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: 0,
          bloom: 0,
          tonemap: TONEMAP_LINEAR,
        },
      },
    )
    .unwrap();
  return world;
}

function describeFailure(error: unknown): unknown {
  return error instanceof Error ? { ...error, name: error.name, message: error.message } : error;
}

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

it('admits the published Standard Deferred surface when GTAO turns on', async () => {
  const admission = vi.spyOn(admissionOwner, 'createStandardSceneSurfaceAdmission');
  const unavailable = vi.spyOn(admissionOwner, 'standardAoSceneDataUnavailable');
  const manifest = await buildEngineShaderManifest();
  const manifestBytes = JSON.stringify(manifest);
  const host = value(
    await constructRuntimeRendererHost(
      { width: 256, height: 256, getContext: () => null },
      { rhi },
      { shaderManifestUrl: shaderManifestUrl(manifest) },
    ),
  );
  const renderer = host.renderer;
  const errors: unknown[] = [];
  const frames: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(describeFailure(event.error));
  });
  const drawWorld = async (world: World) => {
    const lease = value(renderer.attach(world));
    value(renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'deferred' }));
    try {
      for (let frame = 0; frame < 120; frame += 1) {
        world.update(1 / 60).unwrap();
        propagateTransforms(world).unwrap();
        const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
        if (!drawn.ok) throw drawn.error;
        const completion = await drawn.value.completed;
        frames.push({
          frameId: drawn.value.frameId,
          presentation: drawn.value.presentation,
          completion: describeFailure(completion.ok ? undefined : completion.error),
        });
        value(completion);
        if (drawn.value.presentation === 'ready') return;
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      throw new Error('Deferred structural scene did not become ready');
    } finally {
      lease.dispose();
    }
  };
  let failure: unknown;
  try {
    const receiverReads = value(
      host.assets.shaderRegistry.findMaterialArtifact('forgeax::default-standard-pbr'),
    ).program.entryPoints;
    expect(receiverReads).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'fs_gbuffer', stage: 'fragment' })]),
    );
    const baseline = planeWorld();
    expect(
      testAssets(baseline).shaderRegistry.findMaterialArtifact('forgeax::default-standard-pbr').ok,
    ).toBe(false);
    await drawWorld(baseline);
    value(
      renderer.setProfile({
        ...renderer.inspect().profile,
        ssao: { algorithm: 'gtao', quality: 'high' },
      }),
    );
    await drawWorld(planeWorld());
    expect(errors).toEqual([]);
    expect(admission.mock.calls.length).toBeGreaterThan(0);
    for (const [input] of admission.mock.calls) {
      const contributor = input.contributors.find((row) => row.facts?.selectedPass === 'deferred');
      expect(contributor).toMatchObject({
        geometry: 'mesh',
        deformation: 'rigid',
        entryPoint: 'fs_gbuffer',
      });
      expect(contributor?.facts?.publishedFragmentEntries).toEqual(
        receiverReads?.filter((entry) => entry.stage === 'fragment').map((entry) => entry.name),
      );
    }
    for (const result of admission.mock.results) {
      expect(result).toMatchObject({
        type: 'return',
        value: {
          status: 'available',
          producer: 'standard-deferred-gbuffer',
          missingContributorIds: [],
        },
      });
    }
    expect(unavailable.mock.calls.length).toBeGreaterThan(0);
    for (const [input] of unavailable.mock.calls) {
      expect(input.admission).toMatchObject({
        status: 'available',
        viewIdentity: input.viewIdentity,
        generation: input.generation,
        deviceGeneration: input.deviceGeneration,
        renderPath: input.renderPath,
      });
    }
    expect(unavailable.mock.results).toEqual(
      unavailable.mock.results.map(() => ({ type: 'return', value: undefined })),
    );
  } catch (error) {
    failure = describeFailure(error);
    throw error;
  } finally {
    const evidence = process.env.FORGEAX_GTAO_ADMISSION_EVIDENCE;
    if (evidence !== undefined)
      writeFileSync(
        evidence,
        JSON.stringify(
          {
            backend: 'RhiNull; structural admission only, no pixel or GPU evidence',
            manifest: {
              byteLength: Buffer.byteLength(manifestBytes),
              sha256: createHash('sha256').update(manifestBytes).digest('hex'),
            },
            failure,
            errors,
            frames,
            admission: admission.mock.calls.map(([input], index) => ({
              input,
              result: admission.mock.results[index],
            })),
            unavailable: unavailable.mock.calls.map(([input], index) => ({
              input,
              result: unavailable.mock.results[index],
            })),
            inspection: renderer.inspect(),
          },
          null,
          2,
        ),
      );
    unsubscribe();
    await renderer.dispose();
    admission.mockRestore();
    unavailable.mockRestore();
  }
}, 30_000);
