import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('focused preview package owner gate', () => {
  it('does not introduce a second registry, executor, or ToolRun owner', async () => {
    const files = ['host.ts', 'index.ts'];
    const source = await Promise.all(
      files.map((file) => readFile(resolve(sourceRoot, file), 'utf8')),
    ).then((parts) => parts.join('\n'));

    expect(source).not.toMatch(/asset\.preview/);
    expect(source).not.toMatch(/PreviewSpec|previewRegistry|ToolRun|ToolRuntime/);
    expect(source).not.toMatch(/new (World|Renderer|AssetRegistry)/);
  });

  it('keeps the public host surface limited to typed POD actions', async () => {
    const source = await readFile(resolve(sourceRoot, 'host.ts'), 'utf8');

    expect(source).toContain('loadAsset');
    expect(source).toContain('capture');
    expect(source).toContain('dispose');
    expect(source).not.toMatch(/readonly (world|renderer|canvas|liveHandle)\??:/i);
  });
});
