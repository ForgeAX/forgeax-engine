import { describe, expect, it } from 'vitest';
import { DDC_ERROR_CODES, DdcStoreError } from '../errors.js';
import { projectDdcStatusForBrowser } from '../status.js';

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

it('projects one recovery action through both error and status without its host target', () => {
  const recoveryActions = [
    {
      kind: 'release-lease' as const,
      executable: true,
      exactTarget: '/host/lease',
      reason: 'expired',
    },
  ];
  const error = new DdcStoreError({
    code: 'ddc-lease-expired',
    detail: 'expired',
    recoveryActions,
  });
  const status = projectDdcStatusForBrowser({
    schemaVersion: 'forgeax-ddc-status/v2',
    health: 'blocked',
    layers: [
      {
        kind: 'runtime',
        owner: 'engine-ddc',
        rootKind: 'runtime',
        protection: [],
        actions: recoveryActions,
      },
    ],
  });
  expect(error.toBrowserProjection().recoveryActions).toEqual([
    { kind: 'release-lease', executable: true, reason: 'expired' },
  ]);
  expect(status.layers[0]?.actions).toEqual(error.toBrowserProjection().recoveryActions);
  expect(recoveryActions[0]?.exactTarget).toBe('/host/lease');
});
