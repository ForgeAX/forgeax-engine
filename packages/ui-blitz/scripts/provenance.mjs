import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PKG_ROOT, resolveAsset, sha256 } from './content-key.mjs';

export const OUTPUTS = [
  'ui_blitz_bg.wasm',
  'ui_blitz_bg.wasm.d.ts',
  'ui_blitz.js',
  'ui_blitz.d.ts',
  'ui-native.mjs',
  'ui-native.d.mts',
];

export async function outputFacts(pkgDirectory) {
  return Object.fromEntries(
    await Promise.all(
      OUTPUTS.map(async (name) => {
        const bytes = await readFile(join(pkgDirectory, name));
        return [name, { bytes: bytes.length, sha256: sha256(bytes) }];
      }),
    ),
  );
}

/** Installed consumers can verify the generated closure without Rust sources. */
export async function verifyArtifactProvenance({ pkgDirectory = join(PKG_ROOT, 'pkg') } = {}) {
  const manifest = JSON.parse(await readFile(join(pkgDirectory, 'provenance.json'), 'utf8'));
  if (manifest.schema !== 'forgeax-ui-blitz/2') throw new Error('Unsupported UI provenance schema');
  if (manifest.sourceDigest !== sha256(JSON.stringify(manifest.inputs)))
    throw new Error('UI source fingerprint differs from its inputs');
  const actual = await outputFacts(pkgDirectory);
  if (JSON.stringify(Object.keys(manifest.outputs).sort()) !== JSON.stringify([...OUTPUTS].sort()))
    throw new Error('UI output inventory is incomplete');
  for (const name of OUTPUTS) {
    if (
      manifest.outputs[name].bytes !== actual[name].bytes ||
      manifest.outputs[name].sha256 !== actual[name].sha256
    ) {
      throw new Error(`UI artifact mismatch: ${name}`);
    }
  }
  return manifest;
}

export async function verifyProvenance({
  root = PKG_ROOT,
  pkgDirectory = join(root, 'pkg'),
  expectedSourceDigest,
} = {}) {
  const manifest = await verifyArtifactProvenance({ pkgDirectory });
  const current = expectedSourceDigest ?? (await resolveAsset(root)).sha256;
  if (manifest.sourceDigest !== current)
    throw new Error(`UI source changed: built=${manifest.sourceDigest}, current=${current}`);
  return manifest;
}

/** Only admit a completely verified directory. A failed rename restores pkg/. */
export async function installBundle(sourceDirectory, root = PKG_ROOT) {
  const backup = await mkdtemp(join(root, '.pkg-previous-'));
  let previous = false;
  try {
    try {
      await rename(join(root, 'pkg'), join(backup, 'pkg'));
      previous = true;
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
    try {
      await rename(sourceDirectory, join(root, 'pkg'));
    } catch (cause) {
      if (previous) {
        try {
          await rename(join(backup, 'pkg'), join(root, 'pkg'));
        } catch (restore) {
          throw new AggregateError(
            [cause, restore],
            `UI bundle restore failed; retained at ${backup}`,
          );
        }
      }
      throw cause;
    }
  } catch (cause) {
    // Preserve the previous bundle on a failed rollback for explicit recovery.
    if (!(cause instanceof AggregateError)) await rm(backup, { recursive: true, force: true });
    throw cause;
  }
  await rm(backup, { recursive: true, force: true });
}
