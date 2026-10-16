import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { RenderPipelineDescriptor } from '@forgeax/engine-rhi';
import { RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

/** Lifecycle fixture whose Standard program sources append `marker`. */
function manifestWithStandardSource(marker: string): string {
  const data = renderLifecycleManifestUrl();
  const manifest = JSON.parse(decodeURIComponent(data.slice(data.indexOf(',') + 1)));
  for (const entry of manifest.materialShaders) {
    if (entry.identifier !== 'forgeax::default-standard-pbr') continue;
    entry.composedWgsl += marker;
    entry.receipt = createStandardPbrArtifactReceipt(false, false);
    for (const variant of entry.variants) {
      variant.composedWgsl += marker;
      variant.receipt = createStandardPbrArtifactReceipt(
        false,
        variant.defines.VERTEX_COLOR_AVAILABLE === true,
      );
    }
  }
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

/** Fragment entries of the Standard program pipelines built while drawing one opaque cube. */
async function fragmentEntriesForOpaqueStandard(marker: string): Promise<string[]> {
  const pipelines: RenderPipelineDescriptor[] = [];
  const original = RhiNullDevice.prototype.createRenderPipeline;
  const spy = vi
    .spyOn(RhiNullDevice.prototype, 'createRenderPipeline')
    .mockImplementation(function (this: RhiNullDevice, descriptor) {
      pipelines.push(descriptor);
      return original.call(this, descriptor);
    });
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    undefined,
    { shaderManifestUrl: manifestWithStandardSource(marker) },
    {
      rhi,
      createShaderModule: async (device, descriptor) => rhi.createShaderModule(device, descriptor),
    },
  );
  try {
    const initialized = await renderer.initialization;
    if (!initialized.ok) throw new Error(JSON.stringify(initialized.error));
    const world = new World();
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    const attached = attachment.value;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: 0 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: DirectionalLight,
          data: { direction: [0, -1, -1], color: [1, 1, 1], intensity: 1 },
        },
      )
      .unwrap();
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [1, 1, 1, 1] }),
    );
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const errors: unknown[] = [];
    renderer.onError((error) => errors.push(error));
    for (let frame = 0; frame < 3; frame++) {
      world.update().unwrap();
      const drawn = renderer.draw({
        leases: [attached],
        camera: { lease: attached },
        environment: { lease: attached },
      });
      if (!drawn.ok) throw new Error(JSON.stringify({ error: drawn.error, errors }));
    }
    expect(errors).toEqual([]);
    return pipelines
      .filter((descriptor) => descriptor.label?.includes('forgeax::default-standard-pbr') === true)
      .map((descriptor) => descriptor.fragment?.entryPoint ?? '<none>');
  } finally {
    spy.mockRestore();
    await renderer.dispose();
  }
}

describe('Standard opaque forward entry on the real Renderer (rhi-null)', () => {
  it('records opaque Standard draws with fs_opaque when the program declares it', async () => {
    // rhi-null does not compile WGSL; the fixture only declares the entry the
    // way every composed Standard template does.
    const entries = await fragmentEntriesForOpaqueStandard('\n// fn fs_opaque(in : VsOut)\n');
    expect(entries).toContain('fs_opaque');
    expect(entries).not.toContain('fs_main');
  });

  it('keeps fs_main for programs that predate fs_opaque', async () => {
    const entries = await fragmentEntriesForOpaqueStandard('');
    expect(entries).toContain('fs_main');
    expect(entries).not.toContain('fs_opaque');
  });
});
