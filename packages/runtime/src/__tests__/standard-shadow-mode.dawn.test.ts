import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import {
  DirectionalLight,
  type DirectionalShadowFilterLabel,
  DirectionalShadowFilterValue,
  type RenderResult,
} from '@forgeax/engine-render';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { buildPcssScene } from './helpers/portable-pcss';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const SIZE = 128;
const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());

function unwrap<T>(result: RenderResult<T, unknown> | undefined): T {
  if (result === undefined) throw new Error('required Renderer operation is unavailable');
  if (!result.ok) throw result.error;
  return result.value;
}

interface ModeEvidence {
  readonly penumbra: number;
  readonly shadowed: number;
}

it('light shadow settings: PCF1 collapses the PCSS penumbra and castShadow false removes shadows', {
  timeout: 240_000,
}, async () => {
  const target = offscreenCanvas(SIZE);
  const host = await constructRuntimeRendererHost(
    target.canvas,
    { rhi: webgpu },
    { shaderManifestUrl: manifestUrl },
  );
  if (!host.ok) throw new Error(JSON.stringify(host.error));
  const renderer = host.value.renderer;
  const world = new World();
  const { light } = buildPcssScene(world);
  const lease = unwrap(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const original = renderer.inspect().profile;
  const evidence: string[] = [];
  const sample = async (
    renderPath: 'forward' | 'deferred',
    shadowFilter: DirectionalShadowFilterLabel | undefined,
  ): Promise<Float32Array> => {
    world
      .set(light, DirectionalLight, {
        castShadow: shadowFilter !== undefined,
        shadowFilter: DirectionalShadowFilterValue[shadowFilter ?? 'pcf1'],
      })
      .unwrap();
    unwrap(renderer.setProfile({ ...original, renderPath, ssao: false }));
    let luminance: Float32Array | undefined;
    for (let index = 0; index < 6; index++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const last = index === 5;
      const frame = await drawReadyFrame(
        renderer,
        { leases: [lease], camera: { lease }, environment: { lease } },
        last ? ['linear-hdr'] : undefined,
      );
      if (!last) continue;
      const observation = unwrap(
        await renderer.observe(frame, { include: ['linear-hdr'] }),
      ).observations?.find((value) => value.domain === 'linear-hdr');
      if (observation === undefined) throw new Error('missing shadow-mode readback');
      luminance = luminanceRgba16f(observation.bytes, SIZE, SIZE, observation.metadata.bytesPerRow);
    }
    if (luminance === undefined) throw new Error('no shadow-mode sample');
    return luminance;
  };
  const classify = (image: Float32Array, unshadowed: Float32Array): ModeEvidence => {
    let penumbra = 0;
    let shadowed = 0;
    for (let i = 0; i < image.length; i++) {
      const reference = unshadowed[i] ?? 0;
      if (reference <= 1e-3) continue;
      const visibility = (image[i] ?? 0) / reference;
      if (visibility < 0.5) shadowed++;
      if (visibility > 0.1 && visibility < 0.9) penumbra++;
    }
    return { penumbra, shadowed };
  };
  try {
    for (const renderPath of ['deferred', 'forward'] as const) {
      const off = await sample(renderPath, undefined);
      const filtered = classify(await sample(renderPath, 'pcssHigh'), off);
      const hard = classify(await sample(renderPath, 'pcf1'), off);
      const summary = JSON.stringify({ renderPath, filtered, hard });
      evidence.push(summary);
      // `off` is the unshadowed reference, so a no-op `off` leaves nothing shadowed here.
      // Both filters cast the same occluder footprint...
      expect(filtered.shadowed, summary).toBeGreaterThan(400);
      expect(hard.shadowed / filtered.shadowed, summary).toBeGreaterThan(0.75);
      expect(hard.shadowed / filtered.shadowed, summary).toBeLessThan(1.33);
      // ...but only the PCSS filter spreads a soft penumbra ring.
      expect(filtered.penumbra, summary).toBeGreaterThan(3 * hard.penumbra);
      expect(filtered.penumbra - hard.penumbra, summary).toBeGreaterThan(150);
    }
    expect(renderer.inspect().directionalShadow.requested).toBeDefined();
    expect(errors, JSON.stringify(errors)).toEqual([]);
  } finally {
    const dir = process.env.FORGEAX_SHADOW_EVIDENCE;
    if (dir) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'standard-shadow-mode.json'), `[${evidence.join(',')}]`);
    }
    unsubscribe();
    lease.dispose();
    unwrap(renderer.setProfile(original));
    renderer.dispose();
    target.destroy();
  }
});
