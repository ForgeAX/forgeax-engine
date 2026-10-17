import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const live = vi.hoisted(() => vi.fn());
vi.mock('../live-dev.js', () => ({ liveDevControl: live }));

import { exportPipelineLibrary } from '../pipeline-library-export';

it('exports the revision-fenced renderer recipe and a matching digest receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-export-'));
  const manifest = {
    version: 1,
    backend: 'webgpu',
    shaders: [],
    bindGroupLayouts: [],
    pipelineLayouts: [],
    renderPipelines: [],
    computePipelines: [],
  };
  try {
    live.mockResolvedValueOnce({
      ok: true,
      value: {
        revision: 'current',
        result: { ok: true, value: { manifest, inspection: { shaders: 0 }, frame: 12 } },
      },
    });
    const result = await exportPipelineLibrary(root, { revision: 'current' });
    expect(live).toHaveBeenLastCalledWith(
      root,
      'eval',
      expect.objectContaining({
        revision: 'current',
        code: expect.stringContaining('execution.inspectRenderer({pipelineLibrary:true})'),
      }),
    );
    expect(result.ok).toBe(true);
    const bytes = await readFile(join(root, '.forgeax/pipeline-library.json'));
    const receipt = JSON.parse(
      await readFile(join(root, '.forgeax/pipeline-library.json.receipt.json'), 'utf8'),
    );
    expect(JSON.parse(bytes.toString())).toEqual(manifest);
    expect(receipt).toMatchObject({
      revision: 'current',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      frame: 12,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('retains live and incomplete-export failures without publishing a partial manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-export-'));
  try {
    const stale = { ok: false, error: { code: 'stale-revision', hint: 'refresh' } };
    live.mockResolvedValueOnce(stale);
    expect(await exportPipelineLibrary(root, { revision: 'old' })).toEqual(stale);
    live.mockResolvedValueOnce({
      ok: true,
      value: { revision: 'current', result: { ok: false, error: 'unrecordable dependency' } },
    });
    expect(await exportPipelineLibrary(root, { revision: 'current' })).toMatchObject({
      ok: false,
      error: { detail: 'unrecordable dependency' },
    });
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
