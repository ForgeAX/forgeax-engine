import { expect, it } from 'vitest';
import type { PreparedScreenProbe } from '../../raytracing/renderer-screen-probe';
import { screenProbeGraphShape } from '../../raytracing/screen-probe-graph';

it('invalidates a retained screen graph when its diffuse feedback order changes', () => {
  // Isolate topology identity from device/generation retirement. The actual
  // runtime scene test owns the light transport and GPU presentation evidence.
  const prepared = {
    generation: 1,
    profile: { field: { radiosity: true }, probes: { filterPasses: 2 } },
    extent: () => ({ layout: { width: 96, height: 64 } }),
    field: {
      generation: 1,
      composeRequired: () => false,
      canonical: { required: () => false },
      capture: () => false,
      cards: { capture: { revision: 1, bufferReads: [], textureReads: [] }, textureRevision: 1 },
      extent: () => ({ width: 96, height: 64 }),
    },
  } as unknown as PreparedScreenProbe;
  const unchanged = screenProbeGraphShape(prepared);
  expect(screenProbeGraphShape(prepared)).toEqual(unchanged);
  const singleBounce = {
    ...prepared,
    profile: { ...prepared.profile, field: { ...prepared.profile.field, radiosity: false } },
  };
  expect(screenProbeGraphShape(singleBounce)).not.toEqual(unchanged);
  const split = { ...prepared, roots: [] as unknown as NonNullable<PreparedScreenProbe['roots']> };
  expect(screenProbeGraphShape(split)).not.toEqual(unchanged);
});
