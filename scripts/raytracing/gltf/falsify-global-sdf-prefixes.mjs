import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2),
  captured = args[0] === '--capture';
const [input, frozen, section, outputArg, selected, factor = '1'] = captured
  ? [args[1], args[3], args[2], args[4], args[5]]
  : args;
assert(
  input &&
    frozen &&
    (captured ? /^\d+$/.test(section) : /^[a-z0-9-]+$/.test(section)) &&
    outputArg &&
    selected,
);
const output = resolve(outputArg);
await mkdir(output);
let rays;
if (captured) rays = (await readFile(`${frozen}-rays.bin`)).length / 48;
else {
  const manifest = JSON.parse(await readFile(resolve(input, 'composition.json'), 'utf8'));
  const row = manifest.cases.find((r) => r.name === section);
  rays = JSON.parse(await readFile(resolve(input, row.queryFile), 'utf8')).rays.length;
}
const observed = selected.split(',').map(Number);
const unobserved = Array.from({ length: rays }, (_, i) => i).find((i) => !observed.includes(i));
assert(unobserved !== undefined, 'requires a non-selected ray to test whole-cohort admission');
const results = [];
const cases = captured
  ? [
      ['voxels', 'voxels', 0, 'captured voxels differs from frozen resource'],
      ['unselected-ray', 'hits', unobserved * 64 + 8, 'captured hits differs from frozen resource'],
    ]
  : [
      ['composition', `${section}.bin`, 0, 'original composition differs'],
      [
        'unselected-ray',
        `${section}-query.bin`,
        unobserved * 64 + 8,
        'original full-cohort query differs',
      ],
    ];
for (const [name, file, offset, expected] of cases) {
  const changed = resolve(output, `${name}-frozen`),
    capture = resolve(output, name);
  await mkdir(changed);
  const prefix = resolve(changed, 'query');
  for (const f of captured
    ? ['voxels', 'grid', 'rays', 'hits']
    : [`${section}.bin`, `${section}-query.bin`])
    await copyFile(
      captured ? `${frozen}-${f}.bin` : resolve(frozen, f),
      captured ? `${prefix}-${f}.bin` : resolve(changed, f),
    );
  const path = captured ? `${prefix}-${file}.bin` : resolve(changed, file);
  const bytes = await readFile(path);
  bytes[offset] ^= 1;
  await writeFile(path, bytes);
  const run = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./trace-global-sdf-prefixes.mjs', import.meta.url)),
      ...(captured
        ? ['--capture', input, section, prefix, capture, selected]
        : [input, changed, section, capture, selected, factor]),
    ],
    { encoding: 'utf8', timeout: captured ? 600000 : 180000, maxBuffer: 4 * 1024 * 1024 },
  );
  await writeFile(resolve(output, `${name}.log`), `${run.stdout ?? ''}\n${run.stderr ?? ''}`);
  assert(!run.error && run.status !== 0, `${name} did not fail normally`);
  const failure = JSON.parse(await readFile(resolve(capture, 'failure.json'), 'utf8'));
  assert(failure.message.includes(expected), `${name}: ${failure.message}`);
  results.push({
    name,
    expected,
    rejected: true,
    ...(name === 'unselected-ray' ? { unobserved } : {}),
  });
}
await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
