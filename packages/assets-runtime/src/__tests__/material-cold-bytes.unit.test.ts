import { setImmediate } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import * as zlib from 'node:zlib';
import { MaterialArtifactRegistry, ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { createMaterialLoader } from '../material/loader.js';
import { installMaterialReadyShaders } from '../material/runtime-shader.js';
import { decodeArtifactTransport, finishArtifactBytes } from '../registry/artifact-io.js';
import { materialRecordFixture } from './fixtures/material-publication.js';

const { zstdCompressSync } = zlib as typeof zlib & {
  zstdCompressSync(bytes: Uint8Array): Uint8Array;
};
setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;

async function admitted() {
  const record = materialRecordFixture({
    guid: '019f0000-0000-7000-8000-000000008301',
    passes: [{ name: 'Forward', program: { module: `game::cold${'c'.repeat(60000)}` } }],
  });
  const program = record.programs[0];
  if (program === undefined) throw Error('Missing program');
  const body = program.artifact.bytes;
  const group = new Uint8Array(body.length + 37);
  group.set(body, 19);
  const request = {
    packageUrl: 'https://example.invalid/a.pack.json',
    guid: record.guid,
    artifactKey: program.artifact.path,
    descriptor: {
      path: 'programs.zst',
      mediaType: 'text/wgsl',
      contentEncoding: 'zstd' as const,
      byteRange: { offset: 0, length: 1, bundleDigest: `sha256:${'0'.repeat(64)}` },
      byteLength: body.length,
      decodedRange: { offset: 19, length: body.length },
      integrity: { algorithm: 'sha256' as const, digest: program.artifact.digest },
    },
  };
  const decoded = await decodeArtifactTransport(zstdCompressSync(group), request);
  if (!decoded.ok) throw Error(decoded.error.code);
  const member = await finishArtifactBytes(decoded.value, request);
  if (!member.ok) throw Error(JSON.stringify(member.error));
  const bytes = member.value;
  const ready = await createMaterialLoader({
    loadPublication: async () => ({
      guid: record.guid,
      record: { ...record, programs: [{ ...program, artifact: { ...program.artifact, bytes } }] },
      artifacts: { [program.artifact.path]: { bytes, digest: program.artifact.digest } },
    }),
  }).load({ guid: record.guid, specializationKey: record.specializationKey });
  if (ready.status !== 'Ready') throw Error(ready.error.code);
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  const artifacts = new MaterialArtifactRegistry();
  installMaterialReadyShaders(shaders, ready, artifacts);
  const artifact = artifacts.get(program.specializationKey);
  if (artifact === undefined) throw Error('Missing installed artifact');
  return {
    shaders,
    artifacts,
    key: program.specializationKey,
    weak: new WeakRef(artifact.bytes),
    weakGroup: new WeakRef(decoded.value),
    expected: new TextDecoder().decode(body),
    length: body.length,
  };
}

it('retires cold decoded groups and private program bytes while keeping both live registries usable', async () => {
  const held = await admitted();
  expect(held.artifacts.storageStats()).toMatchObject({
    artifacts: 1,
    compressedArtifacts: 1,
    compressedGroups: 1,
    ordinaryBytes: 0,
    logicalBytes: held.length,
  });
  expect(held.artifacts.storageStats().compressedBytes).toBeLessThan(held.length);
  // WeakRef keep-alive lasts until the current job ends.
  for (let i = 0; i < 8; i++) {
    await setImmediate();
    collect();
  }
  expect(held.weakGroup.deref() === undefined).toBe(true);
  expect(held.weak.deref() === undefined).toBe(true);
  expect(held.artifacts.inspect(held.key)?.byteLength).toBe(held.length);
  await setImmediate();
  collect();
  expect(held.weak.deref() === undefined).toBe(true);
  const artifact = held.artifacts.get(held.key);
  if (artifact === undefined) throw Error('Missing retained artifact');
  const restored = artifact.bytes;
  expect(new TextDecoder().decode(restored)).toBe(held.expected);
  expect(held.artifacts.get(held.key)?.bytes).toBe(restored);
  const fork = held.shaders.forkForDevice({
    createShaderModule() {
      throw Error('CPU only');
    },
  });
  fork.installMaterialArtifactsFrom(held.shaders);
  expect(fork.findMaterialArtifact(held.key).unwrap().program).toBe(
    held.shaders.findMaterialArtifact(held.key).unwrap().program,
  );
});
