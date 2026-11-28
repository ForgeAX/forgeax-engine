import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  type BakeMapKind,
  bakeCorrespondWithGpu,
  bakeLowpolyWithGpu,
  bakeMaps,
  bakeMapsWithGpu,
  dilateAtlas,
  dilateAtlasWithGpu,
  evaluateBakeMapsWithGpu,
  model,
  sel,
} from '../index';

function makeHighLowScene(bevelSegments = 2, cylSegs = 24) {
  const detail = model();
  detail.box({ size: [1.0, 0.2, 0.8] });
  detail.bevel(sel.edges.dihedral('>', 45), { width: 0.03, segments: bevelSegments });
  detail.assign(sel.all(), 'armor');

  const boss = model();
  boss.cylinder({ radiusTop: 0.14, radiusBottom: 0.14, height: 0.06, radialSegments: cylSegs });
  boss.translate(sel.all(), [0.15, 0.125, -0.1]);
  boss.assign(sel.all(), 'trim');
  detail.append(boss);

  const rivet = model();
  rivet.box({ size: [0.06, 0.03, 0.06] });
  rivet.translate(sel.all(), [-0.28, 0.12, 0.18]);
  rivet.assign(sel.all(), 'trim');
  rivet.tag(sel.all(), 'floater');
  rivet.markRole(sel.all(), 'detail');
  detail.append(rivet);

  const base = model();
  base.box({ size: [1.0, 0.2, 0.8] });
  base.markSharp(sel.edges.dihedral('>', 45));
  base.uv.auto({ resolution: 128, respectSharp: true, padding: { mips: 2 } });
  return { base, detail };
}

function makeTexture(width: number, height: number, data: Uint8Array, srgb = false): TextureAsset {
  return {
    kind: 'texture',
    format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
    colorSpace: srgb ? 'srgb' : 'linear',
    shape: { viewDimension: '2d', extent: { width, height } },
    mips: { kind: 'none' },
    data,
  };
}

function maxChannelDelta(a: Uint8Array, b: Uint8Array): number {
  expect(a.length).toBe(b.length);
  let maxDelta = 0;
  for (let i = 0; i < a.length; i++) {
    maxDelta = Math.max(maxDelta, Math.abs((a[i] as number) - (b[i] as number)));
  }
  return maxDelta;
}

it('dilateAtlasWithGpu matches CPU dilateAtlas and reports zero protected bleed', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn must supply a WebGPU adapter');
  const device = await adapter.requestDevice();
  try {
    const size = 128;
    const texels = size * size;
    const owner = new Int32Array(texels).fill(-1);
    const mask = new Uint8Array(texels);
    const baseColor = new Uint8Array(texels * 4);
    const materialId = new Uint8Array(texels * 4);

    for (let y = 20; y < 108; y++) {
      for (let x = 10; x < 42; x++) {
        const i = y * size + x;
        mask[i] = 1;
        owner[i] = 1;
        baseColor.set([200, 100, 50, 255], i * 4);
        materialId.set([255, 0, 0, 255], i * 4);
      }
      for (let x = 86; x < 118; x++) {
        const i = y * size + x;
        mask[i] = 1;
        owner[i] = 2;
        baseColor.set([40, 160, 220, 255], i * 4);
        materialId.set([0, 255, 0, 255], i * 4);
      }
    }

    const opts = {
      textures: {
        baseColor: makeTexture(size, size, baseColor, true),
        materialId: makeTexture(size, size, materialId, true),
      },
      mask,
      owner,
      categorical: ['materialId'],
      gutter: 'fill' as const,
      protectMip: 2,
      mips: false,
    };
    const cpu = dilateAtlas(opts).unwrap();
    const gpu = (await dilateAtlasWithGpu(opts, device)).unwrap();

    expect(gpu.backend).toBe('webgpu');
    expect(gpu.bleed.pass).toBe(true);
    expect(gpu.bleed.protectedBleed).toBe(0);
    expect(gpu.bleed.levels.slice(0, opts.protectMip)).toEqual(
      cpu.bleed.levels.slice(0, opts.protectMip),
    );

    const gpuId = gpu.textures.materialId?.data as Uint8Array;
    for (let i = 0; i < texels; i++) {
      const r = gpuId[i * 4] as number;
      const g = gpuId[i * 4 + 1] as number;
      expect((r === 255 && g === 0) || (r === 0 && g === 255)).toBe(true);
    }
    expect(
      maxChannelDelta(
        gpu.textures.baseColor?.data as Uint8Array,
        cpu.textures.baseColor?.data as Uint8Array,
      ),
    ).toBeLessThanOrEqual(1);
  } finally {
    device.destroy();
  }
});

