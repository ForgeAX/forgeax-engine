// Renders the multi-feature assembly (network + shaded) and writes one summary.json with provenance.txt from a
// committed, clean tree. Output: QF_OUT (default _scratch/viz-out/qf-multi/).
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderShape } from '../brep-kit/render.ts';
import { buildAssembly } from './multi-feature.ts';

const outDir =
  process.env.QF_OUT ?? new URL('../../../../_scratch/viz-out/qf-multi/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const built = buildAssembly();
if (!built.ok) throw new Error(built.error);
const { rows, meshes, unified } = built.value;
const rendered = renderShape(meshes, {
  name: 'multi-',
  modes: ['network', 'shaded'],
  outDir,
  colorBy: 'part',
});
if (!rendered.ok) throw new Error(`render failed: ${JSON.stringify(rendered.error).slice(0, 300)}`);

const git = (args: string): string => execSync(`git ${args}`, { encoding: 'utf8' }).trim();
const sha = git('rev-parse HEAD');
const dirty = git('status --porcelain -- src examples').length > 0;
const body = `${JSON.stringify({ sha, dirty, size: 0.25, unified, parts: rows }, null, 2)}\n`;
writeFileSync(`${outDir}/summary.json`, body);
writeFileSync(
  `${outDir}/provenance.txt`,
  [
    `head: ${sha}`,
    `tree: ${dirty ? 'DIRTY (uncommitted changes under src/ or examples/; do not hand over)' : 'clean'}`,
    `utc: ${new Date().toISOString()}`,
    `command: node --import ../qf-tools/register.mjs --experimental-strip-types examples/qf-curved-baseline/multi-run.ts`,
    `exit: 0 (written after the last render completed)`,
    `summary.json sha256: ${createHash('sha256').update(body).digest('hex')}`,
    '',
  ].join('\n'),
);
// biome-ignore lint/suspicious/noConsole: example script output
console.log(JSON.stringify(unified), rendered.value.views.length, 'views');
