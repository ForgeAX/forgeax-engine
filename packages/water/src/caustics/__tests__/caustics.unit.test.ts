import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WATER_CAUSTICS_FIELD,
  WATER_CAUSTICS_REACTIVITY_OUTPUT,
  waterCausticsFieldPass,
  waterCausticsFieldResource,
} from '../field.js';
import { createWaterCausticsReceiverFeature } from '../receiver.js';
import { waterCausticsReceiverValues } from '../settings.js';

describe('Water caustics contracts', () => {
  it('keeps relative and light-scaled fields explicit across different scene budgets', () => {
    const pool = {
      name: 'pool-field',
      resolution: 1024,
      sourceGrid: 512,
      encoding: 'relative-irradiance' as const,
    };
    const standard = waterCausticsFieldResource(DEFAULT_WATER_CAUSTICS_FIELD);
    const custom = waterCausticsFieldResource(pool);
    expect(standard).toMatchObject({ descriptor: { format: 'rgba16float', size: { width: 512 } } });
    expect(custom).toMatchObject({ name: 'pool-field', descriptor: { size: { width: 1024 } } });
    const pass = waterCausticsFieldPass({
      field: pool,
      name: 'project',
      program: 'projector',
      bindings: ['surface'],
    });
    expect(pass).toMatchObject({ draws: [{ draw: { vertexCount: 1_572_864 } }] });
    expect(DEFAULT_WATER_CAUSTICS_FIELD.encoding).toBe('light-scaled-irradiance');
  });

  it('clears disabled production instead of leaving the previous field visible', () => {
    const pass = waterCausticsFieldPass({
      field: DEFAULT_WATER_CAUSTICS_FIELD,
      name: 'clear',
      program: 'unused',
      bindings: [],
      mode: 'off',
    });
    expect(pass).toMatchObject({
      colorAttachments: [{ loadOp: 'clear', storeOp: 'store' }],
      draws: [],
    });
  });

  it('packs receiving units without losing typed light inputs or field encoding', () => {
    const light = new Float32Array([-0.45, -0.8, -0.3]);
    const settings = { incidentDirection: light, lightIntensity: 2.6, referencePlaneY: -4.5 };
    const values = waterCausticsReceiverValues(settings);
    expect(values).toHaveLength(16);
    expect(values.slice(0, 8)).toEqual([2, 0.35, 1, 0.25, 0.25, 40, 6, 6]);
    expect(values.slice(8, 11)).toEqual(Array.from(light));
    expect(values.slice(11)).toEqual([2.6, -4.5, 0, 0, 0]);
    expect(
      waterCausticsReceiverValues({
        ...settings,
        encoding: 'relative-irradiance',
        visibilityDiagnostic: true,
      }).slice(14),
    ).toEqual([1, 1]);
    expect(WATER_CAUSTICS_REACTIVITY_OUTPUT.writeMask).toBe(8);
    expect(WATER_CAUSTICS_REACTIVITY_OUTPUT.blend.alpha.operation).toBe('max');
  });
});

describe('Water receiver submitted clock', () => {
  it('changes only after an actual submission and keeps frozen light inputs settled', () => {
    let timeSeconds = 3;
    let gain = 0.35;
    const receiver = createWaterCausticsReceiverFeature({
      producerIdentity: 'test-caustics',
      field: 'test-field',
      shaders: { composite: '', copy: '' },
    });
    receiver.configure(() => ({
      mode: 'texture',
      timeSeconds,
      gain,
      incidentDirection: [0, -1, 0],
      lightIntensity: 1,
      referencePlaneY: -4,
    }));
    const extract = () => {
      const frame = receiver.feature.extract({} as never).unwrap();
      if (frame === undefined) throw new Error('Expected configured receiver frame');
      return frame;
    };
    const submitted = receiver.feature.onFrameSubmitted;
    if (submitted === undefined) throw new Error('Expected receiver submission callback');
    const first = extract();
    submitted(first, {} as never);
    expect(extract().slice(16)).toEqual([3, 0, 0, 0]);
    timeSeconds = 4;
    expect(extract().slice(16)).toEqual([3, 1, 0, 0]);
    submitted(extract(), undefined);
    expect(extract().slice(16)).toEqual([3, 1, 0, 0]);
    submitted(extract(), {} as never);
    gain = 0.7;
    expect(extract().slice(16)).toEqual([4, 0, 1, 0]);
  });
});
