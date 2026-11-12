import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS, scanInventory } from '../scanner.js';
import { SCRIPTABLE_PACK_BUILD_TIMEOUT_ENV } from '../scriptable-pack-node.js';

it('uses the host-resolved build timeout in standard scan options', () => {
  const previous = process.env[SCRIPTABLE_PACK_BUILD_TIMEOUT_ENV];
  process.env[SCRIPTABLE_PACK_BUILD_TIMEOUT_ENV] = '180000';
  try {
    expect(STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS.buildTimeoutMs).toBe(180_000);
  } finally {
    if (previous === undefined) delete process.env[SCRIPTABLE_PACK_BUILD_TIMEOUT_ENV];
    else process.env[SCRIPTABLE_PACK_BUILD_TIMEOUT_ENV] = previous;
  }
});

it('keeps a scanned ScriptablePack build alive beyond the low-level 15 second default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-scanner-build-timeout-'));
  try {
    const sourcePath = join(root, 'slow.pack.ts');
    await writeFile(
      sourcePath,
      [
        'const packageId = new Uint8Array(16);',
        'packageId[15] = 1;',
        'export default {',
        "  schemaVersion: '2.0.0',",
        '  packageId,',
        '  async build() {',
        '    await new Promise((resolve) => setTimeout(resolve, 16_000));',
        "    return { ok: true, value: { mesh: { kind: 'mesh' } } };",
        '  },',
        '};',
      ].join('\n'),
    );

    const scanned = await scanInventory([root], {
      scriptablePack: { ...STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS, metadataOnly: false },
    });
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    const declaration = scanned.value.declarations.get(sourcePath);
    expect(declaration?.format).toBe('pack.ts');
    if (declaration?.format !== 'pack.ts') return;

    const build = declaration.definition.build as unknown as (context: {
      readonly packageId: Uint8Array;
      readonly readByGuid: () => Promise<unknown>;
    }) => Promise<{ readonly ok: boolean }>;
    expect(
      await build({
        packageId: declaration.definition.packageId,
        readByGuid: async () => ({ ok: true, value: undefined }),
      }),
    ).toMatchObject({ ok: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
