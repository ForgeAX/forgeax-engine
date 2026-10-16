import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
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

describe('Standard Cluster capability admission', () => {
  it('keeps the same requested/admitted corpus across proven storage lanes', () => {
    const cpu = prepared(33);
    const compute = selectStandardClusterTransport(
      { compute: true, storageBuffer: true, membershipPipelineReady: true },
      cpu,
    );
    const storage = selectStandardClusterTransport(
      { compute: false, storageBuffer: true, membershipPipelineReady: false },
      cpu,
    );
    expect(compute.ok && storage.ok).toBe(true);
    if (!compute.ok || !storage.ok) return;
    expect(compute.value.requestedLightCount).toBe(33);
    expect(storage.value.requestedLightCount).toBe(33);
    expect(compute.value.admittedLightCount).toBe(storage.value.admittedLightCount);
    expect(compute.value.membershipEntryCount).toBe(storage.value.membershipEntryCount);
    expect(compute.value.lightBoundsBytes).toBe(storage.value.lightBoundsBytes);
  });

  it('never advertises a four-light fallback for WebGL2-like capabilities', () => {
    const result = selectStandardClusterTransport(
      { compute: false, storageBuffer: false, membershipPipelineReady: false },
      prepared(33),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.code !== 'standard-cluster-transport-unavailable') return;
    expect(result.error.detail).toEqual({ requested: 33, admitted: 0 });
    expect(JSON.stringify(result.error)).not.toContain('four');
  });
});
