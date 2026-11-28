import { expect, it } from 'vitest';
import { type BakeOptions, bakeMaps, bakeMapsWithGpu } from '../bake';
import { model } from '../model';
import { sel } from '../selectors';

it('bakes AO and chart-filtered textures on WebGPU with the CPU sampling and audit contract', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn must supply a WebGPU adapter');
  const device = await adapter.requestDevice();
  try {
    const base = model();
    base.plane({ width: 1, height: 1, widthSegments: 2, heightSegments: 2 });
    base.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    const detail = model();
    detail.plane({ width: 1, height: 1 });
    const obstacle = model();
    obstacle.box({ size: [0.2, 0.8, 0.18] });
    obstacle.translate(sel.all(), [0, 0, 0.09]);
    detail.append(obstacle);
    const options = {
      base,
      detail,
      maps: ['ao', 'normal', 'cavity'],
      resolution: 64,
      mips: false,
      cage: { offset: 0.2, maxRay: 0.3 },
      ao: { rays: 8, distance: 0.26, denoise: 2 },
    } satisfies BakeOptions;
    const cpu = bakeMaps(options).unwrap();
    const gpu = (await bakeMapsWithGpu(options, device)).unwrap();
    expect(gpu.report.backendIdentity).toContain('/webgpu-correspond-jfa/1');
    expect(gpu.provenance.rayHits).toBe(cpu.provenance.rayHits);
    expect(gpu.provenance.bleed).toEqual(cpu.provenance.bleed);
    expect(cpu.textures.ao?.data.some((value, i) => i % 4 === 0 && value < 245)).toBe(true);
    for (const map of options.maps) {
      const reference = cpu.textures[map]?.data;
      const actual = gpu.textures[map]?.data;
      if (!reference || !actual) throw new Error(`Missing map ${map}`);
      expect(actual.length).toBe(reference.length);
      let maxDelta = 0;
      for (let i = 0; i < actual.length; i++)
        maxDelta = Math.max(maxDelta, Math.abs((actual[i] as number) - (reference[i] as number)));
      expect(maxDelta, map).toBeLessThanOrEqual(2);
    }
  } finally {
    device.destroy();
  }
});
