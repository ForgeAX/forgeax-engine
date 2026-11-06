import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(packageRoot, 'pkg/wgpu_wasm.js');
const destination = resolve(packageRoot, 'dist/wgpu_wasm_glue.bytes');

export async function prepareBrowserGlueAsset(
  sourcePath = source,
  destinationPath = destination,
) {
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  await prepareBrowserGlueAsset();
}
