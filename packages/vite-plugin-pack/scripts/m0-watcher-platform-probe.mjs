import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-platform-probe-'));
const assets = join(root, 'assets');
const source = join(assets, 'probe.bin');
let nativeHints = 0;

try {
  await mkdir(assets);
  await writeFile(source, 'before');
  const watcher = watch(
    assets,
    process.platform === 'darwin' ? { recursive: true } : {},
    () => {
      nativeHints += 1;
    },
  );
  const before = await stat(source);
  await writeFile(source, 'after');
  const contents = await readFile(source, 'utf8');
  const after = await stat(source);
  const changed = before.mtimeMs !== after.mtimeMs || before.size !== after.size;
  watcher.close();
  const hintsAtClose = nativeHints;
  await writeFile(source, 'after-close');
  await new Promise((resolve) => setImmediate(resolve));
  const result = {
    platform: process.platform,
    node: process.version,
    nativeHints,
    nativeHintsBeforeClose: hintsAtClose,
    statChanged: changed,
    sourceAbsolute: source.startsWith('/'),
    sourceContents: contents,
    closeNoLateHint: nativeHints === hintsAtClose,
  };
  if (!result.statChanged || !result.sourceAbsolute || !result.closeNoLateHint) {
    throw new Error(`watcher probe invariant failed: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
