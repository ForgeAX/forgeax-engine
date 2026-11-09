import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { tsrFeedback as createFeedback } from './tsr-feedback';
import { verifyTsrGeometry } from './tsr-geometry.fixture';

export function registerTsrFeedbackCases(
  backend: Pick<typeof webgpu, 'rhi' | 'createShaderModuleImmediate'> = webgpu,
  execution: 'compute' | 'raster' = 'compute',
) {
  const { rhi, createShaderModuleImmediate } = backend;
  const tsrFeedback = (...args: Parameters<typeof createFeedback>) =>
    createFeedback(args[0], args[1], args[2], args[3], args[4], execution, args[6]);
  it('preserves coverage halos at f32 phase boundaries in non-power-of-two extents', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    await verifyTsrGeometry(
      device,
      (d) => createShaderModuleImmediate(device, d),
      'rounding',
      execution,
    );
  });

  it('preserves two-dimensional geometry identity, rejection and edge support in partial groups', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    await verifyTsrGeometry(
      device,
      (d) => createShaderModuleImmediate(device, d),
      'partial',
      execution,
    );
  });

  it('reconstructs rejected input below output resolution instead of nearest-texel blocks', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    try {
      const frame = rig.draw([1, 0, 0, 1, 0, 0, 1, 1]);
      const pixels = await rig.read(frame.color);
      expect(pixels[4]).toBeGreaterThan(0.5);
      expect(pixels[4]).toBeLessThan(1);
      expect(pixels[6]).toBeGreaterThan(0);
      expect(pixels[6]).toBeLessThan(0.5);
      expect(pixels[7]).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('retains linear HDR and alpha, grows support, and rejects depth, material and secondary changes', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    const white = [4, 2, 1, 0.5, 4, 2, 1, 0.5],
      black = [0, 0, 0, 0.5, 0, 0, 0, 0.5];
    try {
      let frame = rig.draw(white);
      for (let i = 1; i < 60; i++) frame = rig.draw(white);
      expect((await rig.read(frame.color)).slice(0, 4)).toEqual([4, 2, 1, 0.5]);
      expect((await rig.read(frame.metadata, 1))[0]).toBeGreaterThan(0.4);
      for (const options of [
        { depth: 3 },
        { reactive: 1 },
        { reactive: 2 },
        { secondary: 1 },
        { motion: 2 },
        { reset: true },
      ]) {
        for (let i = 0; i < 16; i++) rig.draw(white);
        frame = rig.draw(black, options);
        const values = await rig.read(frame.color);
        expect(values.filter((_, i) => i % 4 !== 3).every((v) => v === 0)).toBe(true);
        expect(values[3]).toBe(0.5);
        expect((await rig.read(frame.metadata, 1))[0]).toBeLessThan(0.04);
      }
    } finally {
      rig.dispose();
    }
  });

  it('consumes unfilterable R32F secondary reactivity without float32-filterable', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice({ requiredFeatures: [] })).unwrap();
    const rig = tsrFeedback(
      device,
      (d) => createShaderModuleImmediate(device, d),
      2,
      4,
      'compact',
      execution,
      'r32float',
    );
    const white = [4, 2, 1, 0.5, 4, 2, 1, 0.5],
      black = [0, 0, 0, 0.5, 0, 0, 0, 0.5];
    try {
      let frame = rig.draw(white);
      for (let i = 1; i < 60; i++) frame = rig.draw(white);
      expect((await rig.read(frame.metadata))[0]).toBeGreaterThan(0.4);
      frame = rig.draw(black, { secondary: 1 });
      expect((await rig.read(frame.color)).slice(0, 4)).toEqual([0, 0, 0, 0.5]);
      expect((await rig.read(frame.metadata))[0]).toBeLessThan(0.04);
    } finally {
      rig.dispose();
    }
  });

  it('settles a persistent unmarked HDR shading change within one jitter cycle', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    try {
      for (let i = 0; i < 60; i++) rig.draw([100, 100, 100, 1, 100, 100, 100, 1]);
      let frame = rig.draw([200, 200, 200, 1, 200, 200, 200, 1]);
      for (let i = 1; i < 8; i++) frame = rig.draw([200, 200, 200, 1, 200, 200, 200, 1]);
      expect((await rig.read(frame.color))[0]).toBeGreaterThan(198);
    } finally {
      rig.dispose();
    }
  });

  it('reduces bounded stationary oscillation and never relaxes marked animation or post-opaque changes', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const normal = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    const disabled = tsrFeedback(device, (d) =>
      createShaderModuleImmediate(device, {
        ...d,
        code: d.code.replace(/let relaxation = select\([^;]+;/, 'let relaxation = 0.0;'),
      }),
    );
    const tail: number[] = [],
      control: number[] = [];
    const pixels = (v: number) => [v, v, v, 1, v, v, v, 1];
    try {
      for (let i = 0; i < 96; i++) {
        const input = pixels(i % 2 === 0 ? 0.8 : 1.2);
        const a = normal.draw(input),
          b = disabled.draw(input);
        if (i >= 80) {
          tail.push((await normal.read(a.color))[0] ?? NaN);
          control.push((await disabled.read(b.color))[0] ?? NaN);
        }
      }
      const variance = (a: number[]) => {
        const mean = a.reduce((s, v) => s + v, 0) / a.length;
        return a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length;
      };
      // Freeze a 25% reduction before observing the implementation result.
      expect(variance(tail)).toBeLessThan(variance(control) * 0.75);
      for (const options of [{ reactive: 1 }, { reactive: 2 }, { opaquePixels: pixels(0) }]) {
        let frame = normal.draw(pixels(0.8), options);
        for (let i = 1; i < 16; i++) frame = normal.draw(pixels(i % 2 === 0 ? 0.8 : 1.2), options);
        expect((await normal.read(frame.moire))[3]).toBe(0);
      }
      const changed = normal.draw(pixels(0), { reactive: 1 });
      expect((await normal.read(changed.color)).slice(0, 3)).toEqual([0, 0, 0]);
    } finally {
      normal.dispose();
      disabled.dispose();
    }
  });

  it('bounds compact-history error against the same GPU algorithm with FP16 analysis and support', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const compile = (d: Parameters<typeof createShaderModuleImmediate>[1]) =>
      createShaderModuleImmediate(device, d);
    const compact = tsrFeedback(device, compile),
      reference = tsrFeedback(device, compile, 2, 4, 'fp16');
    const errors: number[] = [],
      sample = (v: number) => [v, v * 0.75, v * 0.25, 0.5, v, v * 0.75, v * 0.25, 0.5];
    try {
      for (let i = 0; i < 160; i++) {
        const input = sample(i < 128 ? (i % 2 === 0 ? 0.8 : 1.2) : 100);
        const a = compact.draw(input),
          b = reference.draw(input);
        if (i >= 96) {
          const av = await compact.read(a.color),
            bv = await reference.read(b.color);
          for (let lane = 0; lane < 3; lane++)
            errors.push(
              Math.abs((av[lane] ?? NaN) - (bv[lane] ?? NaN)) / Math.max(1, bv[lane] ?? 1),
            );
          expect(av[3]).toBe(0.5);
          expect(bv[3]).toBe(0.5);
        }
      }
      // Compression may change local rejection, but cannot bias this frozen
      // oscillation/HDR transition sequence by more than 2% on average.
      expect(errors.reduce((s, v) => s + v, 0) / errors.length).toBeLessThan(0.02);
      expect(Math.max(...errors)).toBeLessThan(0.08);
    } finally {
      compact.dispose();
      reference.dispose();
    }
  });

  it('expires oscillation relaxation within eight successful frames, including low frame rates', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    const pixels = (v: number) => [v, v, v, 1, v, v, v, 1];
    try {
      for (const hz of [60, 20]) {
        const options = { deltaSeconds: 1 / hz };
        // Uneven plateaus exercise direction retention, rather than a two-level toggle only.
        for (let i = 0; i < 96; i++) rig.draw(pixels([0.8, 0.8, 1.2, 1.0][i % 4] ?? 1), options);
        let frame = rig.draw(pixels(4), options);
        for (let i = 1; i < 8; i++) frame = rig.draw(pixels(4), options);
        expect(Math.floor((await rig.read(frame.moire))[3] ?? NaN)).toBe(0);
        expect((await rig.read(frame.color))[0]).toBeGreaterThan(3.96);
        // Motion invalidates confidence immediately, even if color continues oscillating.
        frame = rig.draw(pixels(0.8), { ...options, motion: 0.25 });
        expect((await rig.read(frame.moire))[3]).toBe(0);
      }
    } finally {
      rig.dispose();
    }
  });

  it('pulls moving history with the Engine motion sign and falsifies the opposite sign', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const normal = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d), 8, 8);
    const wrong = tsrFeedback(
      device,
      (d) =>
        createShaderModuleImmediate(device, {
          ...d,
          code: d.code.replaceAll(
            'let previousUv = uv - temporal.motionUv;',
            'let previousUv = uv + temporal.motionUv;',
          ),
        }),
      8,
      8,
    );
    const pattern = (shift: number) =>
      Array.from({ length: 8 }, (_, i) => {
        const v = (i - shift + 80) % 8 < 3 ? 1 : 0;
        return [v, v, v, 1];
      }).flat();
    try {
      for (let i = 0; i < 48; i++) {
        normal.draw(pattern(0));
        wrong.draw(pattern(0));
      }
      const input = pattern(1);
      const a = await normal.read(normal.draw(input, { motion: 1 / 8 }).color);
      const b = await wrong.read(wrong.draw(input, { motion: 1 / 8 }).color);
      const error = (values: number[]) =>
        values.reduce((sum, v, i) => sum + (i % 4 === 3 ? 0 : Math.abs(v - (input[i] ?? 0))), 0) /
        24;
      expect(error(a)).toBeLessThan(0.01);
      expect(error(b)).toBeGreaterThan(0.02);
    } finally {
      normal.dispose();
      wrong.dispose();
    }
  });
  it('covers partial workgroups and the uncached tiny-DRS coverage footprint without losing validity', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d), 9, 31);
    const pixels = Array.from({ length: 9 }, () => [4, 2, 1, 0.5]).flat();
    try {
      let frame = rig.draw(pixels, { coverageReactive: 0 });
      for (let i = 1; i < 60; i++) frame = rig.draw(pixels, { coverageReactive: 0 });
      const color = await rig.read(frame.color);
      for (let i = 0; i < 31; i++) expect(color.slice(i * 4, i * 4 + 4)).toEqual([4, 2, 1, 0.5]);
      expect(
        (await rig.read(frame.metadata, 1)).filter((_, i) => i % 4 === 0).every((v) => v > 0.4),
      ).toBe(true);
      frame = rig.draw(pixels, { coverageReactive: 2 });
      expect(
        (await rig.read(frame.metadata, 1)).filter((_, i) => i % 4 === 0).every((v) => v < 0.04),
      ).toBe(true);
    } finally {
      rig.dispose();
    }
  });
}
