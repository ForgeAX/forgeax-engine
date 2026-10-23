import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodePackagedProfiles,
  encodePackagedProfiles,
  packagedProfilePublication,
} from '../engine-inputs/packaged-profiles.js';

const digest = (character: string) => character.repeat(64);

function publication(fragments: string[], sources: Record<string, number[]>, marker: string) {
  return {
    schemaVersion: '5.0.0',
    receipts: [{ marker }],
    entryPoints: [],
    fragments,
    sources,
    entries: Object.keys(sources).map((sourceDigest) => ({ hash: marker, sourceDigest })),
    materialShaders: [],
  };
}

// Shared sources keep their digest across profiles while each profile orders
// its own fragment table; the container must reproduce both tables exactly.
const base = publication(
  ['shared-a', 'shared-b', 'base-only'],
  { [digest('a')]: [0, 1], [digest('b')]: [2, 1] },
  'base',
);
const point = publication(
  ['point-only', 'shared-a', 'shared-b'],
  { [digest('c')]: [0], [digest('a')]: [1, 2] },
  'point',
);
const imports = { 'forgeax::module': 'fn shared() {}' };

describe('packaged engine shader profiles', () => {
  it('pools shared fragments once and rebuilds each exact compiler publication', () => {
    const bytes = encodePackagedProfiles({
      shaderSourceDigest: 'wgsl',
      imports,
      publications: { 'base-ssao': base, 'point-ssao': point },
    });
    const container = decodePackagedProfiles(bytes);
    expect(container?.fragments).toEqual(['shared-a', 'shared-b', 'base-only', 'point-only']);
    expect(container?.imports).toEqual(imports);
    expect(container?.shaderSourceDigest).toBe('wgsl');
    if (container === undefined) throw new Error('container must decode');
    expect(JSON.stringify(packagedProfilePublication(container, 'base-ssao'))).toBe(
      JSON.stringify(base),
    );
    expect(JSON.stringify(packagedProfilePublication(container, 'point-ssao'))).toBe(
      JSON.stringify(point),
    );
  });

  it('is deterministic and omits profiles that were not prepared', () => {
    const encode = () =>
      encodePackagedProfiles({
        shaderSourceDigest: 'wgsl',
        imports,
        publications: { 'point-ssao': point },
      });
    expect(encode().equals(encode())).toBe(true);
    const container = decodePackagedProfiles(encode());
    if (container === undefined) throw new Error('container must decode');
    expect(packagedProfilePublication(container, 'base-ssao')).toBeUndefined();
  });

  it('rejects profiles that disagree on a shared source identity', () => {
    const conflicting = publication(['other'], { [digest('a')]: [0] }, 'point');
    expect(() =>
      encodePackagedProfiles({
        shaderSourceDigest: 'wgsl',
        imports,
        publications: { 'base-ssao': base, 'point-ssao': conflicting },
      }),
    ).toThrow('disagree');
  });

  it('rebuilds producer-specific fragment and key order exactly', () => {
    // Merged app inputs put fragments first and need not order them by first use.
    const merged = {
      schemaVersion: '5.0.0',
      fragments: ['shared-b', 'shared-a'],
      sources: { [digest('a')]: [1, 0] },
      receipts: [{ marker: 'merged' }],
      entryPoints: [],
      entries: [{ hash: 'merged', sourceDigest: digest('a') }],
      materialShaders: [],
    };
    const container = decodePackagedProfiles(
      encodePackagedProfiles({
        shaderSourceDigest: 'wgsl',
        imports,
        publications: { 'base-ssao': base, 'point-ssao': merged },
      }),
    );
    if (container === undefined) throw new Error('container must decode');
    expect(JSON.stringify(packagedProfilePublication(container, 'point-ssao'))).toBe(
      JSON.stringify(merged),
    );
  });

  it('refuses a publication whose fragment table it cannot reproduce exactly', () => {
    const duplicated = publication(['same', 'same'], { [digest('a')]: [0, 1] }, 'base');
    expect(() =>
      encodePackagedProfiles({
        shaderSourceDigest: 'wgsl',
        imports,
        publications: { 'base-ssao': duplicated },
      }),
    ).toThrow('exact compiler publication');
  });

  it('reports another container version as obsolete and malformed bytes as invalid', () => {
    expect(decodePackagedProfiles(gzipSync(JSON.stringify({ schemaVersion: 0 })))).toBeUndefined();
    const valid = JSON.parse(
      gunzipSync(
        encodePackagedProfiles({
          shaderSourceDigest: 'wgsl',
          imports,
          publications: { 'base-ssao': base },
        }),
      ).toString('utf8'),
    );
    expect(() =>
      decodePackagedProfiles(gzipSync(JSON.stringify({ ...valid, fragments: [1] }))),
    ).toThrow('Invalid packaged engine shader profiles');
  });
});
