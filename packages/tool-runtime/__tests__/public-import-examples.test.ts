import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('tool runtime public import boundary', () => {
  it('exports portable contracts without engine live-resource imports', async () => {
    const source = await readFile(resolve(packageRoot, 'src/index.ts'), 'utf8');

    expect(source).toContain("from './types.js'");
    expect(source).toContain('ToolPreviewContract');
    expect(source).toContain('ToolCleanupCensus');
    expect(source).not.toMatch(/from ['"]@forgeax\/engine-(render|ecs|rhi)/);
    expect(source).not.toMatch(/World|Renderer|HTMLCanvasElement|GPUDevice/);
  });

  it('keeps public terminal values limited to serializable result and ArtifactRef data', async () => {
    const source = await readFile(resolve(packageRoot, 'src/types.ts'), 'utf8');

    expect(source).toContain('readonly artifacts: readonly ArtifactRef[]');
    expect(source).toContain('readonly cleanup?: ToolCleanupReport');
    expect(source).not.toMatch(/readonly (world|renderer|canvas|toolRun|liveHandle)\??:/i);
  });
});
