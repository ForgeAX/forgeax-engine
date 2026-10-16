import { parseGlb, parseGltf } from '@forgeax/engine/gltf';
import { defineFeature } from '../../lab/feature';
import { buildGlb, cubeGltf } from './fixtures/gltf-source';
import { errorCode } from './fixtures/memory-pack';

export default defineFeature({
  title: 'glTF/GLB parse',
  catalog: 'glTF/GLB parse',
  kind: 'headless',
  summary:
    'parseGltf and parseGlb are pure functions over an in-code cube: external buffers only arrive through the injected loader, and no World, fetch or GPU resource is involved.',
  expect:
    'The data-URI .gltf, the external-buffer .gltf and the assembled GLB all yield the same 24-vertex / 36-index Box mesh with the Red material; GLB v1, asset 1.0 and unknown required extensions fail with structured codes.',
  async run(checks) {
    const loads: string[] = [];
    const embedded = cubeGltf();
    const fromJson = await parseGltf(
      embedded.json,
      (uri) => {
        loads.push(uri);
        return Promise.reject(new Error('unexpected'));
      },
      'cube.gltf',
    );
    checks.ok('parseGltf ok', fromJson.ok, fromJson.ok ? undefined : fromJson.error.code);
    checks.equal('data URI never reaches the loader', loads, []);
    const mesh = fromJson.ok ? fromJson.value.meshes[0] : undefined;
    checks.equal('24 positions', mesh?.positions.length, 72);
    checks.equal('36 indices', mesh?.indices?.length, 36);
    checks.equal(
      'Red material',
      fromJson.ok ? fromJson.value.materials[0]?.name : undefined,
      'Red',
    );
    checks.equal('Box node', fromJson.ok ? fromJson.value.nodes[0]?.name : undefined, 'Box');

    const external = cubeGltf({ glb: true });
    const externalJson = {
      ...external.json,
      buffers: [{ byteLength: external.bin.byteLength, uri: 'cube.bin' }],
    };
    const fromExternal = await parseGltf(
      externalJson,
      (uri) => {
        loads.push(uri);
        return Promise.resolve(external.bin.slice().buffer);
      },
      'cube.gltf',
    );
    checks.equal('external buffer resolved only via the injected loader', loads, ['cube.bin']);
    checks.equal(
      'external-buffer positions match',
      fromExternal.ok ? Array.from(fromExternal.value.meshes[0]?.positions ?? []) : undefined,
      Array.from(mesh?.positions ?? []),
    );

    const fromGlb = await parseGlb(buildGlb(external.json, external.bin), 'cube.glb');
    checks.ok('parseGlb ok', fromGlb.ok, fromGlb.ok ? undefined : fromGlb.error.code);
    checks.equal(
      'GLB positions match',
      fromGlb.ok ? Array.from(fromGlb.value.meshes[0]?.positions ?? []) : undefined,
      Array.from(mesh?.positions ?? []),
    );
    checks.equal(
      'GLB indices match',
      fromGlb.ok ? Array.from(fromGlb.value.meshes[0]?.indices ?? []) : undefined,
      Array.from(mesh?.indices ?? []),
    );

    const glbV1 = await parseGlb(buildGlb(external.json, external.bin, 1), 'old.glb');
    checks.equal(
      'GLB version 1 rejected',
      glbV1.ok ? 'ok' : errorCode(glbV1.error),
      'gltf-version-unsupported',
    );
    const asset1 = await parseGltf(
      { ...embedded.json, asset: { version: '1.0' } },
      () => Promise.reject(new Error('x')),
      'old.gltf',
    );
    checks.equal(
      'asset.version 1.0 rejected',
      asset1.ok ? 'ok' : errorCode(asset1.error),
      'gltf-version-unsupported',
    );
    const required = await parseGltf(
      { ...embedded.json, extensionsUsed: ['VENDOR_magic'], extensionsRequired: ['VENDOR_magic'] },
      () => Promise.reject(new Error('x')),
      'ext.gltf',
    );
    checks.equal(
      'unknown required extension rejected',
      required.ok ? 'ok' : errorCode(required.error),
      'gltf-extension-unsupported',
    );
  },
});
