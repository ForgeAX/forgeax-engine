import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const { formatInventory, inventory } = await import('../check-runtime-cutover.mjs');

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-cutover-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

describe('runtime authority cutover inventory', () => {
  it('reports static, re-export, dynamic, erased, and manifest channels', () => {
    const root = fixture({
      'consumer/static.ts': "import { Transform, createRenderer } from '@forgeax/engine-runtime';",
      'consumer/reexport.ts': "export { Skin } from '@forgeax/engine-runtime';",
      'consumer/dynamic.mjs':
        "const runtime = await import('@forgeax/engine-runtime'); runtime.AnimationPlayer;",
      'consumer/erased.ts': "type T = import('@forgeax/engine-runtime')['Camera'];",
      'README.md': "import { Transform } from '@forgeax/engine-runtime';",
      'consumer/package.json': '{"dependencies":{"@forgeax/engine-runtime":"workspace:*"}}',
    });
    const rows = inventory(root);
    expect(rows.map((row) => row.channel)).toEqual(
      expect.arrayContaining(['static', 're-export', 'dynamic', 'type-erased', 'manifest']),
    );
    expect(
      rows.some((row) => row.channel === 'manifest' && row.symbol === '@forgeax/engine-scene'),
    ).toBe(true);
    expect(rows.some((row) => row.symbol === 'createRenderer')).toBe(false);
    expect(formatInventory(rows)).toContain('[fail] runtime authority cutover inventory');
  });

  it('returns a stable clean result after moved authorities are removed', () => {
    const root = fixture({
      'consumer.ts':
        "import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';",
      'package.json': '{"name":"consumer","dependencies":{}}',
    });
    const rows = inventory(root);
    expect(rows).toEqual([]);
    expect(formatInventory(rows)).toBe(
      '[ok] runtime authority cutover inventory clean (0 findings)\n',
    );
  });

  it('keeps scanner fixtures out of the actionable source inventory', () => {
    const root = fixture({
      'scripts/check-runtime-cutover.mjs': "import { Camera } from '@forgeax/engine-runtime';",
      'scripts/__tests__/check-runtime-cutover.unit.test.ts':
        "import { MeshFilter } from '@forgeax/engine-runtime';",
      'consumer.ts': "import { Transform } from '@forgeax/engine-runtime';",
    });
    const rows = inventory(root);
    expect(rows).toEqual([
      expect.objectContaining({ file: 'consumer.ts', channel: 'static', symbol: 'Transform' }),
    ]);
  });
});
