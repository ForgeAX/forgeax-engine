import { expect, it, vi } from 'vitest';
import { shareArtifactBodies } from '../dev/artifact-bodies.js';
import type { HttpArtifact } from '../http-artifact.js';

vi.mock('node:crypto', () => ({
  createHash: () => ({
    update() {
      return this;
    },
    digest() {
      return 'forced-collision';
    },
  }),
}));

it('checks colliding bytes and MIME, prefers the smallest existing backing and scopes sharing to one publication', () => {
  const backing = new Uint8Array(8192);
  backing.set([1, 2, 3], 17);
  const partial = backing.subarray(17, 20);
  const exact = new Uint8Array([1, 2, 3]);
  const unequal = new Uint8Array([1, 2, 9]);
  const otherMime = new Uint8Array([1, 2, 3]);
  const bodies = new Map<string, HttpArtifact>([
    ['authored', { bytes: partial, mimeType: 'text/wgsl' }],
    ['restored', { bytes: exact, mimeType: 'text/wgsl' }],
    ['collision', { bytes: unequal, mimeType: 'text/wgsl' }],
    ['other-mime', { bytes: otherMime, mimeType: 'text/plain' }],
  ]);
  shareArtifactBodies(bodies);
  expect(bodies.get('authored')?.bytes).toBe(exact);
  expect(bodies.get('restored')?.bytes).toBe(exact);
  expect(bodies.get('authored')?.bytes.buffer.byteLength).toBe(3);
  expect(bodies.get('collision')?.bytes).toBe(unequal);
  expect(bodies.get('other-mime')?.bytes).toBe(otherMime);
  expect([...bodies.keys()]).toEqual(['authored', 'restored', 'collision', 'other-mime']);
  const next = new Uint8Array([1, 2, 3]);
  const nextBodies = new Map([['next', { bytes: next, mimeType: 'text/wgsl' }]]);
  shareArtifactBodies(nextBodies);
  expect(nextBodies.get('next')?.bytes).toBe(next);
  expect(partial).toEqual(new Uint8Array([1, 2, 3]));
});
