import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import type { PluginServerState } from '../dev/plugin-server.js';
import { rowMatchesChangedPath } from '../dev/plugin-server-configure.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';

function stateFor(metaPath: string, sourcePath: string): PluginServerState {
  return {
    catalogProjection: {
      declarations: new Map([
        [
          metaPath,
          {
            source: sourcePath,
            subAssets: [{ guid: GUID }],
          },
        ],
      ]),
    },
  } as unknown as PluginServerState;
}

test('matches an imported row when its source changes without its Meta sidecar', () => {
  const root = resolve('/tmp/forgeax-source-failure-path');
  const sourcePath = join(root, 'assets', 'model.glb');
  const metaPath = `${sourcePath}.meta.json`;
  const state = stateFor(metaPath, sourcePath);

  expect(
    rowMatchesChangedPath(
      { guid: GUID, sourcePath: 'not-relative-to-this-process' },
      new Set([sourcePath]),
      state,
    ),
  ).toBe(true);
});
