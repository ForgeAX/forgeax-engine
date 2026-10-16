import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineShaderSourceDigest, PACKAGED_SOURCE_RECORD } from '../index.js';
import { packagedProfileMatchesSource } from '../shared-engine-inputs.js';

describe('packaged engine shader profile provenance', () => {
  let root: string;
  let sources: string;
  let profile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'packaged-source-digest-'));
    sources = join(root, 'src');
    profile = join(root, 'base-ssao');
    mkdirSync(join(sources, 'nested'), { recursive: true });
    mkdirSync(profile);
    writeFileSync(join(sources, 'common.wgsl'), 'var shadowMap: texture_depth_2d_array;\n');
    writeFileSync(join(sources, 'nested', 'entry.wgsl'), 'fn fs_main() {}\n');
    writeFileSync(join(sources, 'notes.md'), 'not shader input');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const record = (shaderSourceDigest: string | undefined): void => {
    writeFileSync(join(profile, PACKAGED_SOURCE_RECORD), JSON.stringify({ shaderSourceDigest }));
  };

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
    record(engineShaderSourceDigest(sources));
    expect(packagedProfileMatchesSource(profile, sources)).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
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
    record(engineShaderSourceDigest(sources));
    writeFileSync(join(sources, 'common.wgsl'), 'var shadowMap: texture_depth_2d;\n');
    expect(packagedProfileMatchesSource(profile, sources)).toBe(false);
    expect(packagedProfileMatchesSource(profile, sources)).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('rejects a profile without a provenance record or without resolvable sources', () => {
    expect(packagedProfileMatchesSource(profile, sources)).toBe(false);
    record(engineShaderSourceDigest(sources));
    expect(packagedProfileMatchesSource(profile, undefined)).toBe(false);
  });
});
