import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { downsample, error, json, save, scene } from './taa-maturity.fixture';

it.skipIf(process.env.TAA_MATURITY !== 'texture')(
  'retains textured detail against independent spatial HDR integration',
  { timeout: 240_000, retry: 0 },
  async () => {
    const recorder = attachRecorder(webgpu).unwrap();
    const make = async (width: number, height: number, recorded = false) => {
      const carrier = await scene(width, height, recorded ? { rhi: recorder.backend.rhi } : {});
      for (const entity of carrier.moving) carrier.world.despawn(entity).unwrap();
      const pixels = Uint8Array.from({ length: 192 * 144 * 4 }, (_, i) =>
        i % 4 === 3
          ? 255
          : ((Math.floor(i / 4) % 192) + Math.floor(i / (4 * 192))) % 2 === 0
            ? 230
            : 40,
      );
      const texture = carrier.world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 192, height: 144 } },
        format: 'rgba8unorm',
        data: pixels,
        colorSpace: 'linear',
        mips: { kind: 'none' },
      });
      carrier.world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          {
            component: MeshFilter,
            data: {
              assetHandle: carrier.world.allocSharedRef(
                'MeshAsset',
                createPlaneGeometry(3.8, 2.8).unwrap(),
              ),
            },
          },
          {
            component: MeshRenderer,
            data: {
              materials: [
                carrier.world.allocSharedRef(
                  'MaterialAsset',
                  Materials.unlit([2, 2, 2, 1], { baseColorTexture: texture }),
                ),
              ],
            },
          },
        )
        .unwrap();
      return carrier;
    };
    const high = await make(1024, 768),
      current = await make(256, 192, true);
    const gradient = (p: Uint8Array) => {
      let sum = 0;
      for (let y = 8; y < 184; y++)
        for (let x = 8; x < 248; x++) {
          const i = (y * 256 + x) * 4;
          sum +=
            Math.abs((p[i + 4] ?? 0) - (p[i - 4] ?? 0)) +
            Math.abs((p[i + 256 * 4] ?? 0) - (p[i - 256 * 4] ?? 0));
        }
      return sum;
    };
    const results = [];
    try {
      const truth = downsample(await high.hdr(), 256, 192);
      save('texture-reference.rgba', truth);
      const alias = await current.pixels();
      save('texture-no-aa.rgba', alias);
      for (const scale of [1, 0.5, 0.67, 0.75]) {
        current.mode(scale === 1 ? undefined : scale);
        for (let f = 0; f < 180; f++) await current.draw();
        const phases = [];
        for (let f = 0; f < 8; f++) {
          if (scale === 1 && f === 0) {
            const pending = recorder.captureFrame();
            (await recorder.frameBoundary()).unwrap();
            phases.push(await current.pixels());
            (await recorder.frameBoundary()).unwrap();
            const capture = (await pending).unwrap();
            save('texture-native.rhitape', capture.bytes);
            const model = buildFrameModel(decodeTape(capture.bytes).unwrap());
            const work = model.works.find((w) =>
              w.pipeline.shaders.some((s) => s.source?.includes('struct TaaResolveParams')),
            );
            if (!work) throw Error('missing textured TAA work');
            json('texture-native-work.json', work);
          } else phases.push(await current.pixels());
        }
        const image = phases[0];
        if (!image) throw Error('missing texture image');
        save(`texture-${scale}.rgba`, image);
        const ratio = gradient(image) / gradient(truth),
          flicker = Math.max(...phases.map((p) => error(p, image).mean));
        results.push({
          scale,
          error: error(image, truth),
          gradientRatio: ratio,
          flicker,
          noAaError: error(alias, truth),
        });
        json('texture-quality.json', {
          reference:
            '4x4 spatial linear HDR integration; static 192x144 checker texture with no mip chain',
          thresholds: { gradient: { native: 0.65, reduced: 0.35 }, flicker: 0.01 },
          results,
        });
        // Existing static detail/flicker budgets, declared before this experiment.
        expect.soft(ratio).toBeGreaterThan(scale === 1 ? 0.65 : 0.35);
        expect.soft(flicker).toBeLessThan(0.01);
      }
    } finally {
      await high.dispose();
      await current.dispose();
    }
  },
);
