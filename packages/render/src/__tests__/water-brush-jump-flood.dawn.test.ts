import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import type { WaterBrushTerrainManifest } from '@forgeax/engine-water';
import { expect, it } from 'vitest';
import {
  executeWaterBrushJumpFlood,
  type WaterBrushJumpFloodExecution,
} from '../water-brush/jump-flood';

const UE_NEIGHBOR_OFFSETS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

function blurOracle(source: Float32Array, width: number, height: number): Float32Array {
  const output = new Float32Array(source.length);
  const f32 = Math.fround;
  const sample = (x: number, y: number) => {
    const x0 = Math.floor(x),
      y0 = Math.floor(y);
    const tx = f32(x - x0),
      ty = f32(y - y0);
    const at = (px: number, py: number, channel: number) =>
      requiredFixtureValue(
        source[
          (Math.max(0, Math.min(height - 1, py)) * width + Math.max(0, Math.min(width - 1, px))) *
            4 +
            channel
        ],
      );
    return [0, 1, 2, 3].map((channel) => {
      const top = f32(f32(at(x0, y0, channel) * f32(1 - tx)) + f32(at(x0 + 1, y0, channel) * tx));
      const bottom = f32(
        f32(at(x0, y0 + 1, channel) * f32(1 - tx)) + f32(at(x0 + 1, y0 + 1, channel) * tx),
      );
      return f32(f32(top * f32(1 - ty)) + f32(bottom * ty));
    });
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      if (requiredFixtureValue(source[index]) + requiredFixtureValue(source[index + 1]) === 0) {
        output.set(
          [
            requiredFixtureValue(source[index]),
            requiredFixtureValue(source[index + 1]),
            requiredFixtureValue(source[index + 2]),
            1 - requiredFixtureValue(source[index + 3]),
          ],
          index,
        );
        continue;
      }
      let sx = 0,
        sy = 0,
        count = 0;
      for (const [ox, oy] of UE_NEIGHBOR_OFFSETS) {
        const sampleX = f32(x + ox);
        const sampleY = f32(f32(y) + f32(f32(f32(oy) * height) / width));
        const neighbor = sample(sampleX, sampleY);
        if (requiredFixtureValue(neighbor[0]) + requiredFixtureValue(neighbor[1]) <= 0) continue;
        sx += requiredFixtureValue(neighbor[0]);
        sy += requiredFixtureValue(neighbor[1]);
        count++;
      }
      if (count > 0) {
        output[index] = sx / count;
        output[index + 1] = sy / count;
      } else {
        output[index] = 0;
        output[index + 1] = 0;
      }
      output[index + 2] = requiredFixtureValue(source[index + 2]);
      output[index + 3] = 1 - requiredFixtureValue(source[index + 3]);
    }
  return output;
}

function jfaOracle(
  source: Float32Array,
  width: number,
  height: number,
  step: number,
): Float32Array {
  const output = new Float32Array(source.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const uvx = (x + 0.5) / width,
        uvy = (y + 0.5) / height;
      let best = [0, 0, 0, 0],
        bestDistance = 1e30;
      if (!(source[index] === 0 && source[index + 1] === 0)) {
        best = Array.from(source.slice(index, index + 4));
        bestDistance = Math.hypot(
          uvx - requiredFixtureValue(best[0]),
          uvy - requiredFixtureValue(best[1]),
        );
      }
      for (const [ox, oy] of UE_NEIGHBOR_OFFSETS) {
        const cx = x + ox * step,
          cy = y + oy * step;
        if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
        const candidate = (cy * width + cx) * 4;
        const candidateUvX = (cx + 0.5) / width,
          candidateUvY = (cy + 0.5) / height;
        if (
          (source[candidate] <= 0 && source[candidate + 1] <= 0) ||
          candidateUvX <= 0 ||
          candidateUvX >= 1 ||
          candidateUvY <= 0 ||
          candidateUvY >= 1
        )
          continue;
        const distance = Math.hypot(
          uvx - requiredFixtureValue(source[candidate]),
          uvy - requiredFixtureValue(source[candidate + 1]),
        );
        if (distance < bestDistance) {
          best = Array.from(source.slice(candidate, candidate + 4));
          bestDistance = distance;
        }
      }
      output.set(
        [
          requiredFixtureValue(best[0]),
          requiredFixtureValue(best[1]),
          requiredFixtureValue(best[2]),
          1 - requiredFixtureValue(source[index + 3]),
        ],
        index,
      );
    }
  return output;
}

