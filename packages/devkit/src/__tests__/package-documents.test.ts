import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createZip } from '../archive.js';
import { GAME_PACKAGE_DOCUMENT_PATHS, readGamePackageDocuments } from '../package-documents.js';

describe('game package documents', () => {
  it('reads the required project documents as ZIP entries', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-package-documents-'));
    try {
      await mkdir(resolve(root, 'docs'));
      await writeFile(resolve(root, 'README.md'), '# Test game\n');
      await writeFile(resolve(root, 'docs/feedback.md'), '# Feedback\n');

      const result = await readGamePackageDocuments(root);

      expect(result).toEqual({
        ok: true,
        value: [
          { path: 'README.md', bytes: Buffer.from('# Test game\n') },
          { path: 'docs/feedback.md', bytes: Buffer.from('# Feedback\n') },
        ],
      });
      if (!result.ok) return;
      const archive = createZip(result.value);
      expect(archive.includes(Buffer.from('README.md'))).toBe(true);
      expect(archive.includes(Buffer.from('docs/feedback.md'))).toBe(true);
      expect(await readFile(resolve(root, GAME_PACKAGE_DOCUMENT_PATHS[0]), 'utf8')).toBe(
        '# Test game\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a structured error when a required document is absent', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-package-documents-'));
    try {
      await writeFile(resolve(root, 'README.md'), '# Test game\n');

      await expect(readGamePackageDocuments(root)).resolves.toEqual({
        ok: false,
        error: expect.objectContaining({
          code: 'game-package-document-missing',
          detail: expect.objectContaining({ path: 'docs/feedback.md' }),
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
