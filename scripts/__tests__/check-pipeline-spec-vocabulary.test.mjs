// M7-T1-TEST -- self-test fixture for scripts/forgeax/check-pipeline-spec-vocabulary.mjs
//
// 3 lint gates (plan-strategy D-6 / requirements AC-04 / AC-05 / AC-06 / AC-07):
//
//   Gate A (createRenderPipeline\b allowlist):
//     allowed in: pipeline-spec.ts, mipmap-generator.ts, ibl/IblPipelineCache.ts
//     forbidden elsewhere in packages/runtime/src/
//
//   Gate B (beginRenderPass\b allowlist):
//     allowed in: record/main-pass.ts, record/shadow-pass.ts,
//                 record/skybox-post-pass.ts, mipmap-generator.ts,
//                 ibl/IblPipelineCache.ts
//     forbidden elsewhere in packages/runtime/src/
//
//   Gate C (materialShaderPipelineCacheKey 0 hit):
//     forbidden anywhere in packages/runtime/src/ (M2-T2 supersedes via cacheKeyOf)
//
// Reference:
//   - plan-strategy section 2 D-6 (custom mjs lint helper; biome cannot
//     express the allowlist exclusion)
//   - plan-strategy section 7 M7 (3 lint gates A/B/C)
//   - plan-tasks.json M7-T1 description
//
// The script is invoked with `--root <fixture>` (CLI flag mirroring
// check-image-pipeline-isolation.mjs / check-concern-reverse-coupling.mjs).

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const scriptPath = resolve(repoRoot, 'scripts/forgeax/check-pipeline-spec-vocabulary.mjs');
const fixturesDir = resolve(here, 'check-pipeline-spec-vocabulary.fixtures');

function run(root) {
  const r = spawnSync('node', [scriptPath, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

describe('check-pipeline-spec-vocabulary -- 3 lint gates A/B/C', () => {
  it('Case (a): clean tree (allowlist-only hits) -- exits 0', () => {
    const r = run(resolve(fixturesDir, 'clean-tree'));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK/);
  });

  it('Case (b): inject createRenderPipeline into createRenderer.ts -- Gate A fails (exit 1)', () => {
    const r = run(resolve(fixturesDir, 'gate-a-violation-create-render-pipeline'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Gate A/);
    expect(r.stderr).toMatch(/createRenderPipeline/);
    expect(r.stderr).toMatch(/createRenderer\.ts/);
  });

  it('Case (c): residual materialShaderPipelineCacheKey -- Gate C fails (exit 1)', () => {
    const r = run(resolve(fixturesDir, 'gate-c-violation-cache-key'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Gate C/);
    expect(r.stderr).toMatch(/materialShaderPipelineCacheKey/);
  });

  it('Case (d): beginRenderPass in non-allowlisted file -- Gate B fails (exit 1)', () => {
    const r = run(resolve(fixturesDir, 'gate-b-violation-begin-render-pass'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Gate B/);
    expect(r.stderr).toMatch(/beginRenderPass/);
  });
});
