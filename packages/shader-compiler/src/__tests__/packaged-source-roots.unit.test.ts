import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { createMaterialPackCooker } from '../material/pack-cooker.js';

it('cooks from the resolved package when the SDK cwd also contains shader sources', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forgeax-sdk-shader-roots-'));
  const duplicateRoot = join(cwd, 'packages/shader/src');
  await mkdir(duplicateRoot, { recursive: true });
  await copyFile(
    fileURLToPath(new URL('../../../shader/src/alpha-hash.wgsl', import.meta.url)),
    join(duplicateRoot, 'alpha-hash.wgsl'),
  );
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  try {
    const base = createBuiltinMaterialAsset('sprite');
    const output = await createMaterialPackCooker().cook({
      guid: 'c17b6c15-aa36-44ec-9c66-6da678c79281',
      source: {
        ...base,
        passes: [{ name: 'forward', program: { module: 'forgeax::sprite' } }],
        parameters: [
          ...(base.parameters ?? []),
          { name: 'region', type: 'vec4' },
          { name: 'pivotAndSize', type: 'vec4' },
          { name: 'slicesAndMode', type: 'vec4' },
          { name: 'baseColorTexture', type: 'texture' },
        ],
      },
    });
    const cooked = validateCookedMaterialRecord(
      (output.payload as { cooked: unknown }).cooked,
    ).unwrap();
    expect(cooked.programs.length).toBeGreaterThan(0);
  } finally {
    cwdSpy.mockRestore();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
