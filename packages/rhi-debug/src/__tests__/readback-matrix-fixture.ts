import type { BootstrapResource, Tape } from '../protocol/types';

export const READBACK_MATRIX_CASES = [
  { format: 'rgba8unorm', dimension: '2d', aspect: 'all' },
  { format: 'depth32float', dimension: '2d', aspect: 'depth-only' },
  { format: 'depth24plus', dimension: '2d', aspect: 'depth-only' },
  { format: 'depth24plus-stencil8', dimension: '2d', aspect: 'stencil-only' },
  { format: 'rgba8unorm', dimension: '2d-array', aspect: 'all' },
  { format: 'rgba8unorm', dimension: 'cube', aspect: 'all' },
  { format: 'rgba8unorm', dimension: 'cube-array', aspect: 'all' },
] as const;

export function makeReadbackMatrixTape(resources: readonly BootstrapResource[]): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: resources,
    events: [],
    blobs: [],
  };
}
