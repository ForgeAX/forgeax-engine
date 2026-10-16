// @perf-budget-skip: intentional documentation subprocess gate.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const docsGate = resolve(repoRoot, 'scripts/forgeax/check-token-first-docs.mjs');

function runDocsGate(): { readonly status: number; readonly output: string } {
  try {
    const output = execFileSync(process.execPath, [docsGate], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error: unknown) {
    const result = error as {
      readonly status?: number;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  }
}

describe('M5 active-documentation token-first gate', () => {
  it('keeps the engine-owned active documentation surface present', () => {
    for (const path of [
      'packages/ecs/README.md',
      'packages/app/README.md',
      'packages/audio-webaudio/README.md',
      'packages/input/README.md',
      'packages/runtime/README.md',
      'packages/state/README.md',
      'skills/forgeax-engine-ecs/SKILL.md',
      'skills/forgeax-engine-app/SKILL.md',
      'skills/forgeax-engine-audio/SKILL.md',
      'skills/forgeax-engine-state/SKILL.md',
      'apps/hello/sprite-atlas/README.md',
      'apps/learn-render/1.getting-started/5.transformations/README.md',
      'apps/learn-render/1.getting-started/7.camera/README.md',
      'apps/learn-render/2.lighting/3.materials/README.md',
      'packages/ecs/CHANGELOG.md',
    ]) {
      expect(existsSync(resolve(repoRoot, path)), path).toBe(true);
    }
  });

  it('accepts only token-first registration and explicit-delta update examples', () => {
    const result = runDocsGate();
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('Active-documentation token-first gate passed');
  });

  it('keeps the M3 recovery contracts discoverable from the owner READMEs', () => {
    const appReadme = readFileSync(resolve(repoRoot, 'packages/app/README.md'), 'utf8');
    const inputReadme = readFileSync(resolve(repoRoot, 'packages/input/README.md'), 'utf8');
    expect(appReadme).toContain('report.frame');
    expect(appReadme).toContain('inFlight = submitted - completed');
    expect(inputReadme).toContain('InputSnapshot');
    expect(inputReadme).toContain('onLockError');
    expect(inputReadme).toContain('document.hasFocus()');
  });
});
