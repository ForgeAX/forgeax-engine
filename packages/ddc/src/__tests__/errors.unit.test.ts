import { describe, expect, it } from 'vitest';
import { DDC_ERROR_CODES, DdcStoreError } from '../errors.js';

describe('DDC closed errors', () => {
  it('exposes the complete closed conflict/configuration code union', () => {
    expect(DDC_ERROR_CODES).toEqual([
      'ddc-project-root-required',
      'ddc-object-conflict',
      'ddc-head-conflict',
      'ddc-generation-conflict',
      'ddc-scope-mismatch',
      'ddc-lease-expired',
    ]);
  });

  it('keeps structured recovery fields and redacts host paths for browser consumers', () => {
    const error = new DdcStoreError({
      code: 'ddc-scope-mismatch',
      detail: 'scope metadata does not match the requested scope',
      hint: 'reinspect the canonical project root and allocate a new scope',
      expected: { scopeId: 'editor/main' },
      actual: { scopeId: 'editor_main' },
      owner: 'engine-ddc',
      rootKind: 'project-ddc',
      scope: 'editor/main',
      generation: 7,
      lease: 'lease-7',
      revision: 3,
      recoveryActions: [
        { kind: 'inspect', executable: true },
        { kind: 'allocate-generation', executable: true },
      ],
      hostPath: '/Users/test/game/.forgeax/ddc/v2/scope.json',
    });

    expect(error).toMatchObject({
      code: 'ddc-scope-mismatch',
      expected: { scopeId: 'editor/main' },
      actual: { scopeId: 'editor_main' },
      owner: 'engine-ddc',
      rootKind: 'project-ddc',
      scope: 'editor/main',
      generation: 7,
      lease: 'lease-7',
      revision: 3,
      recoveryActions: [
        { kind: 'inspect', executable: true },
        { kind: 'allocate-generation', executable: true },
      ],
    });
    expect(error.toBrowserProjection()).not.toHaveProperty('hostPath');
    expect(JSON.stringify(error.toBrowserProjection())).not.toContain('/Users/test');
  });
});
