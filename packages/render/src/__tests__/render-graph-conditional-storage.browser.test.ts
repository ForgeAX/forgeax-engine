import { expect, it } from 'vitest';
import { conditionalStorageEvidence } from './render-graph-conditional-storage-gpu.js';

it('retains conditional graph storage and resets it on graph rebuild', async () => {
  expect(await conditionalStorageEvidence()).toEqual([0, 42, 42, 0]);
});
