import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInventory } from '@forgeax/engine-pack/scanner';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { expect, it } from 'vitest';
import { createPluginPackInternal } from '../plugin-pack.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pack-production-startup-'));
  const source = join(root, 'sampler.pack.ts');
  const events = join(root, 'events.log');
  const write = async (filter: string) =>
    writeFile(
      source,
      `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(events)}, 'load\\n');
    export default {
      schemaVersion: '2.0.0',
      packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,93]),
      build() {
        appendFileSync(${JSON.stringify(events)}, 'build\\n');
        return { ok: true, value: { sampler: { kind: 'sampler', magFilter: '${filter}' } } };
      },
    };
  `,
    );
  await mkdir(root, { recursive: true });
  await write('linear');
  const snapshot = createScriptablePackSourceSnapshot();
  const scanned = await scanInventory([root], {
    scriptablePack: { metadataOnly: true, sourceSnapshot: snapshot },
  });
  if (!scanned.ok) throw scanned.error;
  const emitted: Array<{ fileName?: string; name?: string; source: string | Uint8Array }> = [];
  const context = {
    emitFile(asset: (typeof emitted)[number]) {
      emitted.push(asset);
      return String(emitted.length - 1);
    },
    getFileName(id: string) {
      return emitted[Number(id)]?.fileName ?? `assets/${id}`;
    },
  };
  return { root, source, events, write, snapshot, emitted, context };
}

it('shares initial metadata and one production inventory, then reads fresh sources on the next build', async () => {
  const f = await fixture();
  let takes = 0;
  const plugin = createPluginPackInternal({
    roots: [f.root],
    takeInitialSourceSnapshot: () => {
      takes++;
      return f.snapshot;
    },
  });
  plugin.configResolved({ command: 'build', base: '/' });
  try {
    await plugin.buildStart.call(f.context);
    await plugin.generateBundle.call(f.context);
    expect((await readFile(f.events, 'utf8')).trim().split('\n')).toEqual([
      'load',
      'load',
      'build',
    ]);
    const first = JSON.stringify(f.emitted);
    await plugin.closeBundle();
    await f.write('nearest');
    f.emitted.length = 0;
    await plugin.buildStart.call(f.context);
    await plugin.generateBundle.call(f.context);
    expect(takes).toBe(1);
    expect(JSON.stringify(f.emitted)).not.toBe(first);
    expect((await readFile(f.events, 'utf8')).trim().split('\n')).toEqual([
      'load',
      'load',
      'build',
      'load',
      'load',
      'build',
    ]);
  } finally {
    await plugin.closeBundle();
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

it('rejects edits to the handed-off snapshot before cooking or emitting', async () => {
  const f = await fixture();
  const plugin = createPluginPackInternal({
    roots: [f.root],
    takeInitialSourceSnapshot: () => f.snapshot,
  });
  plugin.configResolved({ command: 'build', base: '/' });
  try {
    await f.write('nearest');
    await expect(plugin.buildStart.call(f.context)).rejects.toMatchObject({
      code: 'pack-source-revision-conflict',
    });
    expect(f.emitted).toEqual([]);
    expect(await readFile(f.events, 'utf8')).toBe('load\n');
  } finally {
    await plugin.closeBundle();
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);
