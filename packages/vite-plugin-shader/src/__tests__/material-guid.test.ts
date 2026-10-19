import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { forgeaxShader } from '../index.js';

it('admits UUIDv7 material identities through the same Pack GUID contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'material-guid-'));
  try {
    const source =
      '#define_import_path guid_test::material\n@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }\n@fragment fn fs_main() -> @location(0) vec4<f32> { return material.tint; }';
    await writeFile(join(root, 'material.wgsl'), source);
    const path = join(root, 'material.pack.json');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: '019e7600-0000-7000-8000-000000000001',
            kind: 'material',
            sourceKey: 'material.wgsl',
            refs: [],
            payload: {
              kind: 'material',
              parameters: [{ name: 'tint', type: 'vec4' }],
              passes: [
                {
                  name: 'Forward',
                  program: {
                    module: 'guid_test::material',
                    vertexEntry: 'vs_main',
                    fragmentEntry: 'fs_main',
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const plugin = forgeaxShader({ engineEntries: false, materialPackages: [path] });
    await expect(
      plugin.buildStart.call({ emitFile: () => 'artifact' } as never),
    ).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
