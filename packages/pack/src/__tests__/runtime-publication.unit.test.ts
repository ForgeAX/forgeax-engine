import { expect, it } from 'vitest';
import {
  bindRuntimePackScope,
  createRuntimePackPublication,
  stripRuntimePackLifecycle,
} from '../runtime-publication.js';

it('preserves existing publication digests and generations in a realm-neutral producer', () => {
  const { pack } = createRuntimePackPublication({
    pack: {
      assets: [
        {
          guid: '01900000-0000-7000-8000-000000000033',
          kind: 'audio',
          payload: { kind: 'audio', bytes: new Uint8Array([0, 1, 127, 128, 255]) },
        },
      ],
    },
    scopeId: 'fixture',
    sourcePath: 'audio.pack.ts',
    sourceRevision: 'original-source',
    packageUrl: '/audio.pack.json',
  });
  expect(pack).toMatchObject({
    digest: 'sha256:793aefb52c4bff61113150318f1af86443838554cceac47db0b48b5b248ffc76',
    outputSetDigest: 'sha256:68f5462a52c36a3f7707758df1efb1e97b839cd12e4935cd646806dab9ffe582',
    generation: 3028532604,
  });
});

it('preserves declared source keys in derived publication rows and their digest', () => {
  const input = {
    pack: {
      assets: [
        { guid: 'WALL-GUID', kind: 'volume', payload: {} },
        { guid: 'CONTROL-GUID', kind: 'mesh', payload: {} },
      ],
    },
    scopeId: 'lab',
    sourcePath: 'wall.pack.json',
    sourceRevision: 'source-1',
    packageUrl: '/wall.pack.json',
  };
  const before = createRuntimePackPublication(input);
  const after = createRuntimePackPublication({
    ...input,
    sourceKeys: new Map([['wall-guid', 'wall/main']]),
  });
  expect(after.publication.outputs.map(({ guid, sourceKey }) => [guid, sourceKey])).toEqual([
    ['wall-guid', 'wall/main'],
    ['control-guid', 'control-guid'],
  ]);
  expect(after.pack.digest).toBe(before.pack.digest);
  expect(after.pack.outputSetDigest).not.toBe(before.pack.outputSetDigest);
  expect(after.publication.receipt.outputSetDigest).toBe(after.pack.outputSetDigest);
  // Explicit producer output rows remain authoritative when provided.
  const explicit = createRuntimePackPublication({
    ...input,
    sourceKeys: new Map([['wall-guid', 'ignored']]),
    outputs: after.publication.outputs,
  });
  expect(explicit.publication.outputs).toEqual(after.publication.outputs);
});

it('separates immutable Pack content from the runtime publication tuple', () => {
  const publication = createRuntimePackPublication({
    pack: { assets: [{ guid: 'MESH-GUID', kind: 'mesh', payload: { vertexCount: 3 } }] },
    scopeId: 'old-scope',
    sourcePath: 'mesh.pack.ts',
    sourceRevision: 'source-1',
    packageUrl: '/mesh.pack.json',
  });
  const semantic = stripRuntimePackLifecycle(publication.pack) as Record<string, unknown>;
  expect(semantic).not.toHaveProperty('scopeId');
  expect(semantic).not.toHaveProperty('generation');
  expect(bindRuntimePackScope(semantic, 'new-scope', 23)).toMatchObject({
    scopeId: 'new-scope',
    generation: 23,
    digest: publication.pack.digest,
  });
  expect(bindRuntimePackScope(publication.pack, 'new-scope', 23)).toMatchObject({
    scopeId: 'new-scope',
    generation: 23,
  });
});
