import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readCliInput, runProfilerCli } from '../cli.js';

function expectStructuredError(
  result: { stdout: string; stderr: string; exitCode: number },
  code: string,
): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe('');
  const parsed = JSON.parse(result.stderr) as {
    error?: { code?: string; expected?: string; hint?: string; detail?: unknown };
  };
  expect(parsed).toEqual({
    error: {
      code,
      expected: expect.any(String),
      hint: expect.any(String),
      detail: expect.anything(),
    },
  });
}

function expectStructuredErrorWithSide(
  result: { stdout: string; stderr: string; exitCode: number },
  code: string,
  side: 'left' | 'right',
): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr)).toEqual({
    error: {
      code,
      expected: expect.any(String),
      hint: expect.any(String),
      detail: {
        side,
        ...(code === 'cli-input-file-read-failed' ? { path: expect.any(String) } : {}),
        message: expect.any(String),
      },
    },
  });
}

describe('profiler CLI input error contract', () => {
  it('does not read stdin when a file input is selected', () => {
    expect(
      readCliInput(['summary', '--file', 'capture.json'], () => {
        throw new Error('stdin read');
      }),
    ).toBe('');
  });

  it('reads stdin when no file input is selected', () => {
    expect(readCliInput(['summary'], () => 'capture')).toBe('capture');
  });

  it('rejects empty stdin without producing a summary', () => {
    expectStructuredError(runProfilerCli(['summary'], ''), 'cli-input-empty');
  });

  it('rejects malformed JSON from stdin', () => {
    expectStructuredError(
      runProfilerCli(['summary'], '{"schemaVersion":'),
      'cli-input-invalid-json',
    );
  });

  it('rejects a missing file before model analysis', () => {
    expectStructuredError(
      runProfilerCli(['summary', '--file', '/tmp/forgeax-profiler-missing-capture.json'], ''),
      'cli-input-file-read-failed',
    );
  });

  it('rejects schema-invalid JSON as a structured artifact error', () => {
    expectStructuredError(
      runProfilerCli(['summary'], '{"schemaVersion":"1.0"}'),
      'profile-artifact-invalid',
    );
  });

  it('rejects unsupported artifact versions without guessing fields', () => {
    expectStructuredError(
      runProfilerCli(
        ['summary'],
        JSON.stringify({
          schemaVersion: '9.0',
          captureId: 'capture-0001',
          timeUnit: 'microseconds',
          frameLimit: 1,
          eventLimit: 1,
          phaseCatalog: { app: [], render: [] },
          records: [],
          completeness: { status: 'partial', retainedEventCount: 0, droppedEventCount: 0 },
        }),
      ),
      'profile-artifact-incompatible',
    );
  });

  it('rejects non-positive and unsafe frame identifiers', () => {
    const input = JSON.stringify({
      schemaVersion: '1.0',
      captureId: 'capture-0001',
      timeUnit: 'microseconds',
      frameLimit: 1,
      eventLimit: 1,
      phaseCatalog: { app: ['input'], render: [] },
      records: [],
      completeness: { status: 'partial', retainedEventCount: 0, droppedEventCount: 0 },
    });

    expectStructuredError(runProfilerCli(['frame', '--frame-id', '0'], input), 'cli-query-invalid');
    expectStructuredError(
      runProfilerCli(['frame', '--frame-id', '9007199254740992'], input),
      'cli-query-invalid',
    );
  });

  it('rejects unknown flags and missing phase selectors', () => {
    const input = JSON.stringify({
      schemaVersion: '1.0',
      captureId: 'capture-0001',
      timeUnit: 'microseconds',
      frameLimit: 1,
      eventLimit: 1,
      phaseCatalog: { app: ['input'], render: [] },
      records: [],
      completeness: { status: 'partial', retainedEventCount: 0, droppedEventCount: 0 },
    });

    expectStructuredError(runProfilerCli(['summary', '--unknown'], input), 'cli-arguments-invalid');
    expectStructuredError(
      runProfilerCli(['phase', '--source', 'app'], input),
      'cli-arguments-invalid',
    );
  });

  it('requires two file inputs for compare and does not consume stdin', () => {
    expect(
      readCliInput(['compare', '--left-file', 'left.json', '--right-file', 'right.json'], () => {
        throw new Error('stdin read');
      }),
    ).toBe('');
    expectStructuredError(
      runProfilerCli(['compare', '--left-file', 'left.json'], ''),
      'cli-arguments-invalid',
    );
    expectStructuredError(
      runProfilerCli(['summary', '--left-file', 'left.json', '--right-file', 'right.json'], '{}'),
      'cli-arguments-invalid',
    );
  });

  it('attributes unreadable compare files independently', () => {
    const validPath = fileURLToPath(new URL('./fixtures/cli/valid-capture.json', import.meta.url));
    const missingLeftPath = '/tmp/forgeax-profiler-missing-left-capture.json';
    const missingRightPath = '/tmp/forgeax-profiler-missing-right-capture.json';
    expectStructuredErrorWithSide(
      runProfilerCli(['compare', '--left-file', missingLeftPath, '--right-file', validPath], ''),
      'cli-input-file-read-failed',
      'left',
    );
    expectStructuredErrorWithSide(
      runProfilerCli(['compare', '--left-file', validPath, '--right-file', missingRightPath], ''),
      'cli-input-file-read-failed',
      'right',
    );
  });
});