it('bakeCorrespondWithGpu + evaluateBakeMapsWithGpu matches bakeMapsWithGpu & CPU across iterative map edits and delivers 1024x1024 speedup', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn must supply a WebGPU adapter');
  const device = await adapter.requestDevice();
  try {
    const { base, detail } = makeHighLowScene(2, 24);
    const maps: readonly BakeMapKind[] = [
      'normal',
      'normalObject',
      'ao',
      'ormh',
      'baseColor',
      'emissive',
      'materialId',
      'edgeWear',
    ];
    const slots = {
      armor: { baseColor: [0.3, 0.35, 0.4, 1], roughness: 0.45, metallic: 0.8 },
      trim: {
        baseColor: [0.85, 0.5, 0.2, 1],
        roughness: 0.25,
        metallic: 0.9,
        emissive: [1, 0.4, 0.1],
        emissiveIntensity: 2,
      },
    } as const;

    // 1. Correctness parity check at 128x128
    const fused = (
      await bakeMapsWithGpu(
        {
          base,
          detail,
          resolution: 128,
          maps,
          tags: { floater: 'floater' },
          slots,
          ao: { rays: 16, denoise: 2 },
          edgeWear: { range: [0.1, 0.45], noise: { scale: 0.03, amount: 0.2, seed: 5 } },
          mips: false,
        },
        device,
      )
    ).unwrap();

    const cpu = bakeMaps({
      base,
      detail,
      resolution: 128,
      maps,
      tags: { floater: 'floater' },
      slots,
      ao: { rays: 16, denoise: 2 },
      edgeWear: { range: [0.1, 0.45], noise: { scale: 0.03, amount: 0.2, seed: 5 } },
      mips: false,
    }).unwrap();

    const corr = (
      await bakeCorrespondWithGpu(
        {
          base,
          detail,
          resolution: 128,
          tags: { floater: 'floater' },
        },
        device,
      )
    ).unwrap();
    expect(corr.covered).toBe(fused.provenance.covered);
    expect(corr.rayHits).toBe(fused.provenance.rayHits);

    const eval1 = (
      await evaluateBakeMapsWithGpu(
        corr,
        {
          maps,
          slots,
          ao: { rays: 16, denoise: 2 },
          edgeWear: { range: [0.1, 0.45], noise: { scale: 0.03, amount: 0.2, seed: 5 } },
          mips: false,
        },
        device,
      )
    ).unwrap();

    for (const kind of maps) {
      const f = fused.textures[kind]?.data as Uint8Array;
      const e = eval1.textures[kind]?.data as Uint8Array;
      const c = cpu.textures[kind]?.data as Uint8Array;
      expect(maxChannelDelta(e, f), `${kind} eval vs fused GPU`).toBeLessThanOrEqual(1);
      // Compare decoupled GPU parity with CPU at the same fused GPU baseline tolerance
      expect(maxChannelDelta(e, c), `${kind} eval vs CPU`).toBeLessThanOrEqual(
        Math.max(2, maxChannelDelta(f, c)),
      );
    }

    // Iterative re-eval without AO (zero BVH upload/traversal!) changing slots & edgeWear
    const slots2 = {
      ...slots,
      trim: { ...slots.trim, baseColor: [0.15, 0.85, 0.25, 1] as const },
    };
    const fused2 = (
      await bakeMapsWithGpu(
        {
          base,
          detail,
          resolution: 128,
          maps: ['baseColor', 'edgeWear', 'emissive'],
          tags: { floater: 'floater' },
          slots: slots2,
          edgeWear: { range: [0.05, 0.3], noise: { scale: 0.04, amount: 0.4, seed: 11 } },
          mips: false,
        },
        device,
      )
    ).unwrap();
    const eval2 = (
      await evaluateBakeMapsWithGpu(
        corr,
        {
          maps: ['baseColor', 'edgeWear', 'emissive'],
          slots: slots2,
          edgeWear: { range: [0.05, 0.3], noise: { scale: 0.04, amount: 0.4, seed: 11 } },
          mips: false,
        },
        device,
      )
    ).unwrap();
    for (const kind of ['baseColor', 'edgeWear', 'emissive'] as const) {
      expect(
        maxChannelDelta(
          eval2.textures[kind]?.data as Uint8Array,
          fused2.textures[kind]?.data as Uint8Array,
        ),
        `${kind} iterative eval`,
      ).toBe(0);
    }

    // 2. End-to-end bakeLowpolyWithGpu on mixed-role detail model
    const endToEnd = (
      await bakeLowpolyWithGpu(
        {
          detail,
          key: 'armor-plate',
          resolution: 128,
          maps: ['normal', 'ormh', 'baseColor', 'ao'],
          tags: { floater: 'floater' },
          lowpoly: { targetFaces: 120, hardAngle: 45 },
          ao: { rays: 8 },
          slots,
        },
        device,
      )
    ).unwrap();
    expect(endToEnd.pass, JSON.stringify(endToEnd.issues)).toBe(true);
    expect(endToEnd.mesh.kind).toBe('mesh');
    expect(endToEnd.textures.normal?.mips.kind).toBe('packed');

    // 3. 1024x1024 benchmark: fused vs decoupled correspondence + repeated look-dev evaluations
    const heavy = makeHighLowScene(4, 64);
    const benchMaps: readonly BakeMapKind[] = [
      'normal',
      'ormh',
      'baseColor',
      'emissive',
      'materialId',
      'edgeWear',
      'cavity',
    ];
    // Warmup pipelines
    await bakeMapsWithGpu(
      {
        base: heavy.base,
        detail: heavy.detail,
        resolution: 256,
        maps: benchMaps,
        slots,
        mips: false,
      },
      device,
    );

    const tFused0 = Date.now();
    await bakeMapsWithGpu(
      {
        base: heavy.base,
        detail: heavy.detail,
        resolution: 1024,
        maps: benchMaps,
        tags: { floater: 'floater' },
        slots,
        ao: { rays: 16, denoise: 2 },
        mips: false,
      },
      device,
    );
    const fusedMs = Date.now() - tFused0;

    const benchCorr = (
      await bakeCorrespondWithGpu(
        { base: heavy.base, detail: heavy.detail, resolution: 1024, tags: { floater: 'floater' } },
        device,
      )
    ).unwrap();

    await evaluateBakeMapsWithGpu(
      benchCorr,
      { maps: benchMaps, slots, ao: { rays: 16, denoise: 2 }, mips: false },
      device,
    );

    const tEvalNoAo0 = Date.now();
    await evaluateBakeMapsWithGpu(
      benchCorr,
      {
        maps: ['baseColor', 'emissive', 'edgeWear', 'cavity', 'normal'],
        slots: slots2,
        mips: false,
      },
      device,
    );
    const evalNoAoMs = Date.now() - tEvalNoAo0;
    expect(evalNoAoMs).toBeLessThan(fusedMs);
  } finally {
    device.destroy();
  }
}, 120_000);
