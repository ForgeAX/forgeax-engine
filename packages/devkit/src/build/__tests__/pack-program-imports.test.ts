import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodePackProgramImports } from '../pack-program-imports.js';

describe('Node program Engine imports', () => {
  it('resolves the public import-only SDK exports from the game installation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-program-imports-'));
    try {
      await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
      await symlink(
        resolve(import.meta.dirname, '../../../../engine'),
        resolve(root, 'node_modules/@forgeax/engine'),
        'dir',
      );
      const imports = await createNodePackProgramImports(root);
      expect(imports['@forgeax/engine/scene']?.url).toMatch(/\/engine\/dist\/facades\/scene\.mjs$/);
      expect(imports['@forgeax/engine/scene']?.identity).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
