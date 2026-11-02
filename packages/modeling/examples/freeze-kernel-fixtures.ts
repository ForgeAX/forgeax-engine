/**
 * Regenerates the kernel tests' frozen FXEM inputs (`src/__tests__/fixtures/`) from the
 * example builds they were taken from. Run it when FXEM encoding or decoding changes, then
 * check that `src/__tests__/golden/` is unchanged; only a deliberate kernel output change
 * may move a golden. From this package: `npx tsup && node examples/freeze-kernel-fixtures.ts`.
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { type Model, model } from '@forgeax/engine-modeling';
import { BRACKET_DEFAULTS, buildBracket } from './bracket/bracket.ts';
import { buildCrate } from './crate/crate.ts';
import { buildForearm } from './forearm/forearm.ts';
import { buildHousing } from './housing/housing.ts';
import { buildPanel, PANEL_DEFAULTS } from './panel/panel.ts';
import { buildPauldron } from './pauldron/pauldron.ts';
import { buildSuspension } from './suspension/suspension.ts';
import { buildWheel, WHEEL_DEFAULTS } from './wheel-uv/wheel.ts';

const FIXTURES = new URL('../src/__tests__/fixtures/', import.meta.url);
const gz = (m: Model | Uint8Array): Buffer =>
  gzipSync(m instanceof Uint8Array ? m : m.snapshot(), { level: 9 });

/** The pauldron plate and mount just before their subdivision, which the test replays. */
function pauldronInputs(): Record<'pauldron' | 'mount', Uint8Array> {
  const out: Partial<Record<'pauldron' | 'mount', Uint8Array>> = {};
  buildPauldron(undefined, (name) => {
    const m = model();
    const subdivide = m.subdivide.bind(m);
    m.subdivide = ((...args: Parameters<Model['subdivide']>) => {
      out[name as 'pauldron' | 'mount'] ??= m.snapshot();
      return subdivide(...args);
    }) as Model['subdivide'];
    return m;
  });
  return out as Record<'pauldron' | 'mount', Uint8Array>;
}

const states: Record<string, Model | Uint8Array> = {
  'crate-default': buildCrate(),
  'crate-variant': buildCrate({ width: 1.2, height: 0.4, depth: 0.6 }),
  bracket: buildBracket(),
  'bracket-long': buildBracket({ ...BRACKET_DEFAULTS, length: 0.3 }),
  housing: buildHousing(),
  panel: buildPanel(),
  ...pauldronInputs(),
  wheel: buildWheel({ ...WHEEL_DEFAULTS, segments: 32 }),
  forearm: buildForearm(),
};
const entries = Object.entries(states).map(([name, m]) => {
  const key = /^[a-z]+$/.test(name) ? name : `'${name}'`;
  return `  ${key}:\n    '${gz(m).toString('base64')}',\n`;
});
writeFileSync(
  new URL('frozen-states.ts', FIXTURES),
  [
    '/**\n',
    ' * Gzipped FXEM states (base64) that `frozen-builds.ts` restores. Generated; regenerate them\n',
    ' * with the freeze-kernel-fixtures script next to the example builds, never by hand.\n',
    ' */\n',
    'export const FROZEN_STATES: Readonly<Record<string, string>> = {\n',
    ...entries,
    '};\n',
  ].join(''),
);
writeFileSync(
  new URL('panel-narrow.fxem.gz', FIXTURES),
  gz(buildPanel({ ...PANEL_DEFAULTS, width: 0.28 })),
);
writeFileSync(new URL('suspension.fxem.gz', FIXTURES), gz(buildSuspension()));
