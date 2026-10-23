import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run in a fresh, --expose-gc --max-old-space-size=512 process. This exercises
// JSON/fetch admission of the real complete fleet without constructing a GPU.
const [containerPath, profile] = process.argv.slice(2);
if (!containerPath || !profile || typeof globalThis.gc !== 'function') {
  throw new Error(
    'usage: node --expose-gc --max-old-space-size=512 scripts/forgeax/check-shader-publication.mjs <profiles.json.gz> <profile>',
  );
}
const { ShaderRegistry, SHADER_MANIFEST_PUBLICATION_VERSION } = await import(
  pathToFileURL(resolve('packages/shader/dist/index.mjs')).href
);
const { decodePackagedProfiles, packagedProfilePublication } = await import(
  pathToFileURL(resolve('packages/vite-plugin-shader/dist/packaged-profiles.mjs')).href
);
// Only the profile's wire text survives this scope, so the retained-heap bound
// measures registry admission rather than the pooled container.
const text = await (async () => {
  const container = decodePackagedProfiles(await readFile(containerPath));
  assert.ok(container, `obsolete packaged profile container: ${containerPath}`);
  const rebuilt = packagedProfilePublication(container, profile);
  assert.ok(rebuilt, `packaged profile is missing: ${profile}`);
  return JSON.stringify(rebuilt);
})();
const publication = JSON.parse(text);
assert.equal(publication.schemaVersion, SHADER_MANIFEST_PUBLICATION_VERSION);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(text);
const registry = new ShaderRegistry({
  manifestUrl: 'https://shader-publication.invalid/manifest.json',
});
const started = performance.now();
try {
  const loaded = await registry.loadManifest();
  assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
} finally {
  globalThis.fetch = originalFetch;
}
globalThis.gc();
const retained = process.memoryUsage();
assert.ok(
  retained.heapUsed < 128 * 1024 * 1024,
  `shader-publication-retained-heap-exceeded: ${retained.heapUsed}`,
);
const materials = [...registry.materialShaderManifestEntries()];
assert.equal(materials.length, publication.materialShaders.length);
assert.equal(
  materials.reduce((sum, row) => sum + row.variants.length, 0),
  publication.materialShaders.reduce((sum, row) => sum + row.variants.length, 0),
);
// Demand one material source after admission; its bytes must match the exact
// ordered fragments committed by its verified source identity.
assert.equal(
  materials[0].composedWgsl,
  publication.sources[publication.materialShaders[0].sourceDigest]
    .map((index) => publication.fragments[index])
    .join(''),
);
console.log(
  JSON.stringify({
    containerPath,
    profile,
    wireBytes: Buffer.byteLength(text),
    materialCount: materials.length,
    variantCount: materials.reduce((sum, row) => sum + row.variants.length, 0),
    retainedHeapBytes: retained.heapUsed,
    rssBytes: retained.rss,
    elapsedMs: Math.round(performance.now() - started),
  }),
);
