// Merge several matrix.json files (separate matrix.mjs invocations) into one Markdown report.
//   node matrix-report.mjs OUT.md MATRIX_DIR...
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { markdown } from './matrix-summary.mjs';

const [out, ...dirs] = process.argv.slice(2);
assert(out && dirs.length, 'matrix-report.mjs OUT.md MATRIX_DIR...');
const rows = [];
for (const dir of dirs) rows.push(...JSON.parse(await readFile(resolve(dir, 'matrix.json'), 'utf8')).rows);
const order = [...new Set(rows.map(r => r.cell))];
rows.sort((a, b) => order.indexOf(a.cell) - order.indexOf(b.cell) || a.count - b.count);
await writeFile(out, markdown(rows, { title: 'Scenario matrix (merged)', notes: [`merged from ${dirs.join(', ')}; diagnostic only`] }), { flag: 'wx' });
console.log(out);
