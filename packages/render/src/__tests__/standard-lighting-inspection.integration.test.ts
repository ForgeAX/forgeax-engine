import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import {
  inspectStandardClusterTransport,
  inspectStandardLighting,
} from '../pipeline/standard-lighting/inspection';
import {
  prepareStandardLighting,
  type StandardLightFrame,
} from '../pipeline/standard-lighting/prepare';
import { selectStandardClusterTransport } from '../pipeline/standard-lighting/transport';

function prepared(localCount: number) {
  const frame: StandardLightFrame = {
    directional: undefined,
    local: Array.from({ length: localCount }, (_, index) => ({
      kind: index % 2 === 0 ? ('point' as const) : ('spot' as const),
      shadowed: false,
      position: vec3.create((index % 4) - 1.5, 0, -4 - (index % 8)),
      range: 2,
    })),
    view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
    projection: mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100),
    near: 0.1,
    far: 100,
    grid: { x: 4, y: 3, z: 4 },
    lightCount: 256,
    renderPath: 'forward',
  };
  const result = prepareStandardLighting(frame);
  if (!result.ok) throw result.error;
  return result.value;
}

describe('Standard lighting inspection provenance', () => {
  it('reports facts from the selected prepared transport, not a profile constant', () => {
    const preparedFrame = prepared(33);
    const selected = selectStandardClusterTransport(
      { compute: false, storageBuffer: true, membershipPipelineReady: false },
      preparedFrame,
    );
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    expect(inspectStandardClusterTransport(selected.value, preparedFrame)).toEqual({
      renderPath: 'forward',
      transport: 'cpu-storage',
      producer: 'cpu',
      requested: 33,
      admitted: 33,
      shadowed: 0,
      maxLights: 256,
      indexCount: preparedFrame.membershipEntryCount,
      occupied: selected.value.occupiedClusterCount,
      clusterGridBytes: preparedFrame.layout.clusterGridU32Length * 4,
      lightIndexListBytes: preparedFrame.membershipEntryCount * 4,
      lightDataBytes: 33 * 96,
      lightBoundsBytes: preparedFrame.lightBounds.byteLength,
      grid: preparedFrame.layout.grid,
    });
  });

  it('publishes an explicit not-required inspection for a successful zero-local frame', () => {
    const result = prepareStandardLighting({
      directional: undefined,
      local: [],
      view: mat4.create(),
      projection: mat4.create(),
      near: 0.1,
      far: 100,
      grid: { x: 4, y: 3, z: 4 },
      lightCount: 1,
      renderPath: 'forward',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inspection = inspectStandardLighting({ kind: 'no-local-lights', prepared: result.value });
    expect(inspection).toEqual({
      renderPath: 'forward',
      transport: 'not-required',
      producer: 'none',
      requested: 0,
      admitted: 0,
      shadowed: 0,
      maxLights: 1,
      indexCount: 0,
      occupied: 0,
      clusterGridBytes: 0,
      lightIndexListBytes: 0,
      lightDataBytes: 0,
      lightBoundsBytes: 0,
      grid: result.value.layout.grid,
    });
  });

  it('preserves deferred path, shadow admission, and profile light budget', () => {
    const frame: StandardLightFrame = {
      directional: undefined,
      local: [
        {
          kind: 'point',
          shadowed: true,
          position: vec3.create(0, 0, -4),
          range: 2,
        },
      ],
      view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
      projection: mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100),
      near: 0.1,
      far: 100,
      grid: { x: 4, y: 3, z: 4 },
      lightCount: 32,
      renderPath: 'deferred',
    };
    const preparedFrame = prepareStandardLighting(frame);
    expect(preparedFrame.ok).toBe(true);
    if (!preparedFrame.ok) return;
    const selected = selectStandardClusterTransport(
      { compute: true, storageBuffer: true, membershipPipelineReady: true },
      preparedFrame.value,
    );
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(
      inspectStandardLighting({
        kind: 'clustered',
        prepared: preparedFrame.value,
        transport: selected.value,
      }),
    ).toMatchObject({
      renderPath: 'deferred',
      transport: 'compute-storage',
      producer: 'gpu',
      shadowed: 1,
      maxLights: 32,
    });
  });
});
