import type { GraphBuffer } from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import { shadowViewLabelPrefix, shadowViewRasterAccesses } from '../gpu-driven/shadow-views';
import type { GpuDrivenViewGraphResources } from '../gpu-driven/view-gpu';

describe('GPU-driven shadow views Browser ownership contract', () => {
  it('keeps Browser coverage independent from adapter acquisition', () => {
    expect([
      shadowViewLabelPrefix({ kind: 'directional', index: 1 }),
      shadowViewLabelPrefix({ kind: 'point', index: 2, face: 5 }),
      shadowViewLabelPrefix({ kind: 'spot', index: 3 }),
    ]).toEqual([
      'gpu-driven.shadow.directional-cascade-1',
      'gpu-driven.shadow.point-cube-face-2-5',
      'gpu-driven.shadow.spot-atlas-3',
    ]);
  });

  it('publishes one graph access contract for each shared shadow view output', () => {
    const resources = {
      primitive: {} as GraphBuffer,
      instance: {} as GraphBuffer,
      transform: {} as GraphBuffer,
      material: {} as GraphBuffer,
      visible: {} as GraphBuffer,
      indirect: {} as GraphBuffer,
      overflow: {} as GraphBuffer,
    } satisfies GpuDrivenViewGraphResources;
    expect(shadowViewRasterAccesses(resources)).toEqual([
      { resource: resources.primitive, usage: 'storage-read' },
      { resource: resources.instance, usage: 'storage-read' },
      { resource: resources.transform, usage: 'storage-read' },
      { resource: resources.material, usage: 'storage-read' },
      { resource: resources.visible, usage: 'storage-read' },
      { resource: resources.indirect, usage: 'indirect-read' },
    ]);
  });

  it('keeps the view-local ABI limited to storage and indirect reads', () => {
    const resources = {
      primitive: {} as GraphBuffer,
      instance: {} as GraphBuffer,
      transform: {} as GraphBuffer,
      material: {} as GraphBuffer,
      visible: {} as GraphBuffer,
      indirect: {} as GraphBuffer,
      overflow: {} as GraphBuffer,
    } satisfies GpuDrivenViewGraphResources;
    const accesses = shadowViewRasterAccesses(resources);
    expect(
      accesses.every(
        (access) => access.usage === 'storage-read' || access.usage === 'indirect-read',
      ),
    ).toBe(true);
    expect(
      accesses.every((access) =>
        (Object.values(resources) as readonly GraphBuffer[]).includes(
          access.resource as GraphBuffer,
        ),
      ),
    ).toBe(true);
  });
});
