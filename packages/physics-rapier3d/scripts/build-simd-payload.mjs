import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { assertPortableRustArtifact, portableRustFlags } from '../../../scripts/lib/rust-build-paths.mjs';

/** Publish a browser-only transport; the native Host retains its scalar payload. */
export async function buildSimdPayload({ root, work, bindings, staged, cache, run }) {
  const manifestPath = join(bindings, 'builds/rapier3d/Cargo.toml');
  const manifest = await readFile(manifestPath, 'utf8');
  if (manifest.split("'--dce',").length !== 2)
    throw new Error('Rapier wasm-opt profile changed; requalify SIMD production');
  const wasm = join(work, 'wasm-simd');
  const target = join(resolve(process.env.CARGO_TARGET_DIR ?? join(cache, 'target')), '3d-simd');
  try {
    await writeFile(manifestPath, manifest.replace("'--dce',", "'--dce',\n    '--enable-simd',"));
    run(
      'wasm-pack',
      ['build', '--target', 'web', '--release', '--out-dir', wasm, '--', '--locked'],
      join(bindings, 'builds/rapier3d'),
      {
        CARGO_ENCODED_RUSTFLAGS:
          portableRustFlags(resolve(root, '../..'), { ...process.env, CARGO_TARGET_DIR: target }) +
          '\x1f-C\x1ftarget-feature=+simd128',
        CARGO_TARGET_DIR: target,
        CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '4',
      },
    );
  } finally {
    await writeFile(manifestPath, manifest);
  }
  const bytes = await readFile(join(wasm, 'rapier_wasm3d_bg.wasm'));
  assertPortableRustArtifact(bytes);
  // Keep the exact generated ABI paired with its own binary; do not patch or
  // borrow the scalar glue even when wasm-bindgen currently emits equal exports.
  const js = join(work, 'js-simd');
  await cp(join(work, 'js'), js, { recursive: true });
  for (const name of ['rapier_wasm3d.js', 'rapier_wasm3d.d.ts', 'rapier_wasm3d_bg.wasm'])
    await cp(join(wasm, name), join(js, name));
  await build({
    entryPoints: [join(js, 'rapier.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    outfile: join(staged, 'rapier-simd.mjs'),
    loader: { '.wasm': 'binary' },
    legalComments: 'eof',
    minify: true,
  });
  await writeFile(
    join(staged, 'rapier-simd.d.mts'),
    "export { default } from './rapier.mjs';\nexport * from './rapier.mjs';\n",
  );
}
