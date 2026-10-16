import { describe, expect, it } from 'vitest';
import { recordSnakeBrowserError, type SnakeDiagnosticsTarget } from '../browser-diagnostics';

describe('Snake browser diagnostics', () => {
  it('retains the trusted JSON state while publishing structured browser errors', () => {
    const state: SnakeDiagnosticsTarget & { textContent: string } = {
      dataset: {},
      textContent: '{"tick":51}',
    };
    const trustedState = state.textContent;
    const status = { textContent: 'Round in progress' };
    const errors: string[] = [];
    recordSnakeBrowserError(state, status, errors, {
      message: 'device lost',
      code: 'device-lost',
      hint: 'recreate the renderer',
      detail: { source: 'test' },
    });
    expect(state.textContent).toBe(trustedState);
    expect(state.dataset).toMatchObject({
      appErrorCode: 'device-lost',
      appErrorHint: 'recreate the renderer',
      appErrorDetail: '{"source":"test"}',
      lifecycle: 'error',
    });
    expect(JSON.parse(state.dataset.appErrorTail ?? '[]')).toEqual(['device lost']);
    expect(status.textContent).toContain('device-lost');
  });
});
