import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, basename } from 'node:path';

/** An explicit local runtime makes an ECharts report self-contained without a CDN. */
export async function loadEchartsRuntime(path) {
  if (!path) throw Error('ECharts HTML requires --echarts-js /absolute/path/to/echarts.min.js');
  const bytes = await readFile(path);
  const assetDir = dirname(path);
  const packageDir = basename(assetDir) === 'dist' ? dirname(assetDir) : assetDir;
  const [license, notice] = await Promise.all(
    ['LICENSE', 'NOTICE'].map((name) => readFile(join(packageDir, name), 'utf8')),
  );
  if (!bytes.length) throw Error('Empty ECharts runtime');
  return {
    notices: license + '\n' + notice,
    dataUrl: 'data:application/javascript;base64,' + bytes.toString('base64'),
    receipt: {
      path: resolve(path),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    },
  };
}
