import { describe, expect, it } from 'vitest';
import { executeScript } from '../execute';
import { buildIntrospectDoc } from '../introspect';

describe('execution report structural root', () => {
  const execution = {
    report: () => ({ workers: { kernels: { enabled: true } }, world: { health: 'healthy' } }),
  };

  it('is available to eval without importing the App owner', async () => {
    const result = await executeScript('execution.report().workers.kernels.enabled', {
      world: {},
      renderer: {},
      assets: {},
      execution,
    });
    expect(result).toEqual({ ok: true, value: true });
  });

  it('projects the provider without adding an RPC method', () => {
    const document = buildIntrospectDoc('127.0.0.1', 5732, {
      world: {},
      renderer: {},
      assets: {},
      execution,
    }) as {
      methods: Array<{ name: string }>;
      roots: Record<string, { type: string; capability?: string }>;
    };
    expect(document.methods.map((method) => method.name)).toEqual(['eval', 'introspect']);
    expect(document.roots.execution).toEqual(
      expect.objectContaining({
        type: 'ExecutionReportProvider',
        capability: 'execution-report-v1',
      }),
    );
  });
});
