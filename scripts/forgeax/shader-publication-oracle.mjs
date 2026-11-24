import assert from 'node:assert/strict';

/** Detached expected values from the encoded pool, independent of wire reconstruction. */
export function shaderPublicationOracle(container, profile, publicationVersion) {
  const rows = container.profiles[profile];
  assert.ok(rows, `packaged profile is missing: ${profile}`);
  assert.equal(rows.schemaVersion, publicationVersion);
  assert.ok(Array.isArray(rows.materialShaders));
  let variantCount = 0;
  for (const row of rows.materialShaders) {
    assert.ok(Array.isArray(row.variants));
    variantCount += row.variants.length;
  }
  const first = rows.materialShaders[0];
  assert.ok(first, 'publication must contain a first material source');
  const indices = container.sources[first.sourceDigest];
  assert.ok(Array.isArray(indices) && indices.length > 0);
  const profileFragments = new Set(rows.fragments);
  const bytes = indices.map((index) => {
    assert.ok(Number.isSafeInteger(index) && index >= 0 && index < container.fragments.length);
    assert.ok(profileFragments.has(index), 'first source leaves its profile fragment table');
    const fragment = container.fragments[index];
    assert.equal(typeof fragment, 'string');
    // UTF-16 preserves exact JS string equality, even across split surrogate pairs.
    return Buffer.from(fragment, 'utf16le');
  });
  return {
    materialCount: rows.materialShaders.length,
    variantCount,
    firstSourceBytes: Buffer.concat(bytes),
  };
}
