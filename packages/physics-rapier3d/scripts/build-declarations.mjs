import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'tsup';

export async function bundleRapierDeclarations(declarations, staged, tsconfig) {
  await build({
    entry: { rapier: join(declarations, 'rapier.d.ts') },
    dts: { only: true },
    format: ['esm'],
    outDir: staged,
    tsconfig,
  });
  await rename(join(staged, 'rapier.d.ts'), join(staged, 'rapier.d.mts'));
}
