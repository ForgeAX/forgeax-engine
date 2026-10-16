import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCatalogHotSubscription } from '@forgeax/engine/assets-runtime';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine/types';
import { pluginPack } from '@forgeax/engine/vite-plugin-pack';
import { createServer } from 'vite';
import { defineFeature } from '../../lab/feature';
import { withFixture } from './support/fixture';

const PACKAGE = '0190a1b2-0000-7000-8000-00000000b301';

interface CatalogBody {
  readonly entries: ReadonlyArray<{
    readonly guid: string;
    readonly sourceKey?: string;
    readonly packageUrl: string;
  }>;
  readonly [key: string]: unknown;
}

const pack = (keys: readonly string[]) =>
  JSON.stringify({
    schemaVersion: '3.0.0',
    packageId: PACKAGE,
    assets: Object.fromEntries(
      keys.map((key) => [key, { kind: 'sampler', payload: {}, refs: [] }]),
    ),
  });

async function poll(
  read: () => Promise<CatalogBody>,
  accept: (body: CatalogBody) => boolean,
): Promise<CatalogBody | undefined> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const body = await read().catch(() => undefined);
    if (body !== undefined && accept(body)) return body;
    await new Promise((done) => setTimeout(done, 100));
  }
  return undefined;
}

const keys = (body: CatalogBody | undefined) =>
  (body?.entries ?? []).map((entry) => entry.sourceKey ?? '').sort();

export default defineFeature({
  title: 'Hot content-catalog refresh',
  catalog: 'Hot content-catalog refresh',
  kind: 'headless',
  summary:
    'A dev asset-root edit rebuilds and republishes the serving Catalog in place without restarting the Vite session.',
  expect:
    'The same server serves the new row after the edit, keeps existing GUIDs, and the catalog body advances.',
  async run(checks) {
    await withFixture(
      {
        'package.json': '{"name":"feature-lab-hot","type":"module"}',
        'assets/lab.pack.json': pack(['a']),
      },
      async (root) => {
        const binding = createStandaloneRuntimeAssetBinding('feature-lab-hot');
        const plugin = pluginPack({
          roots: [join(root, 'assets')],
          runtimeBinding: binding,
          watch: false,
          ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
        });
        const server = await createServer({
          root,
          configFile: false,
          logLevel: 'silent',
          plugins: [plugin],
          server: { host: '127.0.0.1', port: 0, watch: null },
        });
        try {
          await server.listen();
          const base = server.resolvedUrls?.local[0];
          checks.ok('dev server listens', base !== undefined);
          if (base === undefined) return;
          const read = async () =>
            (await (await fetch(new URL(binding.catalogUrl, base))).json()) as CatalogBody;
          const first = await poll(read, (body) => body.entries.length === 1);
          checks.equal('initial catalog has one row', keys(first), ['a']);

          const events: Array<{ event?: string; data?: unknown }> = [];
          const send = server.ws.send.bind(server.ws) as (payload: unknown) => void;
          (server.ws as { send: (payload: unknown) => void }).send = (payload) => {
            events.push(payload as { event?: string; data?: unknown });
            send(payload);
          };
          const source = join(root, 'assets/lab.pack.json');
          await writeFile(source, pack(['a', 'b']));
          checks.equal(
            'rebuildCatalogInPlace publishes an authoritative delta',
            await plugin.rebuildCatalogInPlace([source]),
            true,
          );
          const second = await poll(read, (body) => body.entries.length === 2);
          checks.equal('edit publishes the new row on the same server', keys(second), ['a', 'b']);
          const guidOf = (body: CatalogBody | undefined) =>
            body?.entries.find((entry) => entry.sourceKey === 'a')?.guid;
          checks.ok(
            'existing GUID is stable across refresh',
            guidOf(first) !== undefined && guidOf(first) === guidOf(second),
          );
          const delta = events.find((payload) => payload.event === 'forgeax:catalog-delta');
          checks.ok('forgeax:catalog-delta is sent over the HMR channel', delta !== undefined);
          const received: unknown[] = [];
          const listeners = new Map<string, (data: unknown) => void>();
          const unsubscribe = createCatalogHotSubscription({
            on: (event, listener) => listeners.set(event, listener),
            off: (event) => listeners.delete(event),
          })((value) => received.push(value));
          listeners.get('forgeax:catalog-delta')?.(delta?.data);
          listeners.get('forgeax:catalog-delta')?.({ added: 'not rows' });
          const added = (
            received[0] as { added?: ReadonlyArray<{ sourceKey?: string }> } | undefined
          )?.added;
          checks.equal(
            'runtime subscription folds the valid delta only',
            [received.length, added?.map((row) => row.sourceKey)],
            [1, ['b']],
          );
          unsubscribe();
          checks.equal('unsubscribe releases the HMR listener', listeners.size, 0);
        } finally {
          await server.close();
        }
      },
    );
  },
});