it.each([
  {
    widthPx: 7,
    heightPx: 5,
    blurPassCount: 0,
    cachePassIndex: 4,
    executedFinalTarget: 'jump-flood-b' as const,
    cacheSelectedTarget: 'jump-flood-a' as const,
  },
  {
    widthPx: 7,
    heightPx: 7,
    blurPassCount: 9,
    cachePassIndex: 13,
    executedFinalTarget: 'jump-flood-a' as const,
    cacheSelectedTarget: 'jump-flood-b' as const,
  },
  {
    widthPx: 12,
    heightPx: 5,
    blurPassCount: 9,
    cachePassIndex: 14,
    executedFinalTarget: 'jump-flood-b' as const,
    cacheSelectedTarget: 'jump-flood-a' as const,
  },
])('executes Blur/JFA passes and preserves raw-radius cache target parity ($widthPx x $heightPx, $blurPassCount blur passes)', async ({
  widthPx,
  heightPx,
  blurPassCount,
  cachePassIndex,
  executedFinalTarget,
  cacheSelectedTarget,
}) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const native = device.nativeDevice().unwrap();
  const validationErrors: string[] = [];
  native.addEventListener('uncapturederror', (event) => validationErrors.push(event.error.message));
  native.pushErrorScope('validation');
  const passCount = Math.ceil(Math.log2(Math.max(widthPx, heightPx)));
  const jfaStepOffsets = Array.from(
    { length: passCount },
    (_, index) => 2 ** (passCount - index - 1),
  );
  const seed = device
    .createTexture({
      label: 'water-brush-jfa-test-seed',
      size: [widthPx, heightPx, 1],
      format: 'rgba32float',
      usage: 0x01 | 0x02 | 0x04,
      textureBindingViewDimension: '2d',
    })
    .unwrap();
  const paddedRowBytes = 256;
  const writeJumpFloodTestSeeds = () => {
    const seedBytes = new Uint8Array(paddedRowBytes * heightPx);
    const seedView = new DataView(seedBytes.buffer);
    const seeds = [
      { x: 1, y: 2, marker: 11 },
      { x: widthPx - 1, y: 2, marker: 22 },
    ];
    for (let y = 0; y < heightPx; y++)
      for (let x = 0; x < widthPx; x++) {
        const offset = y * paddedRowBytes + x * 16;
        seedView.setFloat32(offset + 12, xMask(x, widthPx), true);
      }
    for (const source of seeds) {
      const offset = source.y * paddedRowBytes + source.x * 16;
      seedView.setFloat32(offset, (source.x + 0.5) / widthPx, true);
      seedView.setFloat32(offset + 4, (source.y + 0.5) / heightPx, true);
      seedView.setFloat32(offset + 8, source.marker, true);
    }
    device.queue
      .writeTexture(
        { texture: seed, mipLevel: 0 },
        seedBytes,
        { offset: 0, bytesPerRow: paddedRowBytes, rowsPerImage: heightPx },
        [widthPx, heightPx, 1],
      )
      .unwrap();
    return seeds;
  };
  const seeds = writeJumpFloodTestSeeds();
  const manifest = {
    textures: [
      { name: 'actor:test-body:jump-flood-a', widthPx, heightPx, format: 'rgba32float' },
      { name: 'actor:test-body:jump-flood-b', widthPx, heightPx, format: 'rgba32float' },
    ],
    actorPassPlan: [
      {
        actorId: 'test-body',
        blurPassCount,
        jumpFloodPassCount: jfaStepOffsets.length,
        jfaStepOffsets,
        jumpFloodExecutedFinalTarget: executedFinalTarget,
        jumpFloodCacheSelectedTarget: cacheSelectedTarget,
        jumpFloodCachePassIndex: cachePassIndex,
        jumpFloodCacheParity: cachePassIndex % 2,
      },
    ],
  } as unknown as WaterBrushTerrainManifest;
  let output: WaterBrushJumpFloodExecution | undefined;
  try {
    const result = await executeWaterBrushJumpFlood(
      device,
      (code, label) => createShaderModule(device, { code, label }),
      seed,
      manifest,
      'test-body',
    );
    if (!result.ok) throw result.error;
    expect(result.ok).toBe(true);
    output = result.value;
    expect(output.executedStepOffsets).toEqual(jfaStepOffsets);
    expect(output.executedBlurPassCount).toBe(blurPassCount);
    expect(output.executedFinalTarget).toBe(executedFinalTarget);
    expect(output.cacheSelectedTarget).toBe(cacheSelectedTarget);
    expect(output.cacheReadback).toBe(output.readbacksByTarget[cacheSelectedTarget]);
    expect(output.readback).toBe(output.readbacksByTarget[executedFinalTarget]);
    expect(output.readbacksByTarget[cacheSelectedTarget].values).toHaveLength(
      widthPx * heightPx * 4,
    );
    expect(output.readback).toMatchObject({
      widthPx,
      heightPx,
      format: 'rgba32float',
      bytesPerRow: 256,
      rowBytes: widthPx * 16,
    });
    expect(output.fenceCompleted).toBe(true);
    expect(output.readback.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(output.readback.paddedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(output.readback.paddedBytes).toHaveLength(256 * heightPx);
    expect(output.readback.values).toHaveLength(widthPx * heightPx * 4);
    const assertJumpFloodOracleReadbacks = (output: WaterBrushJumpFloodExecution) => {
      let oracleA = new Float32Array(widthPx * heightPx * 4);
      let oracleB = new Float32Array(widthPx * heightPx * 4);
      for (let y = 0; y < heightPx; y++)
        for (let x = 0; x < widthPx; x++) oracleA[(y * widthPx + x) * 4 + 3] = xMask(x, widthPx);
      for (const source of seeds) {
        const index = (source.y * widthPx + source.x) * 4;
        oracleA.set(
          [
            (source.x + 0.5) / widthPx,
            (source.y + 0.5) / heightPx,
            source.marker,
            xMask(source.x, widthPx),
          ],
          index,
        );
      }
      let oracleSource: 'jump-flood-a' | 'jump-flood-b' = 'jump-flood-a';
      for (let index = 0; index < blurPassCount; index++) {
        const target = oracleSource === 'jump-flood-a' ? 'jump-flood-b' : 'jump-flood-a';
        const result = blurOracle(target === 'jump-flood-a' ? oracleB : oracleA, widthPx, heightPx);
        if (target === 'jump-flood-a') oracleA = result;
        else oracleB = result;
        oracleSource = target;
      }
      for (const step of jfaStepOffsets) {
        const target = oracleSource === 'jump-flood-a' ? 'jump-flood-b' : 'jump-flood-a';
        const result = jfaOracle(
          target === 'jump-flood-a' ? oracleB : oracleA,
          widthPx,
          heightPx,
          step,
        );
        if (target === 'jump-flood-a') oracleA = result;
        else oracleB = result;
        oracleSource = target;
      }
      for (const [target, expected] of [
        ['jump-flood-a', oracleA],
        ['jump-flood-b', oracleB],
      ] as const) {
        const actual = output.readbacksByTarget[target].values;
        for (let index = 0; index < actual.length; index++)
          expect(
            actual[index],
            `${target} channel ${index} (pixel ${Math.floor(index / 4) % widthPx}, ${Math.floor(index / 4 / widthPx)}, component ${index % 4}; expected ${expected[index]}, received ${actual[index]})`,
          ).toBeCloseTo(requiredFixtureValue(expected[index]), 5);
      }
    };
    assertJumpFloodOracleReadbacks(output);
    if (cacheSelectedTarget !== executedFinalTarget)
      expect(output.cacheReadback.sha256).not.toBe(output.readback.sha256);
    for (let index = 0; index < widthPx * heightPx; index++) {
      const x = index % widthPx;
      const y = Math.floor(index / widthPx);
      const uv = [(x + 0.5) / widthPx, (y + 0.5) / heightPx];
      const distances = seeds.map((source) =>
        Math.hypot(
          requiredFixtureValue(uv[0]) - (source.x + 0.5) / widthPx,
          requiredFixtureValue(uv[1]) - (source.y + 0.5) / heightPx,
        ),
      );
      const minimum = Math.min(...distances);
      const result = output.readback.values.slice(index * 4, index * 4 + 4);
      if (blurPassCount > 0) {
        expect(result.every(Number.isFinite)).toBe(true);
        continue;
      }
      const marker = result[2];
      expect([11, 22]).toContain(marker);
      const selected = requiredFixtureValue(seeds.find((source) => source.marker === marker));
      expect(
        Math.hypot(
          requiredFixtureValue(uv[0]) - (selected.x + 0.5) / widthPx,
          requiredFixtureValue(uv[1]) - (selected.y + 0.5) / heightPx,
        ),
      ).toBeCloseTo(minimum, 6);
      const insideMask = xMask(x, widthPx) ^ ((blurPassCount + jfaStepOffsets.length) % 2);
      expect(result[0]).toBeCloseTo((selected.x + 0.5) / widthPx, 6);
      expect(result[1]).toBeCloseTo((selected.y + 0.5) / heightPx, 6);
      expect(result[2]).toBe(selected.marker);
      expect(result[3]).toBe(insideMask);
      const signedDistanceUv = minimum * (1 - 2 * requiredFixtureValue(result[3]));
      expect(Math.abs(signedDistanceUv)).toBeCloseTo(minimum, 6);
    }
    expect(await native.popErrorScope()).toBeNull();
    expect(validationErrors).toEqual([]);
  } finally {
    output?.destroy();
    device.destroyTexture(seed);
    native.destroy();
  }
});

function xMask(x: number, width: number): number {
  return x <= Math.floor(width / 2) ? 1 : 0;
}

it('clears both JFA targets and returns the raw-radius-selected B target when a 1x1 actor has no JFA passes', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const native = device.nativeDevice().unwrap();
  native.pushErrorScope('validation');
  const seed = device
    .createTexture({
      label: 'water-brush-jfa-single-seed',
      size: [1, 1, 1],
      format: 'rgba32float',
      usage: 0x01 | 0x02 | 0x04,
      textureBindingViewDimension: '2d',
    })
    .unwrap();
  const seedBytes = new Uint8Array(256);
  new DataView(seedBytes.buffer).setFloat32(0, 0.5, true);
  new DataView(seedBytes.buffer).setFloat32(4, 0.5, true);
  new DataView(seedBytes.buffer).setFloat32(8, 17, true);
  new DataView(seedBytes.buffer).setFloat32(12, 1, true);
  device.queue
    .writeTexture(
      { texture: seed, mipLevel: 0 },
      seedBytes,
      { offset: 0, bytesPerRow: 256, rowsPerImage: 1 },
      [1, 1, 1],
    )
    .unwrap();
  const manifest = {
    textures: [
      { name: 'actor:single:jump-flood-a', widthPx: 1, heightPx: 1, format: 'rgba32float' },
      { name: 'actor:single:jump-flood-b', widthPx: 1, heightPx: 1, format: 'rgba32float' },
    ],
    actorPassPlan: [
      {
        actorId: 'single',
        blurPassCount: 0,
        jumpFloodPassCount: 0,
        jfaStepOffsets: [],
        jumpFloodExecutedFinalTarget: 'jump-flood-a',
        jumpFloodCacheSelectedTarget: 'jump-flood-b',
        jumpFloodCachePassIndex: 1,
        jumpFloodCacheParity: 1,
      },
    ],
  } as unknown as WaterBrushTerrainManifest;
  let output: WaterBrushJumpFloodExecution | undefined;
  try {
    const result = await executeWaterBrushJumpFlood(
      device,
      (code, label) => createShaderModule(device, { code, label }),
      seed,
      manifest,
      'single',
    );
    if (!result.ok) throw result.error;
    output = result.value;
    expect(output.executedPassCount).toBe(0);
    expect(output.executedFinalTarget).toBe('jump-flood-a');
    expect(output.cacheSelectedTarget).toBe('jump-flood-b');
    expect([...output.readbacksByTarget['jump-flood-a'].values]).toEqual([0.5, 0.5, 17, 1]);
    expect([...output.readbacksByTarget['jump-flood-b'].values]).toEqual([0, 0, 0, 0]);
    expect(output.cacheReadback.sha256).not.toBe(output.readback.sha256);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    output?.destroy();
    device.destroyTexture(seed);
    native.destroy();
  }
});

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Required native fixture value is absent');
  return value;
}
