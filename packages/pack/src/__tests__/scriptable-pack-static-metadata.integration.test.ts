import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createScriptablePackSourceSnapshot, loadScriptablePack } from '../scriptable-pack-node.js';

const definition = (body: string) => `${body}
export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(7), name: label,
  async build() { const { value } = await import('./heavy.ts'); return { ok: true, value: { scene: { kind: 'scene', entities: {}, value } } }; } };`;

async function fixture(body: string, heavy: string) {
  const root = await mkdtemp(join(tmpdir(), 'pack-static-metadata-'));
  const source = join(root, 'owner.pack.ts');
  await writeFile(source, definition(body));
  await writeFile(join(root, 'heavy.ts'), heavy);
  return { root, source };
}

it('reads metadata without compiling modules that the build imports on demand', async () => {
  // The on-demand module does not even transpile; only build() may observe that.
  const { root, source } = await fixture("const label = 'static';", 'export const value: = ;');
  try {
    const metadata = await loadScriptablePack(source, {
      metadataOnly: true,
      sourceSnapshot: createScriptablePackSourceSnapshot(),
    });
    if (!metadata.ok) throw metadata.error;
    expect(metadata.value.name).toBe('static');
    const full = await loadScriptablePack(source);
    expect(full.ok).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ['awaits', "const { label } = await import('./label.ts');"],
  ['catches', "let label = 'caught'; try { ({ label } = await import('./label.ts')); } catch {}"],
])('loads the complete closure when module evaluation %s an on-demand import', async (_, body) => {
  const { root, source } = await fixture(body, 'export const value = 1;');
  try {
    await writeFile(join(root, 'label.ts'), "export const label = 'complete';");
    const metadata = await loadScriptablePack(source, {
      metadataOnly: true,
      sourceSnapshot: createScriptablePackSourceSnapshot(),
    });
    if (!metadata.ok) throw metadata.error;
    expect(metadata.value.name).toBe('complete');
    const full = await loadScriptablePack(source);
    if (!full.ok) throw full.error;
    const built = await full.value.build({
      packageId: full.value.packageId,
      readByGuid: async () => {
        throw new Error('unexpected read');
      },
    } as never);
    if (!built.ok) throw built.error;
    expect(built.value.scene).toMatchObject({ value: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
