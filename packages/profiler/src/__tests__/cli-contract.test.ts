import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runProfilerCli } from '../cli.js';

type CliResponse = Record<string, unknown>;

function readFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/profile-capture/${name}`, import.meta.url), 'utf8');
}

function readCliFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/cli/${name}`, import.meta.url), 'utf8');
}

function parseOutput(output: string): CliResponse {
  return JSON.parse(output) as CliResponse;
}

function expectJsonObject(output: string): CliResponse {
  const parsed = parseOutput(output);
  expect(parsed).toEqual(expect.any(Object));
  return parsed;
}

describe('profiler CLI structured output contract', () => {
  it('prints one machine-readable summary object by default', () => {
    const result = runProfilerCli([], readFixture('valid-complete.json'));
    const output = expectJsonObject(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(output).toMatchObject({
      query: 'summary',
      schemaVersion: '1.0',
      captureId: 'capture-0001',
      frameRange: { first: 1, last: 2 },
      completeness: { status: 'complete' },
    });
    expect(output.phases).toEqual(expect.any(Array));
  });

  it('returns a frame projection selected by frameId', () => {
    const result = runProfilerCli(['frame', '--frame-id', '2'], readFixture('valid-overflow.json'));
    const output = expectJsonObject(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(output).toMatchObject({
      query: 'frame',
      captureId: 'capture-0002',
      frameId: 2,
      completeness: {
        status: 'overflow',
        droppedEventCount: 7,
        firstAffectedFrameId: 2,
        lastAffectedFrameId: 4,
      },
      frame: null,
    });
  });

  it('returns a phase projection selected by source and phase', () => {
    const result = runProfilerCli(
      ['phase', '--source', 'render', '--phase', 'submit'],
      readFixture('valid-complete.json'),
    );
    const output = expectJsonObject(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(output).toMatchObject({
      query: 'phase',
      captureId: 'capture-0001',
      source: 'render',
      phase: 'submit',
      phaseSummary: {
        source: 'render',
        phase: 'submit',
        skipCount: 1,
      },
    });
  });

  it('accepts file input and preserves an empty capture status', () => {
    const result = runProfilerCli(
      [
        'summary',
        '--file',
        fileURLToPath(new URL('./fixtures/profile-capture/valid-complete.json', import.meta.url)),
      ],
      '',
    );
    const output = expectJsonObject(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(output.completeness).toMatchObject({ status: 'complete' });
  });

  it('writes one structured error object for an incompatible artifact', () => {
    const result = runProfilerCli(['summary'], readCliFixture('invalid-version.json'));
    const error = expectJsonObject(result.stderr);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(error).toMatchObject({
      error: {
        code: 'profile-artifact-incompatible',
        expected: expect.any(String),
        hint: expect.any(String),
        detail: expect.any(Object),
      },
    });
  });
});
