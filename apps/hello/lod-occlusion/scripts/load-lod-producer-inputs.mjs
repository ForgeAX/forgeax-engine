import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLodProducerManifestBytes } from './lod-acceptance-evidence.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Verify the selected publication against this checkout and its actual public producers. */
export async function loadLodProducerInputs(directory, options = {}) {
  const inputRoot = resolve(directory);
  const metaBytes = await readFile(resolve(appRoot, 'assets/lod-scene.gltf.meta.json'));
  const meta = JSON.parse(metaBytes.toString('utf8'));
  const guid = (kind, sourceIndex = 0) =>
    meta.subAssets.find((asset) => asset.kind === kind && asset.sourceIndex === sourceIndex)?.guid;
  const roles = {
    root: guid('mesh'),
    middle: guid('mesh', 1),
    lowest: guid('mesh', 2),
    material: guid('material'),
    scene: guid('scene'),
  };
  const manifestBytes = new Uint8Array(await readFile(resolve(inputRoot, 'manifest.json')));
  const identity = {
    producerHead:
      options.producerHead ??
      process.env.FORGEAX_E03_PRODUCER_HEAD ??
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: appRoot,
        encoding: 'utf8',
      }).trim(),
    manifestSha256: sha256(manifestBytes),
  };
  const verified = await verifyLodProducerManifestBytes(manifestBytes, roles, identity);
  const { provenance, shaderClosure } = verified.manifest;
  const sourceBytes = await readFile(resolve(appRoot, 'assets/lod-scene.gltf'));
  if (
    sha256(sourceBytes) !== provenance.source.sha256 ||
    sha256(metaBytes) !== provenance.meta.sha256
  )
    throw new Error('E03 producer source or Meta SHA256 does not match this checkout');
  const modules = await Promise.all(
    ['@forgeax/engine-gltf', '@forgeax/engine-import', '@forgeax/engine-shader'].map(
      async (specifier) => ({
        specifier,
        sha256: sha256(await readFile(fileURLToPath(import.meta.resolve(specifier)))),
      }),
    ),
  );
  if (
    !Array.isArray(provenance.modules) ||
    provenance.modules.length !== modules.length ||
    !modules.every((expected) =>
      provenance.modules.some(
        (actual) => actual.specifier === expected.specifier && actual.sha256 === expected.sha256,
      ),
    )
  )
    throw new Error('E03 producer public module SHA256 does not match this checkout');
  if (shaderClosure.status !== 'cpu-publication-verified')
    throw new Error('E03 GPU input loader requires a verified shader publication');
  const publication = shaderClosure.publication;
  const shaderBytes = await readFile(resolve(inputRoot, publication.path));
  if (
    shaderBytes.byteLength !== publication.byteLength ||
    sha256(shaderBytes) !== publication.sha256
  )
    throw new Error('E03 producer shader publication does not match its manifest');
  if (
    options.shaderManifest !== undefined &&
    sha256(await readFile(options.shaderManifest)) !== publication.sha256
  )
    throw new Error('E03 built app shader manifest differs from the selected producer publication');
  return { verified, identity, roles, inputRoot, shaderBytes };
}
