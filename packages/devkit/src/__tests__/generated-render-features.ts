import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Include the actual generated realm factory in sliced Host execution fixtures. */
export async function generatedRenderFeatures(directory: string | undefined): Promise<string> {
  if (!directory) throw new Error('Generated Host directory is missing');
  return (await readFile(resolve(directory, 'game-render-features.ts'), 'utf8'))
    .replace(/^import type .*;\r?\n/gm, '')
    .replace('export function createGameRenderFeatures', 'function createGameRenderFeatures');
}
