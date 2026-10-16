import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const watcherSource = readFileSync(
  fileURLToPath(
    new URL('../../../vite-plugin-pack/src/dev/plugin-server-configure.ts', import.meta.url),
  ),
  'utf8',
);

describe('volumetric fog M9 watcher contract', () => {
  it('uses the watcher transaction as the refresh suppression owner', () => {
    expect(watcherSource).toContain('classifyWatchedPath');
    expect(watcherSource).toContain('rebuildState');
    expect(watcherSource).toContain("rebuildStatus === 'serving'");
    expect(watcherSource).not.toContain('catalogChanged');
    expect(watcherSource).not.toContain('catalogSourceChanged');
  });

  it('keeps degraded rebuilds on the LKG diagnostic path', () => {
    expect(watcherSource).toContain("authority: 'degraded'");
    expect(watcherSource).toContain('Refreshing the page here would discard that recovery path');
    expect(watcherSource).toContain("rebuildStatus === 'degraded'");
    expect(watcherSource).toContain("rebuildStatus === 'failed'");
  });
});
