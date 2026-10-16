import { createHash } from 'node:crypto';
import { SHADER_MANIFEST_PUBLICATION_VERSION, shaderSourceDigestInput } from '@forgeax/engine/shader';

export function createMusicFixtureShaderManifest(publication) {
  if (
    publication?.schemaVersion !== SHADER_MANIFEST_PUBLICATION_VERSION ||
    !Array.isArray(publication.entries) ||
    !Array.isArray(publication.materialShaders) ||
    !Array.isArray(publication.fragments) ||
    !Array.isArray(publication.receipts) ||
    publication.sources === null ||
    typeof publication.sources !== 'object'
  ) {
    throw new Error('music fixture requires the published Engine shader manifest');
  }

  // Keep every built-in Engine source row and the two material catalogs used
  // while Renderer prepares its built-in PBR/unlit pipelines. The audio-only
  // scene authors no other materials, so their cooked variants only inflate
  // each Worker publication with unrelated shader catalogs.
  const materialShaders = publication.materialShaders.filter((entry) =>
    ['forgeax::default-standard-pbr', 'forgeax::default-unlit'].includes(entry.identifier),
  );
  const fragments = [];
  const fragmentsByText = new Map();
  const sources = {};
  const retainedRows = [
    ...publication.entries,
    ...materialShaders.flatMap((entry) => {
      if (!Array.isArray(entry.variants)) throw new Error('music fixture material variants are invalid');
      return [entry, ...entry.variants];
    }),
  ];
  const receipts = [];
  const receiptIndices = new Map();
  for (const row of retainedRows) {
    if (row.receiptIndex === undefined || receiptIndices.has(row.receiptIndex)) continue;
    if (
      !Number.isSafeInteger(row.receiptIndex) ||
      row.receiptIndex < 0 ||
      row.receiptIndex >= publication.receipts.length
    ) {
      throw new Error('music fixture shader receipt reference is invalid');
    }
    receiptIndices.set(row.receiptIndex, receipts.length);
    receipts.push(publication.receipts[row.receiptIndex]);
  }
  const remapReceipt = (row) =>
    row.receiptIndex === undefined ? row : { ...row, receiptIndex: receiptIndices.get(row.receiptIndex) };

  for (const digest of new Set(retainedRows.map((entry) => entry.sourceDigest))) {
    const indices = publication.sources[digest];
    if (!Array.isArray(indices) || indices.length === 0) {
      throw new Error(`music fixture Engine source is missing: ${digest}`);
    }
    const fragmentDigests = [];
    const retained = indices.map((oldIndex) => {
      const fragment = publication.fragments[oldIndex];
      if (typeof fragment !== 'string') throw new Error(`music fixture fragment is invalid: ${digest}`);
      let prepared = fragmentsByText.get(fragment);
      if (prepared === undefined) {
        prepared = { index: fragments.length, digest: createHash('sha256').update(fragment).digest() };
        fragments.push(fragment);
        fragmentsByText.set(fragment, prepared);
      }
      fragmentDigests.push(prepared.digest);
      return prepared.index;
    });
    const actual = createHash('sha256').update(shaderSourceDigestInput(fragmentDigests)).digest('hex');
    if (actual !== digest) throw new Error(`music fixture Engine source digest mismatch: ${digest}`);
    sources[digest] = retained;
  }

  return {
    schemaVersion: publication.schemaVersion,
    receipts,
    fragments,
    sources,
    entries: publication.entries.map(remapReceipt),
    materialShaders: materialShaders.map((entry) => ({
      ...remapReceipt(entry),
      variants: entry.variants.map(remapReceipt),
    })),
  };
}
