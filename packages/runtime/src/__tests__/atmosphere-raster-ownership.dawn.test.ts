import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Atmosphere,
  Camera,
  DirectionalLight,
  DirectionalShadowFilterValue,
  Fog,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
} from '@forgeax/engine-render';
import { renderGraphCompileCount, renderOrderedViewBindCount } from '@forgeax/engine-render-graph';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { createBarrelRendererFixture } from './barrel-distortion-gpu-fixture';
import { compactTape } from './compact-tape.fixture';
import { testAssets } from './helpers/runtime-assets';

const atmosphereSlots = new Set([18, 19, 20, 21, 23]);
const lightingSlots = new Set([3, 5, 8, 11, 12, 13, 14, 16]);

it('binds the View textures read by native Forward, GBuffer and Deferred Lighting', {
  timeout: 180_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const { renderer, renderTarget } = await createBarrelRendererFixture({
    width: 64,
    height: 64,
    rhi: recorder.backend.rhi,
  });
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error')
      console.error(
        'Atmosphere runtime error',
        JSON.stringify(event.error, (_key, value) =>
          value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value,
        ),
      );
  });
  const world = new World();
  try {
    const source = renderer.attach(world).unwrap();
    const assets = testAssets(world);
    const mesh = assets.create(createBoxGeometry(1000, 1000, 1000).unwrap()).unwrap();
    const surface = assets.create(Materials.standard({ baseColor: [0.6, 0.3, 0.2, 1] })).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 800, -5000] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [surface] } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 800, 0] } },
        {
          component: Camera,
          data: { fov: Math.PI / 3, aspect: 1, near: 1, far: 20000, exposure: 0.0002 },
        },
      )
      .unwrap();
    const atmosphere = world.spawn({ component: Atmosphere, data: {} }).unwrap();
    world.spawn({ component: Fog, data: { density: 0.000025 } }).unwrap();
    world.spawn({ component: Skylight, data: {} }).unwrap();
    const sun = world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, -0.48, -0.87], intensity: 95_000 },
      })
      .unwrap();
    const original = renderer.inspect().profile;
    const out = process.env.FORGEAX_ATMOSPHERE_EVIDENCE_DIR;
    if (out !== undefined) mkdirSync(out, { recursive: true });

    async function capture(
      renderPath: 'forward' | 'deferred',
      direct: boolean,
      perPixel: boolean,
      shadow?: 'pcf' | 'screen',
    ) {
      const compileCount = renderGraphCompileCount();
      const bindCount = renderOrderedViewBindCount();
      renderer
        .setProfile({
          ...original,
          renderPath,
          atmosphere: { aerialPerspectiveQuality: 'fast' },
          ambientOcclusion: { enabled: false },
        })
        .unwrap();
      world
        .set(sun, DirectionalLight, {
          perPixelAtmosphereTransmittance: perPixel,
          castShadow: shadow !== undefined,
          mapSize: 64,
          shadowDistance: 12000,
          shadowFilter: DirectionalShadowFilterValue.pcfVogel,
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const request = direct ? { source, geometryLane: 'direct' as const } : { source };
      await drawReadyFrame(renderer, request);
      const recording = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      try {
        expect((await drawReadyFrame(renderer, request)).presentation).toBe('ready');
      } finally {
        (await recorder.frameBoundary()).unwrap();
      }
      const tape = compactTape((await recording).unwrap());
      if (shadow === undefined) {
        const ordered = renderOrderedViewBindCount() - bindCount;
        expect(renderGraphCompileCount() - compileCount).toBe(ordered);
      }
      if (out !== undefined)
        writeFileSync(
          join(
            out,
            `${renderPath}-${direct ? 'direct' : 'scene'}-${perPixel ? 'pixel' : 'ground'}${shadow === undefined ? '' : `-${shadow}`}.rhitape`,
          ),
          tape.bytes,
        );
      const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
      const worksAtEntry = (entry: RegExp) =>
        model.works.filter((work) =>
          work.pipeline.shaders.some(
            ({ entryPoint }) => entryPoint !== null && entry.test(entryPoint),
          ),
        );
      const assertViewTextures = (
        entry: RegExp,
        slots: ReadonlySet<number>,
        expected: number[],
      ) => {
        const works = worksAtEntry(entry);
        expect(works.length, entry.source).toBeGreaterThan(0);
        for (const work of works) {
          expect(
            work.bindings
              .filter(
                ({ groupIndex, binding, resourceKind }) =>
                  groupIndex === 0 && resourceKind === 'textureView' && slots.has(binding),
              )
              .map(({ binding }) => binding)
              .sort((a, b) => a - b),
            entry.source,
          ).toEqual(expected);
        }
      };
      expect(renderer.inspect({ fields: ['environment'] }).environment?.transport).toEqual({
        solar: perPixel ? 'per-pixel' : 'ground',
        aerial: 'fast',
        carrier: 'volume',
        opaqueApplication: 'screen',
      });
      expect(worksAtEntry(/^atmosphere_fast_fs$/)).toHaveLength(1);
      expect(worksAtEntry(/^atmosphere_(extinction|inscatter)_fs$/)).toHaveLength(0);
      if (renderPath === 'forward' && (shadow === 'pcf' || shadow === 'screen')) {
        assertViewTextures(/^fs_forward_sun_shadow$/, atmosphereSlots, perPixel ? [18] : []);
        assertViewTextures(
          /^fs_forward_sun_shadow$/,
          lightingSlots,
          perPixel ? [11, 12, 13, 14, 16] : [],
        );
      } else if (renderPath === 'deferred') {
        assertViewTextures(/^fs_gbuffer/, atmosphereSlots, []);
        assertViewTextures(/^fs_gbuffer/, lightingSlots, []);
        assertViewTextures(/^fs_standard_deferred/, atmosphereSlots, perPixel ? [18] : []);
        assertViewTextures(
          /^fs_standard_deferred/,
          lightingSlots,
          perPixel ? [3, 8, 11, 12, 13, 14, 16] : [3, 8],
        );
      } else {
        const generalReceiver = perPixel;
        assertViewTextures(/^fs_opaque$/, atmosphereSlots, generalReceiver ? [18] : []);
        assertViewTextures(
          /^fs_opaque$/,
          lightingSlots,
          generalReceiver ? [3, 8, 11, 12, 13, 14, 16] : [3, 8],
        );
      }
    }

    async function verifyChangingAtmosphere(renderPath: 'forward' | 'deferred') {
      const draw = async () => {
        world.update(1 / 60).unwrap();
        propagateTransforms(world).unwrap();
        return drawReadyFrame(renderer, { source }, ['linear-hdr']);
      };
      renderer
        .setProfile({
          ...original,
          renderPath,
          atmosphere: { aerialPerspectiveQuality: 'fast' },
          ambientOcclusion: { enabled: false },
        })
        .unwrap();
      world
        .set(sun, DirectionalLight, {
          direction: [0, -0.48, -0.87],
          castShadow: false,
          perPixelAtmosphereTransmittance: true,
        })
        .unwrap();
      const first = await draw();
      const read = async (receipt: typeof first) => {
        const sampled = (await renderer.observe(receipt, { include: ['linear-hdr'] })).unwrap();
        const hdr = sampled.observations?.find((item) => item.domain === 'linear-hdr');
        if (hdr === undefined) throw new Error('Missing submitted atmosphere color');
        return new Uint16Array(hdr.bytes.buffer, hdr.bytes.byteOffset, hdr.bytes.byteLength / 2);
      };
      const baseline = await read(first);
      const bindCount = renderOrderedViewBindCount();
      const compileCount = renderGraphCompileCount();
      let previous = baseline;
      let changedPixels = 0;
      for (const direction of [
        [0.1, -0.55, -0.83],
        [0.2, -0.66, -0.72],
        [0.24, -0.78, -0.58],
      ]) {
        world.set(sun, DirectionalLight, { direction }).unwrap();
        const changed = await draw();
        expect(changed.graphGeneration).toBe(first.graphGeneration);
        const pixels = await read(changed);
        let currentChanges = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (
            pixels[i] !== previous[i] ||
            pixels[i + 1] !== previous[i + 1] ||
            pixels[i + 2] !== previous[i + 2]
          )
            currentChanges++;
        }
        expect(
          currentChanges,
          JSON.stringify({
            renderPath,
            direction,
            passNames: renderer.inspect().perFramePassNames,
            signature: renderer.inspect({ fields: ['environment'] }).environment?.activeSignature,
          }),
        ).toBeGreaterThan(0);
        changedPixels += currentChanges;
        previous = pixels;
      }
      world.set(atmosphere, Atmosphere, { mieScattering: 8e-6 }).unwrap();
      const mediumEdit = await draw();
      expect(mediumEdit.graphGeneration).toBe(first.graphGeneration);
      const mediumPixels = await read(mediumEdit);
      expect(mediumPixels.some((word, index) => index % 4 !== 3 && word !== previous[index])).toBe(
        true,
      );
      world.set(atmosphere, Atmosphere, { mieScattering: 3.996e-6 }).unwrap();
      expect(renderOrderedViewBindCount()).toBe(bindCount);
      expect(renderGraphCompileCount()).toBe(compileCount);
      world.set(atmosphere, Atmosphere, { backgroundOnly: true }).unwrap();
      const sky = await draw();
      await read(sky);
      expect(sky.graphGeneration).not.toBe(first.graphGeneration);
      expect(renderer.inspect({ fields: ['environment'] }).environment?.transport).toEqual({
        solar: 'none',
        aerial: 'none',
        carrier: 'none',
        opaqueApplication: 'none',
      });
      world.set(atmosphere, Atmosphere, { backgroundOnly: false }).unwrap();
      const restored = await draw();
      await read(restored);
      expect(restored.graphGeneration).not.toBe(sky.graphGeneration);
      expect(renderOrderedViewBindCount() - bindCount).toBe(2);
      expect(renderGraphCompileCount() - compileCount).toBe(2);
      if (out !== undefined) {
        writeFileSync(
          join(out, `${renderPath}-edits.json`),
          JSON.stringify({ changedPixels, numericRebinds: 0, modeRebinds: 2 }),
        );
      }
    }

    await capture('forward', true, true);
    await capture('forward', false, true);
    await capture('forward', false, false);
    await capture('deferred', true, true);
    await capture('deferred', false, false);
    await capture('forward', false, false, 'pcf');
    await capture('forward', false, false, 'screen');
    await capture('forward', false, true, 'screen');
    await capture('forward', false, false, 'pcf');
    await verifyChangingAtmosphere('forward');
    await verifyChangingAtmosphere('deferred');
    source.dispose();
  } catch (error) {
    console.error(
      JSON.stringify(error, (_key, value) =>
        value instanceof Error ? { ...value, message: value.message, cause: value.cause } : value,
      ),
    );
    throw error;
  } finally {
    unsubscribe();
    await renderer.dispose();
    renderTarget.destroy();
    (await recorder.dispose()).unwrap();
  }
});
