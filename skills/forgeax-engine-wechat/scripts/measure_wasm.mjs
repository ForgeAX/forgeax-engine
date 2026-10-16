import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const paths = process.argv.slice(2);
if (paths.length === 0 || paths.includes('--help')) {
  process.stdout.write(
    'Usage: node measure_wasm.mjs FILE.wasm [OTHER.wasm ...]\nMeasures raw, gzip-9 and Brotli-11 bytes with SHA-256. Does not alter inputs.\n',
  );
  process.exit(paths.length === 0 ? 1 : 0);
}
const files = [];
for (const path of paths) {
  const bytes = await readFile(path);
  if (!bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
    throw new TypeError(`${path}: expected a WebAssembly version 1 binary`);
  const gzipBytes = (await promisify(gzip)(bytes, { level: 9 })).length;
  const brotliBytes = (
    await promisify(brotliCompress)(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    })
  ).length;
  files.push({
    path: resolve(path),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizes: Object.fromEntries(
      Object.entries({ raw: bytes.length, 'gzip-9': gzipBytes, 'brotli-11': brotliBytes }).map(
        ([name, size]) => [name, { bytes: size, MB: size / 1e6, MiB: size / 1048576 }],
      ),
    ),
  });
}
process.stdout.write(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      scope:
        'Supplied WASM files only; excludes JS, fonts, images and other project assets. Compression measurements are not WeChat package admission.',
      files,
    },
    null,
    2,
  ) + '\n',
);
