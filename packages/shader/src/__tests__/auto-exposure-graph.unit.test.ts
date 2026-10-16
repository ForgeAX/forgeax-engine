import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTO_EXPOSURE_METER_WGSL } from '../index';

const standaloneMeterSource = readFileSync(
  fileURLToPath(new URL('../auto-exposure-meter.wgsl', import.meta.url)),
  'utf8',
);

describe('auto exposure shader graph', () => {
  it('exposes one fixed-cohort WGSL module without compiler or Naga imports', () => {
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('@compute');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('@workgroup_size(256, 1, 1)');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain(
      'var<workgroup> localHistogram: array<atomic<u32>, 256>',
    );
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('atomicStore(&localHistogram[localIndex], 0u)');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('fn auto_exposure_clear');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('fn auto_exposure_histogram');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('fn auto_exposure_adapt');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('@builtin(num_workgroups) numWorkgroups');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('let blockStride = numWorkgroups.xy * tileSize');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('for (var blockY = blockStart.y;');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('for (var blockX = blockStart.x;');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('fn centerWeight');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('value == value');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain(
      'atomicAdd(&localHistogram[bin], centerWeight(block, center, extent))',
    );
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('atomicAdd(&histogram[localIndex], localCount)');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('parameters.compensationEv');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('parameters.rangeMinEv');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('parameters.upRate');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('parameters.deltaTime');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('validParameters');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('previous.x');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('state[0] = candidate[0]');
    expect(AUTO_EXPOSURE_METER_WGSL).not.toContain('fn auto_exposure_meter');
    expect(AUTO_EXPOSURE_METER_WGSL).not.toContain('sampleBins');
    expect(AUTO_EXPOSURE_METER_WGSL).not.toContain('shader-compiler');
    expect(AUTO_EXPOSURE_METER_WGSL).not.toContain('naga');
  });

  it('keeps the standalone source and runtime entrypoints single and aligned', () => {
    expect(standaloneMeterSource.match(/struct AutoExposureParameters/g)).toHaveLength(1);
    expect(standaloneMeterSource.match(/fn finite\(/g)).toHaveLength(1);
    expect(standaloneMeterSource.match(/@group\(0\) @binding\(0\)/g)).toHaveLength(1);
    expect(standaloneMeterSource).toContain('@compute @workgroup_size(256, 1, 1)');
    expect(standaloneMeterSource).toContain('fn auto_exposure_clear');
    expect(standaloneMeterSource).toContain('fn auto_exposure_histogram');
    expect(standaloneMeterSource).toContain('fn auto_exposure_adapt');
    expect(standaloneMeterSource).toContain('@builtin(num_workgroups) numWorkgroups');
    expect(standaloneMeterSource).toContain('let blockStride = numWorkgroups.xy * tileSize');
    expect(standaloneMeterSource).not.toContain('fn auto_exposure_meter');
    expect(standaloneMeterSource).not.toContain('@workgroup_size(16');
    expect(AUTO_EXPOSURE_METER_WGSL).toContain('fn auto_exposure_histogram');
  });
});
