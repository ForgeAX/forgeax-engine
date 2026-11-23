import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/** The bootstrap face and all Unicode subsets share the installed font stylesheet. */
export async function emitNativeUiFonts(emit: (fileName: string, bytes: Uint8Array) => void) {
  const root = dirname(
    createRequire(import.meta.url).resolve('@fontsource-variable/noto-sans-sc/package.json'),
  );
  const subsets = (await readdir(resolve(root, 'files')))
    .filter((file) => file.endsWith('.woff2'))
    .map((file) => `files/${file}`);
  for (const file of ['LICENSE', 'index.css', ...subsets])
    emit(`ui-fonts/${file}`, await readFile(resolve(root, file)));
}
