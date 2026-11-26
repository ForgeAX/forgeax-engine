import { it } from 'vitest';
import { verifyManagedMeshRange } from './managed-mesh-range.gpu-fixture';

it.each(['vertices', 'indices'] as const)(
  'renders accepted %s ranges while a shared asset and fixed candidate retain their old pixels',
  verifyManagedMeshRange,
);

it.each([
  'vertices',
  'indices',
] as const)('keeps split static residency exact during leased and in-place %s edits', (channel) =>
  verifyManagedMeshRange(channel, true));

it.each([
  'vertices',
  'indices',
] as const)('preserves the authored split streams and fixed pixels across %s edits', (channel) =>
  verifyManagedMeshRange(channel, true, true));
