import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolRuntime } from '@forgeax/engine-tool-runtime';
import { describe, expect, it } from 'vitest';
import { createPreviewContributions } from '../preview-contributions.js';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(toolsDir, '..');

describe('preview owner gate', () => {
  it('does not expose a generic asset.preview dispatcher or legacy preview alias', async () => {
    const [catalog, contributions, previewContributions] = await Promise.all([
      readFile(resolve(sourceRoot, 'catalog.ts'), 'utf8'),
      readFile(resolve(sourceRoot, 'contributions.ts'), 'utf8'),
      readFile(resolve(sourceRoot, 'preview-contributions.ts'), 'utf8'),
    ]);
    const source = `${catalog}\n${contributions}\n${previewContributions}`;

    expect(source).not.toMatch(/asset\.preview/);
    expect(source).not.toMatch(/PreviewSpec|previewRegistry|previewDispatcher/);
    expect(source).not.toMatch(/legacy.*preview|preview.*legacy/i);
  });

  it('keeps the descriptor and executor paired at the contribution boundary', async () => {
    const source = await readFile(resolve(sourceRoot, 'contributions.ts'), 'utf8');

    expect(source).toContain('defineTool(');
    expect(source).toContain('createPreviewContributions');
    expect(source).not.toContain('new ToolRegistry');
    expect(source).not.toContain('new PreviewRegistry');
  });

  it('turns the retired generic preview contribution into an explicit migration error', async () => {
    const contribution = createPreviewContributions()[0];
    if (contribution === undefined) throw new Error('preview contribution missing');
    const terminal = await createToolRuntime([contribution]).run(contribution, { recipe: {} })
      .terminal;
    expect(terminal).toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-domain-failed', detail: { code: 'preview-operation-migrated' } },
    });
  });
});
