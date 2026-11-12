import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = join(root, 'scripts/ci/webgpu-compatibility-surface.json');
const ignored = new Set([
  'node_modules',
  'dist',
  '__tests__',
  'bench',
  'migrations',
  'vendor',
  '.git',
]);
const nativeToken =
  /\b(?:GPU[A-Z]\w*|navigator\.gpu|gpu\.requestAdapter|webgpu|WGSL)\b|@(?:builtin|group|compute|fragment|vertex)\s*\(/i;
const owners = /^packages\/(?:rhi(?:-[^/]+)?|wgpu-wasm)\/src\//;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Content review tripwire, not a claim of dataflow completeness or device certification. */
export function collectSurface(directory) {
  const files = {};
  // Use Engine's Git authority: no ignored build trees or materialized gitlink contents.
  // Untracked, non-ignored source is included so a new bypass is caught before staging.
  const paths = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      'packages',
      'apps',
      'templates',
    ],
    { cwd: directory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  ).split('\0');
  for (const name of paths) {
    if (
      !/\.(?:[cm]?[jt]sx?|wgsl|rs)$/.test(name) ||
      /\.(?:test|fixture)\./.test(name) ||
      name.endsWith('/stub.ts') ||
      name.split('/').some((part) => ignored.has(part))
    )
      continue;
    const full = join(directory, name);
    if (!existsSync(full)) continue;
    const bytes = readFileSync(full);
    if (owners.test(name) || name.endsWith('.wgsl') || nativeToken.test(bytes.toString('utf8')))
      files[name] = hash(bytes);
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

export function surfaceChanges(expected, actual) {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort().flatMap((name) =>
    expected[name] === actual[name]
      ? []
      : [
          {
            file: name,
            change:
              expected[name] === undefined
                ? 'added'
                : actual[name] === undefined
                  ? 'removed'
                  : 'changed',
          },
        ],
  );
}

function typesIdentity() {
  const base = join(root, 'packages/rhi/node_modules/@webgpu/types');
  return {
    version: JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')).version,
    sha256: hash(readFileSync(join(base, 'dist/index.d.ts'))),
  };
}

function sourcePins() {
  return Object.fromEntries(
    execFileSync('git', ['ls-files', '--stage'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\n')
      .filter((line) => line.startsWith('160000 '))
      .map((line) => {
        const [metadata, path] = line.split('\t');
        return [path, metadata.split(' ')[1]];
      }),
  );
}

function main() {
  const files = collectSurface(root);
  const types = typesIdentity();
  const pins = sourcePins();
  if (process.argv[2] === '--update') {
    const reason = process.argv[3]?.trim();
    if (process.argv.length !== 4 || !reason || reason.length < 20)
      throw new Error(
        'Update requires a concrete review reason (20+ characters); review all changed inputs and the compatibility policy first.',
      );
    writeFileSync(
      baseline,
      `${JSON.stringify({ schemaVersion: 1, reviewReason: reason, types, pins, files }, null, 2)}\n`,
    );
    console.log(
      `Recorded ${Object.keys(files).length} compatibility candidate files; this does not certify their semantics.`,
    );
    return;
  }
  if (process.argv.length !== 2)
    throw new Error(
      'usage: node scripts/ci/check-webgpu-compatibility.mjs [--update "review reason"]',
    );
  const expected = JSON.parse(readFileSync(baseline, 'utf8'));
  if (expected.schemaVersion !== 1) throw new Error('Unknown compatibility surface schema');
  if (JSON.stringify(expected.pins) !== JSON.stringify(pins))
    throw new Error(
      'Pinned source gitlinks changed: review their GPU/WGSL boundary changes and update the compatibility baseline.',
    );
  const changes = surfaceChanges(expected.files, files);
  if (JSON.stringify(expected.types) !== JSON.stringify(types))
    changes.unshift({ file: '@webgpu/types', change: 'changed' });
  if (changes.length)
    throw new Error(
      `Compatibility review required (${changes.length} inputs):\n${changes.map(({ file, change }) => `${change}: ${file}`).join('\n')}\nReview overloads, units/defaults, descriptors/enums, features/limits, WGSL and recording/replay. Add owning runtime evidence where semantics change; then explicitly update this baseline in the same PR. CI never updates it.`,
    );
  console.log(
    `WebGPU compatibility surface unchanged: ${Object.keys(files).length} candidate files, @webgpu/types ${types.version}. Semantic and GPU gates remain required.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
