import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { loadEngineShaderEntries } from '../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { SCREEN_PROBE_BINDINGS, SCREEN_PROBE_STAGES } from '../../raytracing/screen-probe-kernels';
import { SCREEN_PROBE_FRAME_BYTES } from '../../raytracing/screen-probe-plan';

it('validates the current viewport owner through six production temporal and gather configurations', async () => {
  const current = await readFile(
    new URL('../../../../shader/src/ray-screen-probe.wgsl', import.meta.url),
    'utf8',
  );
  // Read the complete local shader closure even when package dependencies are
  // supplied by another worktree's source-matched read-only carriers.
  const published = resolve(
    dirname(createRequire(import.meta.url).resolve('@forgeax/engine-shader/package.json')),
    'src',
  );
  const local = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  const builtin = await loadEngineShaderEntries((path) => {
    const child = relative(published, path);
    const owned = child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    return readFile(owned ? resolve(local, child) : path, 'utf8');
  });
  expect(builtin.rayScreenProbe.source).toBe(current);
  for (const visibility of [false, true]) {
    for (const entry of [
      'temporalProbeRadiance',
      'filterProbeRadiance',
      'integrateScreenProbes',
    ] as const) {
      const compiled = (
        await compileShader(current, {
          id: `screen-history-viewport-${entry}-${visibility}`,
          imports: builtin.imports,
          defines: { IRRADIANCE_FIELD_VISIBILITY: visibility },
          computeEntry: entry,
        })
      ).unwrap();
      const active = compiled.reflection.boundGlobals.filter(
        (global) => (global.visibility & 4) !== 0,
      );
      expect(
        active.filter((global) => global.addressSpace === 'storage').length,
      ).toBeLessThanOrEqual(8);
      const slots = SCREEN_PROBE_STAGES[entry].slots.map((slot) => SCREEN_PROBE_BINDINGS[slot][0]);
      for (const global of active.filter((global) => global.group === 0))
        expect(slots).toContain(global.binding);
      expect(active.find((global) => global.group === 0 && global.binding === 0)?.span).toBe(
        SCREEN_PROBE_FRAME_BYTES,
      );
    }
  }
});
