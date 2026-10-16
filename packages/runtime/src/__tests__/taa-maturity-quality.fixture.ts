import { Camera } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { downsample, error, json, save, scene } from './taa-maturity.fixture';

export async function quality() {
  // Fixed before measuring: reject loss of thin-line energy, compare local edge
  // errors, and require stop recovery within a full jitter cycle (8 frames).
  const width = 256,
    height = 192;
  const high = await scene(width * 4, height * 4);
  let reference: Uint8Array;
  try {
    reference = downsample(await high.hdr(), width, height);
  } finally {
    await high.dispose();
  }
  save('spatial-reference.rgba', reference);
  const carrier = await scene(width, height);
  const { world, camera, moving } = carrier;
  const results: unknown[] = [];
  try {
    const none = await carrier.pixels();
    save('no-aa.rgba', none);
    // Local support includes both the line and two neighboring output pixels,
    // so blur/ghosting outside the reference silhouette remains measurable.
    const mask = Uint8Array.from({ length: width * height }, (_, i) => {
      const x = i % width,
        y = Math.floor(i / width);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const j =
            Math.max(0, Math.min(height - 1, y + dy)) * width +
            Math.max(0, Math.min(width - 1, x + dx));
          if (
            Math.max(reference[j * 4] ?? 0, reference[j * 4 + 1] ?? 0, reference[j * 4 + 2] ?? 0) >
            50
          )
            return 1;
        }
      return 0;
    });
    const localError = (a: Uint8Array, b: Uint8Array) => {
      let sum = 0,
        count = 0;
      for (let i = 0; i < mask.length; i++)
        if (mask[i])
          for (let c = 0; c < 3; c++) {
            sum += Math.abs((a[i * 4 + c] ?? 0) - (b[i * 4 + c] ?? 0)) / 255;
            count++;
          }
      return sum / count;
    };
    const sharpness = (p: Uint8Array) => {
      let sum = 0;
      for (let y = 1; y < height - 1; y++)
        for (let x = 1; x < width - 1; x++)
          for (let c = 0; c < 3; c++) {
            const i = (y * width + x) * 4 + c;
            if (mask[y * width + x])
              sum +=
                Math.abs((p[i + 4] ?? 0) - (p[i - 4] ?? 0)) +
                Math.abs((p[i + width * 4] ?? 0) - (p[i - width * 4] ?? 0));
          }
      return sum;
    };
    const noneError = localError(none, reference);
    for (const scale of [1, 0.5, 0.67, 0.75]) {
      carrier.mode(scale === 1 ? undefined : scale);
      for (let f = 0; f < 180; f++) await carrier.draw();
      const phases: Uint8Array[] = [];
      for (let f = 0; f < 8; f++) phases.push(await carrier.pixels());
      const image = phases[0];
      if (!image) throw new Error('missing TAA phases');
      save(`scale-${scale}.rgba`, image);
      const spatialError = { ...error(image, reference), localMean: localError(image, reference) };
      const sharpnessRatio = sharpness(image) / sharpness(reference);
      const flicker = Math.max(...phases.map((p) => localError(p, image)));
      const energy = (p: Uint8Array) =>
        p.reduce((sum, v, i) => sum + (i % 4 === 3 ? 0 : Math.max(0, v - 32)), 0);
      const energyRatio = energy(image) / energy(reference);
      results.push({
        scale,
        spatialError,
        noneError,
        flicker,
        energyRatio,
        sharpnessRatio,
        inspection: carrier.renderer.inspect().temporal,
      });
      json('quality-partial.json', { width, height, results });
      expect
        .soft(sharpnessRatio, 'retained line gradients, independent from total energy')
        .toBeGreaterThan(scale === 1 ? 0.65 : 0.35);
      expect.soft(energyRatio, 'subpixel detail energy must survive').toBeGreaterThan(0.7);
      expect.soft(energyRatio).toBeLessThan(1.3);
      expect.soft(flicker, 'phase-local flicker mean').toBeLessThan(0.01);
      if (scale === 1)
        expect(spatialError.localMean, 'native TAA must improve over aliased current').toBeLessThan(
          noneError,
        );
    }
    carrier.mode(undefined);
    // Object motion and stop: an analytic orthographic camera shift keeps all
    // sample identities fixed while the whole lattice moves by 0.6 output px.
    for (let f = 0; f < 60; f++) {
      world.set(camera, Transform, { pos: [(f * 0.6 * 4) / width, 0, 4] }).unwrap();
      await carrier.draw();
    }
    save('camera-motion.rgba', await carrier.pixels());
    world.set(camera, Transform, { pos: [0, 0, 4] }).unwrap();
    world.set(camera, Camera, { historyVersion: 10000 }).unwrap();
    const curve = [];
    for (let f = 0; f < 16; f++) {
      const image = await carrier.pixels();
      curve.push({
        frame: f + 1,
        error: { ...error(image, reference), localMean: localError(image, reference) },
      });
      if (f === 0 || f === 7 || f === 15) save(`cut-${f + 1}.rgba`, image);
    }
    expect(
      curve[7]?.error.localMean,
      'cut recovery must be no worse than no-AA after 8 completed frames',
    ).toBeLessThanOrEqual(noneError);
    // Occluder movement then stop, preserving scene ownership.
    const object = moving[17];
    if (object === undefined) throw new Error('missing mover');
    for (let f = 0; f < 60; f++) {
      world.set(object, Transform, { pos: [(f - 30) * 0.015, 0, 0.3] }).unwrap();
      await carrier.draw();
    }
    save('object-motion.rgba', await carrier.pixels());
    json('quality.json', {
      width,
      height,
      reference: '4x4 spatial no-AA linear-HDR integration, then Reinhard and sRGB OETF',
      thresholds: {
        energy: [0.7, 1.3],
        flickerLocalMean: 0.01,
        sharpness: { native: 0.65, reduced: 0.35 },
        cutFrames: 8,
      },
      results,
      cut: curve,
    });
  } finally {
    await carrier.dispose();
  }
}
