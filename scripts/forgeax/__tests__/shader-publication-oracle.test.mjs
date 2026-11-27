import assert from 'node:assert/strict';
import test from 'node:test';
import { shaderPublicationOracle } from '../shader-publication-oracle.mjs';

function container() {
  return {
    fragments: ['A', 'B', 'C'],
    sources: { first: [1, 0, 2] },
    profiles: {
      'base-ssao': {
        schemaVersion: '5.0.0',
        fragments: [0, 1, 2],
        materialShaders: [{ sourceDigest: 'first', variants: [{}, {}] }, { variants: [{}] }],
      },
    },
  };
}
const read = (value) => shaderPublicationOracle(value, 'base-ssao', '5.0.0');

test('counts the complete material fleet and preserves encoded source order in independent bytes', () => {
  const result = read(container());
  assert.equal(result.materialCount, 2);
  assert.equal(result.variantCount, 3);
  assert.deepEqual([...result.firstSourceBytes], [66, 0, 65, 0, 67, 0]);
});

test('preserves split surrogate code units rather than encoding fragments as separate UTF-8 strings', () => {
  const value = container();
  value.fragments = ['\ud83d', '\ude80'];
  value.sources.first = [0, 1];
  value.profiles['base-ssao'].fragments = [0, 1];
  assert.deepEqual([...read(value).firstSourceBytes], [0x3d, 0xd8, 0x80, 0xde]);
});

test('owns only detached counts and first-source bytes after producer input mutation', () => {
  const value = container();
  const result = read(value);
  value.fragments[1] = 'changed';
  value.sources.first.reverse();
  value.profiles['base-ssao'].materialShaders[0].variants.push({});
  assert.equal(result.variantCount, 3);
  assert.deepEqual([...result.firstSourceBytes], [66, 0, 65, 0, 67, 0]);
});

test('rejects a first source outside the profile table or pool bounds', () => {
  const outside = container();
  outside.profiles['base-ssao'].fragments = [0, 1];
  assert.throws(() => read(outside), /leaves its profile/);
  for (const index of [-1, 3, 0.5]) {
    const value = container();
    value.sources.first = [index];
    assert.throws(() => read(value));
  }
});

test('keeps missing profiles, wrong publication versions and malformed variant arrays closed', () => {
  assert.throws(() => shaderPublicationOracle(container(), 'point-ssao', '5.0.0'), /missing/);
  assert.throws(() => shaderPublicationOracle(container(), 'base-ssao', 'obsolete'));
  const value = container();
  value.profiles['base-ssao'].materialShaders[1].variants = null;
  assert.throws(() => read(value));
});
