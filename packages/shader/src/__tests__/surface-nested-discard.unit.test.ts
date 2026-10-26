import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${directory}${name}`, 'utf8');
const code = (source: string): string => source.replace(/\/\/.*$/gm, '');

// Dawn/Metal writes a zero color for a fragment discarded inside a nested
// callee (the skin fs_opaque lost its clipped pixels). The standard Surface
// evaluator and its alpha helpers must return coverage plus alphaClipThreshold
// and leave every `discard` to the entry-point wrappers.
describe('standard Surface nested discard guard', () => {
  it('keeps evaluate_standard_surface free of discard and discarding imports', () => {
    const surface = code(read('default_standard_surface.wgsl'));
    // applyAlphaHash still discards inside this callee; the Dawn pixel probe
    // (nested-discard-pixels.dawn.test.ts) shows it keeps clipped pixels.
    expect(surface).not.toMatch(/\bdiscard\b/);
    expect(surface).not.toMatch(/\balphaCoverage\b/);
    expect(surface).toContain('alphaCoverageClipThreshold(');
  });

  it('keeps the non-discarding coverage helpers free of discard', () => {
    const hash = code(read('alpha-hash.wgsl'));
    for (const name of ['alphaCoverageValue', 'alphaCoverageClipThreshold']) {
      const start = hash.indexOf(`fn ${name}(`);
      expect(start, name).toBeGreaterThanOrEqual(0);
      const end = hash.indexOf('\nfn ', start + 1);
      expect(hash.slice(start, end < 0 ? undefined : end), name).not.toMatch(/\bdiscard\b/);
    }
  });
});

interface Site {
  readonly file: string;
  readonly fn: string;
  readonly line: number;
}

/** Every `discard` and the function that owns it; `entry` marks stage entry points. */
function discardSites(): { sites: Site[]; entry: Set<string> } {
  const sites: Site[] = [];
  const entry = new Set<string>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.wgsl'))) {
    let current = '<module>';
    let stage = false;
    const lines = code(read(file)).split('\n');
    lines.forEach((line, index) => {
      if (/^\s*@(fragment|vertex|compute)\b/.test(line)) stage = true;
      const declared = /\bfn\s+(\w+)/.exec(line);
      if (declared?.[1] !== undefined) {
        current = declared[1];
        if (stage || /@(fragment|vertex|compute)\b/.test(line)) entry.add(`${file}:${current}`);
        stage = false;
      }
      if (/\bdiscard\b/.test(line)) sites.push({ file, fn: current, line: index + 1 });
    });
  }
  return { sites, entry };
}

// Nested `discard` callees that are NOT known to erase clipped pixels. Each is
// either covered by a Dawn pixel probe or still unprobed; moving one into an
// entry point (callee returns coverage or a threshold, entry point discards once)
// is the fix once a probe turns red. Probe: runtime/src/__tests__/dawn/nested-discard-pixels.dawn.test.ts.
const PROVEN_KEEPS_PIXELS =
  'nested-discard-pixels.dawn.test.ts proves the clipped pixel / temporal / shadow texel is kept';
const NOT_YET_PROBED = 'no Dawn pixel probe yet; audit before relying on it';
const ALLOWED_NESTED_DISCARD: Readonly<Record<string, string>> = {
  'alpha-hash.wgsl:applyAlphaHash': PROVEN_KEEPS_PIXELS,
  'alpha-hash.wgsl:alphaCoverage': PROVEN_KEEPS_PIXELS,
  'default-standard-pbr.wgsl:alphaTestSurface': PROVEN_KEEPS_PIXELS,
  'default-standard-pbr-skin.wgsl:alphaTestSurface': PROVEN_KEEPS_PIXELS,
  'shadow_caster.wgsl:alphaTestShadowSurface': PROVEN_KEEPS_PIXELS,
  'standard-surface.wgsl:alphaTest': NOT_YET_PROBED,
  'clipping.wgsl:applyLocalClipping': NOT_YET_PROBED,
  'common.wgsl:applyLodCoverage': NOT_YET_PROBED,
  'oit.wgsl:oitAccumulate': NOT_YET_PROBED,
  'points-lines.wgsl:shadePointsLines': NOT_YET_PROBED,
  'standard-deferred-lighting.wgsl:resolveStandardDeferred':
    'deferred resolve helper; discard leaves the lighting target untouched by design',
};

describe('shipped WGSL discard placement', () => {
  const { sites, entry } = discardSites();

  it('finds discard sites (scanner is not vacuous)', () => {
    expect(sites.length).toBeGreaterThan(15);
    expect(entry.size).toBeGreaterThan(20);
  });

  it('only discards in entry points or allowlisted callees', () => {
    const nested = sites.filter((site) => !entry.has(`${site.file}:${site.fn}`));
    const offenders = nested
      .filter((site) => ALLOWED_NESTED_DISCARD[`${site.file}:${site.fn}`] === undefined)
      .map((site) => `${site.file}:${site.line} in ${site.fn}`);
    expect(
      offenders,
      'discard in a nested callee; return coverage and discard once in the entry point',
    ).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const nested = new Set(
      sites.filter((site) => !entry.has(`${site.file}:${site.fn}`)).map((s) => `${s.file}:${s.fn}`),
    );
    expect(Object.keys(ALLOWED_NESTED_DISCARD).filter((key) => !nested.has(key))).toEqual([]);
  });
});
