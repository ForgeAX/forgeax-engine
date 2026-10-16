// Regenerates the primaries-derived gamut constants in output-encoding.wgsl.
// SSOT: @forgeax/engine-math color.RGB_PRIMARIES -> render renderOutputGamutWgsl().
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OUTPUT_GAMUT_WGSL_BEGIN,
  OUTPUT_GAMUT_WGSL_END,
  renderOutputGamutWgsl,
} from '../../packages/render/src/output-color-space';

const path = resolve(import.meta.dir, '../../packages/shader/src/output-encoding.wgsl');
const source = readFileSync(path, 'utf8');
const begin = source.indexOf(OUTPUT_GAMUT_WGSL_BEGIN);
const end = source.indexOf(OUTPUT_GAMUT_WGSL_END);
if (begin < 0 || end < begin) {
  console.error(`output-encoding.wgsl lacks the ${OUTPUT_GAMUT_WGSL_BEGIN} markers`);
  process.exit(1);
}
const next = `${source.slice(0, begin)}${renderOutputGamutWgsl()}${source.slice(end + OUTPUT_GAMUT_WGSL_END.length)}`;
if (next !== source) writeFileSync(path, next);
console.log(next === source ? 'output gamut block up to date' : 'output gamut block regenerated');
