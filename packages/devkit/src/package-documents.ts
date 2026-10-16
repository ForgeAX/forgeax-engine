import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ZipEntry } from './archive.js';
import type { CommandResult } from './types.js';

export const GAME_PACKAGE_DOCUMENT_PATHS = Object.freeze([
  'README.md',
  'docs/feedback.md',
] as const);

export async function readGamePackageDocuments(
  root: string,
): Promise<CommandResult<readonly ZipEntry[]>> {
  const entries: ZipEntry[] = [];
  for (const path of GAME_PACKAGE_DOCUMENT_PATHS) {
    try {
      entries.push({ path, bytes: await readFile(resolve(root, path)) });
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'game-package-document-missing',
          expected: 'the game to contain README.md and docs/feedback.md',
          hint: 'Restore README.md and docs/feedback.md before creating a Web ZIP.',
          detail: {
            root,
            path,
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        },
      };
    }
  }
  return { ok: true, value: entries };
}
