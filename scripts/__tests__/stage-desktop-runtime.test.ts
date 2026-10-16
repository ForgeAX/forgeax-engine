import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { stageEngineDesktopCommon } from '../stage-desktop-runtime.mjs';

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

const sampleManifest = {
  id: 'template-sample',
  name: 'Sample',
  schemaVersion: '2.0.0',
  plugins: [],
};

function stagingFixture() {
  const root = mkdtempSync(join(tmpdir(), 'engine-common-source-'));
  const output = `${root}-output`;
  roots.push(root, output);
  mkdirSync(join(root, 'templates/sample'), { recursive: true });
  writeFileSync(join(root, 'templates/sample/forge.json'), JSON.stringify(sampleManifest));
  writeFileSync(join(root, 'templates/sample/main.ts'), 'export {};');
  for (const asset of ['demo-assets/template-game-default', 'sfx', 'collectathon-audio']) {
    mkdirSync(join(root, 'forgeax-engine-assets', asset), { recursive: true });
    writeFileSync(join(root, 'forgeax-engine-assets', asset, 'asset.txt'), asset);
  }
  for (const [directory, files] of [
    ['wgpu-wasm', ['wgpu_wasm.js', 'wgpu_wasm_bg.wasm']],
    ['fbx', ['fbx-wasm.mjs', 'fbx-wasm.wasm']],
    ['codec', ['basis_transcoder.mjs', 'basis_transcoder.wasm']],
  ] as const) {
    mkdirSync(join(root, 'packages', directory, 'pkg'), { recursive: true });
    for (const file of files) {
      const path = join(root, 'packages', directory, 'pkg', file);
      writeFileSync(path, file);
      if (file.endsWith('.wasm')) chmodSync(path, 0o755);
    }
  }
  mkdirSync(join(root, 'packages/codec/pkg/encode'), { recursive: true });
  const encoderWasm = join(root, 'packages/codec/pkg/encode/basis_encoder.wasm');
  writeFileSync(encoderWasm, 'basis_encoder.wasm');
  chmodSync(encoderWasm, 0o755);
  return { root, output };
}

describe('Engine desktop common producer', () => {
  test('runs the CLI under the test Node runtime', () => {
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, '../stage-desktop-runtime.mjs')],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[engine-desktop-runtime] --output is required');
  });

  test('stages templates, common assets, and exact WASM payloads', () => {
    const { root, output } = stagingFixture();
    stageEngineDesktopCommon(root, output);
    expect(existsSync(join(output, 'editor/packages/engine/templates/sample/main.ts'))).toBe(true);
    expect(
      existsSync(
        join(output, 'engine/node_modules/@forgeax/engine-wgpu-wasm/pkg/wgpu_wasm_bg.wasm'),
      ),
    ).toBe(true);
    for (const path of [
      'engine/node_modules/@forgeax/engine-wgpu-wasm/pkg/wgpu_wasm_bg.wasm',
      'engine/node_modules/@forgeax/engine-fbx/pkg/fbx-wasm.wasm',
      'engine/node_modules/@forgeax/engine-codec/pkg/basis_transcoder.wasm',
      'engine/node_modules/@forgeax/engine-codec/pkg/encode/basis_encoder.wasm',
    ]) {
      expect(statSync(join(output, path)).mode & 0o777).toBe(0o644);
    }
  });

  test('stages the real schema 2.0 game templates', () => {
    const { root, output } = stagingFixture();
    rmSync(join(root, 'templates'), { recursive: true });
    cpSync(resolve(import.meta.dirname, '../../templates'), join(root, 'templates'), {
      recursive: true,
    });

    stageEngineDesktopCommon(root, output);

    for (const template of ['empty', 'game-3d']) {
      const manifest = JSON.parse(
        readFileSync(
          join(output, 'editor/packages/engine/templates', template, 'forge.json'),
          'utf8',
        ),
      );
      expect(manifest.schemaVersion).toBe('2.0.0');
      expect(manifest.entry).toBeUndefined();
      expect(manifest.plugins).toEqual(expect.any(Array));
    }
  });

  test.each([
    ['legacy entry', { ...sampleManifest, entry: 'main.ts' }, 'forge-unknown-field'],
    ['missing plugins', { ...sampleManifest, plugins: undefined }, 'forge-schema-invalid'],
    [
      'invalid scene GUID',
      { ...sampleManifest, defaultScene: 'scene.json' },
      'forge-guid-malformed',
    ],
  ])('rejects %s through the project schema', (_name, manifest, code) => {
    const { root, output } = stagingFixture();
    writeFileSync(join(root, 'templates/sample/forge.json'), JSON.stringify(manifest));

    expect(() => stageEngineDesktopCommon(root, output)).toThrow(
      new RegExp(`sample/forge\\.json.*${code}`),
    );
  });

  test('rejects invalid JSON with the failing template path', () => {
    const { root, output } = stagingFixture();
    writeFileSync(join(root, 'templates/sample/forge.json'), '{');

    expect(() => stageEngineDesktopCommon(root, output)).toThrow(
      /sample\/forge\.json.*forge-parse-failed/,
    );
  });

  test('rejects a template without forge.json', () => {
    const { root, output } = stagingFixture();
    rmSync(join(root, 'templates/sample/forge.json'));

    expect(() => stageEngineDesktopCommon(root, output)).toThrow(
      'template manifest is missing: sample/forge.json',
    );
  });

  test('rejects an empty template directory', () => {
    const { root, output } = stagingFixture();
    rmSync(join(root, 'templates/sample'), { recursive: true });

    expect(() => stageEngineDesktopCommon(root, output)).toThrow('no game templates were staged');
  });
});
