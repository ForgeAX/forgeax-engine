// AC-04 unified name resolution — single source of truth, no bypass (feat-20260618 w18).
//
// resolveName is the one runtime name-truth function and it delegates to the
// stateless deriveAssetName pure function (D-6). Every other name consumer reads
// resolveName or that same deriveAssetName -- none re-implements the display-name rule.
//
// This is a grep/fixture test, not a pure runtime assertion: it reads the source
// trees and asserts structural unification.
//
// M4 (w24/w22) wiring completed: inspect() now calls resolveName; the catalog
// builder now calls deriveAssetName. The grep assertions below confirm both
// paths route through the SSOT, no bypass.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const registrySrc = readFileSync(`${here}../../../assets-runtime/src/asset-registry.ts`, 'utf8');
const deriveSrc = readFileSync(
  fileURLToPath(new URL('../../../pack/src/deriveAssetName.ts', import.meta.url)),
  'utf8',
);
const buildCatalogSrc = readFileSync(
  fileURLToPath(new URL('../../../pack/src/catalog-builder.ts', import.meta.url)),
  'utf8',
);

describe('unified name resolution (AC-04)', () => {
  it('deriveAssetName is the single display-name rule definition', () => {
    expect(deriveSrc).toContain('export function deriveAssetName');
  });

  it('resolveName delegates to deriveAssetName (no inline re-implementation)', () => {
    expect(registrySrc).toContain("import { deriveAssetName } from '@forgeax/engine-pack/name'");
    // resolveName returns the result of deriveAssetName, not a hand-rolled rule.
    const body = registrySrc.slice(
      registrySrc.indexOf('resolveName(guid: AssetGuid | string): string'),
    );
    const fnBody = body.slice(0, body.indexOf('\n  }'));
    expect(fnBody).toContain('return deriveAssetName(');
  });

  it('resolveName is the only public name accessor on the registry (no sibling getName)', () => {
    expect(registrySrc).not.toMatch(/\n {2}getName\(/);
    expect(registrySrc).not.toMatch(/\n {2}displayName\(/);
  });

  // M4 expansion (w24 landed): inspect() routes through resolveName
  it('inspect() calls resolveName per entry (M4 w24 wiring)', () => {
    // inspect() pushes { name: this.resolveName(guid) } -- no inline basename
    expect(registrySrc).toContain('name: this.resolveName(guid)');
    // No hardcoded '' placeholder left from M1/w3
    expect(registrySrc).not.toContain("name: ''");
  });

  // M4 expansion (w22 landed): catalog-builder routes through deriveAssetName
  it('catalog-builder imports and calls deriveAssetName (no inline display-name rule)', () => {
    expect(buildCatalogSrc).toContain("import { deriveAssetName } from './deriveAssetName.js'");
    expect(buildCatalogSrc).toContain('deriveAssetName(');
    // No inline re-implementation (no hand-rolled basename); the single
    // deriveAssetName pure function handles the display-name rule.
    expect(buildCatalogSrc.match(/deriveAssetName\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
