import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineShaderSourceDigest } from '../index.js';
import { packagedProfileMatchesSource } from '../shared-engine-inputs.js';

describe('packaged engine shader profile provenance', () => {
  let root: string;
  let sources: string;
  let label: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'packaged-source-digest-'));
    sources = join(root, 'src');
    label = join(root, 'profiles.json.gz#base-ssao');
    mkdirSync(join(sources, 'nested'), { recursive: true });
    writeFileSync(join(sources, 'common.wgsl'), 'var shadowMap: texture_depth_2d_array;\n');
    writeFileSync(join(sources, 'nested', 'entry.wgsl'), 'fn fs_main() {}\n');
    writeFileSync(join(sources, 'notes.md'), 'not shader input');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('digests every WGSL file, including entries without an import path', () => {
    const before = engineShaderSourceDigest(sources);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(sources, 'notes.md'), 'changed');
    expect(engineShaderSourceDigest(sources)).toBe(before);
    writeFileSync(join(sources, 'nested', 'entry.wgsl'), 'fn fs_main() { discard; }\n');
    expect(engineShaderSourceDigest(sources)).not.toBe(before);
    expect(engineShaderSourceDigest(join(root, 'missing'))).toBeUndefined();
  });

  it('admits a profile prepared from the current sources', () => {
    expect(packagedProfileMatchesSource(engineShaderSourceDigest(sources), sources, label)).toBe(
      true,
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('invalidates a profile when an unconventionally named program helper changes', () => {
    mkdirSync(join(sources, 'helpers'), { recursive: true });
    writeFileSync(
      join(sources, 'field-visibility-wgsl.ts'),
      "import { factor } from './helpers/coordinate-tools.js';\nexport const CODE = 'fn factor()->u32{return ' + factor + 'u;}';\n",
    );
    writeFileSync(join(sources, 'helpers', 'coordinate-tools.ts'), 'export const factor = 1;\n');
    const before = engineShaderSourceDigest(sources);
    writeFileSync(join(sources, 'helpers', 'coordinate-tools.ts'), 'export const factor = 2;\n');
    expect(engineShaderSourceDigest(sources)).not.toBe(before);
    expect(packagedProfileMatchesSource(before, sources, label)).toBe(false);
  });

  it('invalidates a profile when its package-owned entry composition recipe changes', () => {
    const owner = join(root, 'node_modules/@forgeax/engine-vite-plugin-shader');
    mkdirSync(join(owner, 'src/engine-inputs'), { recursive: true });
    writeFileSync(
      join(owner, 'package.json'),
      JSON.stringify({ name: '@forgeax/engine-vite-plugin-shader' }),
    );
    const recipe = join(owner, 'src/engine-inputs/load-engine-shader-entries.ts');
    writeFileSync(recipe, "export const imports = { field: 'old' };\n");
    const before = engineShaderSourceDigest(sources);
    writeFileSync(recipe, "export const imports = { field: 'new' };\n");
    expect(engineShaderSourceDigest(sources)).not.toBe(before);
    expect(packagedProfileMatchesSource(before, sources, label)).toBe(false);
  });

  it('ignores test, generated and temporary TypeScript inputs', () => {
    const before = engineShaderSourceDigest(sources);
    for (const directory of ['__tests__', '__generated__', 'tmp']) {
      mkdirSync(join(sources, directory), { recursive: true });
      writeFileSync(join(sources, directory, 'helper.ts'), 'export const irrelevant = 1;\n');
    }
    for (const name of [
      'helper.test.ts',
      'helper.spec.ts',
      'helper.fixture.ts',
      'helper.generated.ts',
      'helper.tmp.ts',
      'wgsl-raw.d.ts',
    ])
      writeFileSync(join(sources, name), 'export const irrelevant = 1;\n');
    expect(engineShaderSourceDigest(sources)).toBe(before);
  });

  it('invalidates package profiles after a VFX program declaration or source edit', () => {
    const owner = join(root, 'node_modules/@forgeax/engine-vfx-render');
    mkdirSync(join(owner, 'src/shaders'), { recursive: true });
    const manifest = (bindings: string) =>
      writeFileSync(
        join(owner, 'package.json'),
        JSON.stringify({
          name: '@forgeax/engine-vfx-render',
          forgeax: { materialPrograms: { 'billboard.wgsl': { bindings } } },
        }),
      );
    manifest('view-only');
    writeFileSync(join(owner, 'src/shaders/billboard.wgsl'), 'fn vs_main() {}');
    const first = engineShaderSourceDigest(sources);
    manifest('view-and-scene-depth');
    const second = engineShaderSourceDigest(sources);
    expect(second).not.toBe(first);
    writeFileSync(join(owner, 'src/shaders/billboard.wgsl'), 'fn vs_main() { return; }');
    expect(engineShaderSourceDigest(sources)).not.toBe(second);
  });

  it('rejects a profile left behind after a WGSL edit and warns once', () => {
    const recorded = engineShaderSourceDigest(sources);
    writeFileSync(join(sources, 'common.wgsl'), 'var shadowMap: texture_depth_2d;\n');
    expect(packagedProfileMatchesSource(recorded, sources, label)).toBe(false);
    expect(packagedProfileMatchesSource(recorded, sources, label)).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('rejects a profile without a provenance record or without resolvable sources', () => {
    expect(packagedProfileMatchesSource(undefined, sources, label)).toBe(false);
    expect(packagedProfileMatchesSource(engineShaderSourceDigest(sources), undefined, label)).toBe(
      false,
    );
  });
});
