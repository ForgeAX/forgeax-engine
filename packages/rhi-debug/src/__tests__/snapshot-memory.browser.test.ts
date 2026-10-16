import { it } from 'vitest';
import { verifyCancelledSnapshotHash, verifySnapshotMemory } from './snapshot-memory.fixture';

it(
  'bounds texture snapshot staging and replays complete array/mip seeds',
  verifySnapshotMemory,
  120000,
);

it(
  'does not publish a cancelled snapshot after its native digest completes',
  verifyCancelledSnapshotHash,
);
