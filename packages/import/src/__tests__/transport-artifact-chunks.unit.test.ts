import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import type { ArtifactDescriptor } from '@forgeax/engine-types';
import { expect, it } from 'vitest';

function defined<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

import { chunkMeshArtifacts, meshChunkingRequested } from '../transport-artifact-chunks';

const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function fixture(count = 200) {
  const artifacts = Array.from({ length: count }, (_, index) => ({
    path: `shared/${index}.bin`,
    bytes: new Uint8Array(1000 + index).fill(index % 256),
  }));
  const pack = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: artifacts.map((a, index) => ({
      guid: `mesh-${index}`,
      kind: 'mesh',
      payload: { kind: 'mesh' },
      refs: [],
      artifacts: {
        body: {
          path: a.path,
          mediaType: 'application/x-forgeax-mesh',
          contentEncoding: 'identity',
          byteLength: a.bytes.byteLength,
          integrity: { algorithm: 'sha256', digest: hash(a.bytes) },
          assetCodec: { name: 'mesh-binary', version: '5' },
        },
      },
    })),
  };
  return { artifacts, pack };
}

it('uses source order for bounded chunks and restores each exact independent artifact without changing their logical descriptors', async () => {
  const f = fixture(),
    original = JSON.stringify(f.pack),
    order = f.pack.assets.map((a) => a.guid).reverse();
  const projected = chunkMeshArtifacts(f.pack, f.artifacts, order);
  const pack = projected.pack as {
    assets: { guid: string; artifacts: { body: ArtifactDescriptor } }[];
  };
  expect(JSON.stringify(f.pack)).toBe(original);
  expect(projected.artifacts.length).toBeLessThan(f.artifacts.length / 10);
  expect(projected.artifacts.every((a) => a.bytes.byteLength <= 64 * 1024)).toBe(true);
  expect(pack.assets.map((a) => a.guid)).toEqual(f.pack.assets.map((a) => a.guid));
  const bodies = new Map(projected.artifacts.map((a) => [a.path, a.bytes]));
  for (const guid of order) {
    const asset = defined(pack.assets.find((a) => a.guid === guid));
    const descriptor = asset.artifacts.body;
    const container = defined(bodies.get(descriptor.path));
    const range = defined(descriptor.byteRange);
    expect(hash(container)).toBe(range.containerDigest);
    const bytes = container.slice(range.offset, range.offset + range.length);
    const before = defined(f.artifacts[f.pack.assets.findIndex((a) => a.guid === guid)]);
    expect(bytes).toEqual(before.bytes);
    expect(descriptor.integrity).toEqual(
      defined(f.pack.assets.find((a) => a.guid === guid)).artifacts.body.integrity,
    );
    bytes.fill(99);
    expect(hash(container)).toBe(range.containerDigest);
  }
});

it('keeps large, streaming and non-mesh artifacts loose, and avoids undersized groups', () => {
  const f = fixture(3);
  expect(chunkMeshArtifacts(f.pack, f.artifacts).pack).toBe(f.pack);
  const other = fixture(10);
  defined(other.pack.assets[0]).kind = 'texture';
  defined(other.artifacts[1]).bytes = new Uint8Array(9000);
  const result = chunkMeshArtifacts(other.pack, other.artifacts);
  expect(result.artifacts.some((a) => a.path === defined(other.artifacts[0]).path)).toBe(true);
  expect(result.artifacts.some((a) => a.path === defined(other.artifacts[1]).path)).toBe(true);
});

it('does not remove a loose body still referenced by an unbundled asset', () => {
  const f = fixture(10);
  defined(f.pack.assets[0]).kind = 'texture';
  defined(f.pack.assets[1]).artifacts.body = { ...defined(f.pack.assets[0]).artifacts.body };
  const result = chunkMeshArtifacts(f.pack, f.artifacts);
  expect(result.artifacts.some((a) => a.path === defined(f.artifacts[0]).path)).toBe(true);
});

it('scopes chunking to measured source families without enabling unrelated loading paths', () => {
  const source = 'assets/maps/dust2/mesh-01.pack.ts';
  expect(meshChunkingRequested(undefined, source)).toBe(false);
  expect(meshChunkingRequested('0', source)).toBe(false);
  expect(meshChunkingRequested('', source)).toBe(false);
  expect(meshChunkingRequested('1', source)).toBe(true);
  expect(meshChunkingRequested('assets/maps/dust2/', source)).toBe(true);
  expect(meshChunkingRequested('assets/maps/dust2/', 'assets/equipment.pack.ts')).toBe(false);
  expect(meshChunkingRequested('assets/maps/dust2/', undefined)).toBe(false);
  expect(
    meshChunkingRequested('./assets/maps/dust2/', 'assets\\maps\\dust2\\mesh-01.pack.ts'),
  ).toBe(true);
});
