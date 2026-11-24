import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeHeapSnapshot } from 'node:v8';
import { shaderPublicationOracle } from './shader-publication-oracle.mjs';

// Run in a fresh --expose-gc process with the runner-derived SDK heap. This exercises
// JSON/fetch admission of the real complete fleet without constructing a GPU.
const [containerPath, profile] = process.argv.slice(2);
if (!containerPath || !profile || typeof globalThis.gc !== 'function') {
  throw new Error(
    'usage: node --expose-gc scripts/forgeax/check-shader-publication.mjs <profiles.json.gz> <profile>',
  );
}
const { ShaderRegistry, SHADER_MANIFEST_PUBLICATION_VERSION } = await import(
  pathToFileURL(resolve('packages/shader/dist/index.mjs')).href
);
const { decodePackagedProfiles, packagedProfilePublication } = await import(
  pathToFileURL(resolve('packages/vite-plugin-shader/dist/packaged-profiles.mjs')).href
);
const diagnosticHeapSnapshot = process.env.FORGEAX_SHADER_PUBLICATION_HEAP_SNAPSHOT;
let diagnosticOracleRefs;
const checkerBlobSha256 = createHash('sha256')
  .update(await readFile(new URL(import.meta.url)))
  .digest('hex');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function loadRegistryFromOracle(containerPath, profile) {
  const containerBytes = await readFile(containerPath);
  // Each checker-side copy (container, rebuilt publication, wire text, oracle
  // parse tree) is released before the registry parses, so the transient peak
  // measures admission rather than the checker's own scaffolding. The checks and
  // the retained-heap limit are unchanged.
  let container = decodePackagedProfiles(containerBytes);
  assert.ok(container, `obsolete packaged profile container: ${containerPath}`);
  const oracle = shaderPublicationOracle(container, profile, SHADER_MANIFEST_PUBLICATION_VERSION);
  let rebuilt = packagedProfilePublication(container, profile);
  assert.ok(rebuilt, `packaged profile is missing: ${profile}`);
  if (diagnosticHeapSnapshot) {
    diagnosticOracleRefs = [
      ['rebuilt-publication', rebuilt],
      ['container', container],
      ['materialShaders', container.profiles[profile].materialShaders],
      ['sources', container.sources],
      ['fragments', container.fragments],
    ].map(([label, value]) => [label, new WeakRef(value)]);
  }
  container = null;
  let wireText = JSON.stringify(rebuilt);
  rebuilt = null;
  const expectedCounts = { materialCount: oracle.materialCount, variantCount: oracle.variantCount };
  const wireBytes = Buffer.byteLength(wireText);
  let wireBody = new TextEncoder().encode(wireText);
  wireText = null;
  // Retire checker-only producer/oracle graphs before measuring the real consumer.
  await new Promise((resolveTick) => setImmediate(resolveTick));
  globalThis.gc();
  const registry = new ShaderRegistry({
    manifestUrl: 'https://shader-publication.invalid/manifest.json',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const response = new Response(wireBody);
    wireBody = null;
    return response;
  };
  try {
    const loaded = await registry.loadManifest();
    assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
  } finally {
    globalThis.fetch = originalFetch;
  }
  return {
    registry,
    expectedCounts,
    firstSourceBytes: oracle.firstSourceBytes,
    wireBytes,
    containerSha256: sha256(containerBytes),
  };
}

const started = performance.now();
const { registry, expectedCounts, firstSourceBytes, wireBytes, containerSha256 } =
  await loadRegistryFromOracle(containerPath, profile);
await new Promise((resolveTick) => setImmediate(resolveTick));
globalThis.gc();
const retained = process.memoryUsage();
const liveOracleLabels = diagnosticHeapSnapshot
  ? diagnosticOracleRefs
      .filter(([, reference]) => reference.deref() !== undefined)
      .map(([label]) => label)
  : [];
if (diagnosticHeapSnapshot) {
  writeHeapSnapshot(diagnosticHeapSnapshot);
}
const materials = [...registry.materialShaderManifestEntries()];
const materialCount = materials.length;
const variantCount = materials.reduce((sum, row) => sum + row.variants.length, 0);
const materialCountMatches = materialCount === expectedCounts.materialCount;
const variantCountMatches = variantCount === expectedCounts.variantCount;
// Demand one material source after admission; its bytes must match the exact
// ordered fragments committed by its verified source identity. Keep only that
// exact UTF-16 source witness from the independent oracle; a Buffer does not
// retain a parsed string slice's backing JSON text. Decoding the entire pooled
// container again beside the live registry would measure two fleets at once.
const selectedSourceEqual =
  materials[0] !== undefined &&
  Buffer.from(materials[0].composedWgsl, 'utf16le').equals(firstSourceBytes);
const containerHashAfter = sha256(await readFile(containerPath));
const containerUnchanged = containerHashAfter === containerSha256;
const retainedHeapWithinLimit = retained.heapUsed < 128 * 1024 * 1024;
console.log(
  JSON.stringify({
    containerPath,
    checkerBlobSha256,
    profile,
    wireBytes,
    materialCount: materials.length,
    variantCount,
    materialCountMatches,
    variantCountMatches,
    selectedSourceEqual,
    containerSha256: containerSha256,
    containerHashAfter,
    containerUnchanged,
    retainedHeapBytes: retained.heapUsed,
    retainedHeapWithinLimit,
    rssBytes: retained.rss,
    externalBytes: retained.external,
    arrayBuffersBytes: retained.arrayBuffers,
    elapsedMs: Math.round(performance.now() - started),
    ...(diagnosticHeapSnapshot
      ? {
          diagnosticHeapSnapshot,
          oracleCollectedAtMeasurement: liveOracleLabels.length === 0,
          liveOracleLabels,
        }
      : {}),
  }),
);
assert.equal(materialCountMatches, true);
assert.equal(variantCountMatches, true);
assert.equal(selectedSourceEqual, true);
assert.equal(containerUnchanged, true, 'profile container changed during publication admission');
if (diagnosticHeapSnapshot) {
  assert.deepEqual(liveOracleLabels, [], 'oracle objects remain live at heap measurement');
}
assert.ok(
  retainedHeapWithinLimit,
  `shader-publication-retained-heap-exceeded: ${retained.heapUsed}`,
);
