import { describe, expect, it } from 'vitest';
import {
  DDC_STATUS_SCHEMA,
  type DdcStatus,
  projectDdcStatusForBrowser,
  serializeDdcStatus,
} from '../status.js';

describe('DDC versioned status envelope', () => {
  const status: DdcStatus = {
    schemaVersion: DDC_STATUS_SCHEMA,
    health: 'blocked',
    gameDir: '/Users/test/game',
    projectDdcRoot: '/Users/test/game/.forgeax/ddc/v2',
    layers: [
      {
        kind: 'project',
        owner: 'engine-ddc',
        rootKind: 'project-ddc',
        scopeId: 'editor/main',
        current: 7,
        lastKnownGood: 6,
        protection: ['current', 'lease:editor-a'],
        actions: [
          {
            kind: 'prune',
            executable: true,
            exactTarget: '/Users/test/game/.forgeax/ddc/v2/generations/4',
          },
        ],
      },
    ],
  };

  it('serializes the public schema with layer, owner, current, LKG, protection and actions', () => {
    const serialized = JSON.parse(serializeDdcStatus(status)) as DdcStatus;

    expect(serialized).toEqual(status);
    expect(serialized.schemaVersion).toBe('forgeax-ddc-status/v2');
  });

  it('redacts every host path from browser projection while preserving recovery data', () => {
    const browser = projectDdcStatusForBrowser(status);
    const text = JSON.stringify(browser);

    expect(browser).not.toHaveProperty('gameDir');
    expect(browser).not.toHaveProperty('projectDdcRoot');
    expect(text).not.toContain('/Users/test');
    expect(browser.layers[0]).toMatchObject({
      current: 7,
      lastKnownGood: 6,
      protection: ['current', 'lease:editor-a'],
      actions: [{ kind: 'prune', executable: true }],
    });
  });
});
