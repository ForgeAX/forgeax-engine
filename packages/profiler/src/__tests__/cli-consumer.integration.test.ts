import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
const smokePath = fileURLToPath(new URL('../../scripts/consume-smoke.mjs', import.meta.url));
const fixtureRoot = new URL('./fixtures/cli/', import.meta.url);

function runCli(args: readonly string[], input = '') {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    input,
    encoding: 'utf8',
  });
}

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, fixtureRoot)), 'utf8');
}

function runSummaryForFixture(name: string) {
  const fixturePath = fileURLToPath(new URL(name, fixtureRoot));
  return runCli(['summary', '--file', fixturePath]);
}

function parseObject(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

describe('profiler CLI consumer smoke', () => {
  it('preserves completeness states through the built public CLI', () => {
    const complete = runSummaryForFixture('valid-capture.json');
    const partial = runSummaryForFixture('partial-capture.json');
    const overflow = runSummaryForFixture('../profile-capture/valid-overflow.json');
    const empty = runCli(
      ['summary'],
      JSON.stringify({
        schemaVersion: '1.0',
        captureId: 'capture-0044',
        timeUnit: 'microseconds',
        frameLimit: 1,
        eventLimit: 1,
        phaseCatalog: { app: ['input'], render: ['submit'] },
        records: [],
        completeness: {
          status: 'partial',
          retainedEventCount: 0,
          droppedEventCount: 0,
          incompleteReason: 'stopped-before-frame',
        },
      }),
    );

    expect(complete.status).toBe(0);
    expect(parseObject(complete.stdout).completeness).toMatchObject({ status: 'complete' });
    expect(partial.status).toBe(0);
    expect(parseObject(partial.stdout).completeness).toMatchObject({
      status: 'partial',
      incompleteReason: 'stopped-during-frame',
    });
    expect(overflow.status).toBe(0);
    expect(parseObject(overflow.stdout).completeness).toMatchObject({
      status: 'overflow',
      droppedEventCount: 7,
    });
    expect(empty.status).toBe(0);
    expect(parseObject(empty.stdout)).toMatchObject({
      captureId: 'capture-0044',
      frameCount: 0,
      frameRange: null,
      completeness: { status: 'partial' },
    });
  });

  it('keeps incompatible artifacts on stderr and repeats deterministically', () => {
    const input = readFixture('valid-capture.json');
    const first = runCli(['summary'], input);
    const second = runCli(['summary'], input);
    const invalid = runSummaryForFixture('invalid-version.json');

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stderr).toBe('');
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout).toBe('');
    expect(parseObject(invalid.stderr)).toEqual({
      error: {
        code: 'profile-artifact-incompatible',
        expected: expect.any(String),
        hint: expect.any(String),
        detail: expect.any(Object),
      },
    });
  });

  it('runs the package consumer smoke through the public CLI entry', () => {
    const result = spawnSync(process.execPath, [smokePath], {
      cwd: packageRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseObject(result.stdout)).toMatchObject({
      query: 'summary',
      captureId: 'capture-0010',
      completeness: { status: 'overflow' },
    });
  });
});
