import { afterEach, expect, it, vi } from 'vitest';
import { compileMaterialSources } from '../engine-inputs/compile-material-sources.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('retains real Worker results with optional phase metadata and closes the batch', async () => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '2');
  vi.stubEnv('FORGEAX_SHADER_COMPILE_DIAGNOSTICS', '1');
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const results = await compileMaterialSources(
    [0, 1].map((id) => ({
      file: {
        id: 'diagnostic-worker-family',
        source: `@compute @workgroup_size(1) fn job${id}() {}`,
      },
      defines: undefined,
      options: { id: `diagnostic-worker-${id}` },
    })),
    {},
  );
  expect(results).toHaveLength(2);
  for (const [index, result] of results.entries()) {
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.wgsl).toContain(`fn job${index}`);
      expect(result.value.manifestEntry.wgsl).toBe(result.value.wgsl);
    }
  }
  const end = JSON.parse(String(output.mock.calls.at(-1)?.[0]).split('] ')[1] ?? '{}');
  expect(end).toMatchObject({ event: 'end', total: 2, submitted: 2, completed: 2, active: [] });
  expect(end.preparationWallMs).toBeGreaterThanOrEqual(0);
  expect(end.compileWallMs).toBeGreaterThan(0);
  expect(output.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('@compute');
});
