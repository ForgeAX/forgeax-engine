import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAsset } from '../../../../packages/wgpu-wasm/scripts/content-key.mjs';

export function nativeFingerprint(manifest) {
  const { schemaVersion, sourceContentKey, artifactSha256, glueSha256, toolchain, dependencies } =
    manifest;
  return `sha256-${createHash('sha256').update(JSON.stringify({ schemaVersion, sourceContentKey, artifactSha256, glueSha256, toolchain, dependencies })).digest('hex')}`;
}

export async function nativeBundle(f, directory, label) {
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const wasm = `${label} native`;
  const glue = `${label} glue`;
  const manifest = {
    schemaVersion: 'wgpu-wasm-provenance/1',
    sourceContentKey: `sha256-${(await resolveAsset()).sha256}`,
    artifactSha256: hash(wasm),
    artifactBytes: Buffer.byteLength(wasm),
    glueSha256: hash(glue),
    glueBytes: Buffer.byteLength(glue),
    toolchain: {},
    dependencies: {},
  };
  manifest.compilerFingerprint = nativeFingerprint(manifest);
  rmSync(directory, { recursive: true, force: true });
  f.write(join(directory, 'wgpu_wasm_bg.wasm'), wasm);
  f.write(join(directory, 'wgpu_wasm.js'), glue);
  f.write(join(directory, 'package.json'), '{"type":"module"}');
  f.write(join(directory, 'provenance.json'), JSON.stringify(manifest));
}
