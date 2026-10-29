import { describe, expect, it } from 'vitest';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { ViewLights } from '../../world/render-lights';
import { createShadowUpdatePolicy, shadowUpdatePolicy } from '../shadow-update-policy';

describe('recording-owned shadow policies', () => {
  it('shares directional policies across cascades and layers, and observes the next recording', () => {
    const config = { shadowRevision: 1, shadowRadius: 2 };
    const lights = {
      directional: { entity: 7, worldId: 0 },
      directionalCsmConfig: config,
      pointShadow: [],
      spot: [],
    } as unknown as ViewLights;
    const worlds = [{} as RenderResourceScope];
    const identity = { kind: 'directional', index: 0 } as const;
    const read = createShadowUpdatePolicy(lights, worlds, 1024, 512, () => undefined);
    const first = read(identity);
    expect(first).toEqual(shadowUpdatePolicy(identity, lights, worlds, 1024, 512, undefined));
    expect(read({ kind: 'directional', index: 3, layer: 'static' })).toBe(first);
    config.shadowRevision = 2;
    const next = createShadowUpdatePolicy(lights, worlds, 2048, 512, () => undefined)(identity);
    expect(next?.revision.revision).toBe(2);
    expect(next?.viewport).toEqual([2048, 2048]);
    expect(first?.revision.revision).toBe(1);
  });

  it('keeps distinct light indices and kinds and retains missing-policy results', () => {
    const lights = {
      directional: undefined,
      directionalCsmConfig: undefined,
      pointShadow: [{ shadowAtlasLayer: 1, worldId: 0, entity: 9, shadowRevision: 3 }],
      spot: [{ shadowAtlasTile: 1, worldId: 0, entity: 10, shadowRevision: 4 }],
    } as unknown as ViewLights;
    const read = createShadowUpdatePolicy(
      lights,
      [{} as RenderResourceScope],
      1024,
      512,
      () => undefined,
    );
    const point = read({ kind: 'point', index: 1, face: 0 });
    expect(read({ kind: 'point', index: 1, face: 5, layer: 'static' })).toBe(point);
    expect(read({ kind: 'spot', index: 1 })?.revision.entity).toBe(10);
    expect(point?.revision.entity).toBe(9);
    expect(read({ kind: 'point', index: 2 })).toBeUndefined();
    expect(read({ kind: 'directional', index: 0 })).toBeUndefined();
  });
});
