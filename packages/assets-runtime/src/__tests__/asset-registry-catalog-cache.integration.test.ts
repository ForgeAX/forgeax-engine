import { createServer } from 'node:http';
import { type CatalogDelta, type CatalogEntry, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import { createCatalogSource } from '../catalog-source.js';

it('shares one accepted URL catalog between enumeration and GUID loading', async () => {
  const guid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const requests: string[] = [];
  let baseUrl = '';
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    response.setHeader('content-type', 'application/json');
    if (url === '/catalog.json') {
      response.end(
        JSON.stringify([{ guid, kind: 'host-blob', packageUrl: `${baseUrl}/one.pack.json` }]),
      );
      return;
    }
    if (url === '/one.pack.json') {
      response.end(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            { guid, kind: 'host-blob', payload: { value: 'accepted' }, refs: [], artifacts: {} },
          ],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing HTTP listener');

  baseUrl = `http://127.0.0.1:${address.port}`;
  const registry = new AssetRegistry({} as ConstructorParameters<typeof AssetRegistry>[0]);
  registry.loaders.register({
    kind: 'host-blob',
    load(payload) {
      return payload;
    },
  });
  registry.configurePackIndex(`${baseUrl}/catalog.json`);
  registry.setCatalogSource(createCatalogSource({ url: `${baseUrl}/catalog.json` }));

  try {
    const [enumerated, loaded] = await Promise.all([
      registry.enumerateCatalog(),
      registry.loadByGuid<{ value: string }>(registry.parseGuid(guid)),
    ]);
    expect(enumerated.ok).toBe(true);
    expect(loaded.unwrap()).toEqual({ value: 'accepted' });
    expect(requests.filter((url) => url === '/catalog.json')).toHaveLength(1);
    expect(requests.filter((url) => url === '/one.pack.json')).toHaveLength(1);

    await registry.enumerateCatalog();
    expect((await registry.loadByGuid(registry.parseGuid(guid))).ok).toBe(true);
    expect(requests.filter((url) => url === '/catalog.json')).toHaveLength(1);
    expect(requests.filter((url) => url === '/one.pack.json')).toHaveLength(1);

    registry.invalidateAll();
    expect((await registry.loadByGuid(registry.parseGuid(guid))).ok).toBe(true);
    expect(requests.filter((url) => url === '/catalog.json')).toHaveLength(2);
  } finally {
    registry.clearCatalogSource();
    registry.invalidateAll();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each([
  false,
  true,
])('keeps deliberately different catalog authorities separate with an observer transport: %s', async (transport) => {
  const primaryGuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const observerGuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    response.setHeader('content-type', 'application/json');
    if (url === '/primary-catalog.json') {
      response.end(
        JSON.stringify([
          { guid: primaryGuid, kind: 'host-blob', packageUrl: '/primary.pack.json' },
        ]),
      );
      return;
    }
    if (url === '/observer-catalog.json') {
      response.end(
        JSON.stringify([
          { guid: observerGuid, kind: 'host-blob', packageUrl: '/observer.pack.json' },
        ]),
      );
      return;
    }
    if (url === '/primary.pack.json' || url === '/observer.pack.json') {
      const guid = url.startsWith('/primary') ? primaryGuid : observerGuid;
      response.end(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [{ guid, kind: 'host-blob', payload: { value: guid }, refs: [], artifacts: {} }],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing HTTP listener');

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const registry = new AssetRegistry({} as ConstructorParameters<typeof AssetRegistry>[0]);
  registry.loaders.register({
    kind: 'host-blob',
    load(payload) {
      return payload;
    },
  });
  registry.configurePackIndex(`${baseUrl}/primary-catalog.json`);
  registry.setCatalogSource({
    ...createCatalogSource({ url: `${baseUrl}/observer-catalog.json` }),
    ...(transport ? { openPackage: () => globalThis.fetch } : {}),
  });

  try {
    const [enumerated, loaded] = await Promise.all([
      registry.enumerateCatalog(),
      registry.loadByGuid<{ value: string }>(registry.parseGuid(primaryGuid)),
    ]);
    expect(enumerated.ok).toBe(true);
    if (enumerated.ok) expect(enumerated.value[0]?.guid).toBe(observerGuid);
    expect(loaded.unwrap()).toEqual({ value: primaryGuid });
    expect(requests.filter((url) => url === '/primary-catalog.json')).toHaveLength(1);
    expect(requests.filter((url) => url === '/observer-catalog.json')).toHaveLength(1);
    expect(requests.filter((url) => url === '/primary.pack.json')).toHaveLength(1);
    expect(requests).not.toContain('/observer.pack.json');
  } finally {
    registry.clearCatalogSource();
    registry.invalidateAll();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('seeds a source attached after a same-authority GUID load', async () => {
  const guid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const requests: string[] = [];
  let baseUrl = '';
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    response.setHeader('content-type', 'application/json');
    if (url === '/catalog.json') {
      response.end(
        JSON.stringify([{ guid, kind: 'host-blob', packageUrl: `${baseUrl}/one.pack.json` }]),
      );
      return;
    }
    if (url === '/one.pack.json') {
      response.end(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            { guid, kind: 'host-blob', payload: { value: 'loaded' }, refs: [], artifacts: {} },
          ],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing HTTP listener');

  baseUrl = `http://127.0.0.1:${address.port}`;
  const registry = new AssetRegistry({} as ConstructorParameters<typeof AssetRegistry>[0]);
  registry.loaders.register({
    kind: 'host-blob',
    load(payload) {
      return payload;
    },
  });
  registry.configurePackIndex(`${baseUrl}/catalog.json`);

  try {
    const loaded = await registry.loadByGuid<{ value: string }>(registry.parseGuid(guid));
    expect(loaded.unwrap()).toEqual({ value: 'loaded' });

    registry.setCatalogSource(createCatalogSource({ url: `${baseUrl}/catalog.json` }));
    const enumerated = await registry.enumerateCatalog();
    expect(enumerated.ok).toBe(true);
    if (enumerated.ok) expect(enumerated.value.map((entry) => entry.guid)).toEqual([guid]);

    registry.setCatalogSource(createCatalogSource({ url: `${baseUrl}/catalog.json` }));
    const replaced = await registry.enumerateCatalog();
    expect(replaced.ok).toBe(true);
    if (replaced.ok) expect(replaced.value.map((entry) => entry.guid)).toEqual([guid]);
    expect(requests.filter((url) => url === '/catalog.json')).toHaveLength(1);
    expect(requests.filter((url) => url === '/one.pack.json')).toHaveLength(1);
  } finally {
    registry.clearCatalogSource();
    registry.invalidateAll();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('does not reuse a cache for a source with an expected revision', async () => {
  const guid = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const requests: string[] = [];
  let baseUrl = '';
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    response.setHeader('content-type', 'application/json');
    if (url === '/catalog.json') {
      response.end(
        JSON.stringify([{ guid, kind: 'host-blob', packageUrl: `${baseUrl}/one.pack.json` }]),
      );
      return;
    }
    if (url === '/one.pack.json') {
      response.end(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            { guid, kind: 'host-blob', payload: { value: 'loaded' }, refs: [], artifacts: {} },
          ],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing HTTP listener');

  baseUrl = `http://127.0.0.1:${address.port}`;
  const registry = new AssetRegistry({} as ConstructorParameters<typeof AssetRegistry>[0]);
  registry.loaders.register({
    kind: 'host-blob',
    load(payload) {
      return payload;
    },
  });
  registry.configurePackIndex(`${baseUrl}/catalog.json`);

  try {
    expect((await registry.loadByGuid<{ value: string }>(registry.parseGuid(guid))).ok).toBe(true);
    const source = createCatalogSource({
      url: `${baseUrl}/catalog.json`,
      expectedRevision: { digest: 'sha256:required', observedAt: 1, rootId: 'producer' },
    });
    const direct = await source.enumerate();
    expect(direct.ok).toBe(false);
    registry.setCatalogSource(source);
    const enumerated = await registry.enumerateCatalog();
    expect(enumerated.ok).toBe(false);
    if (!enumerated.ok) expect(enumerated.error.code).toBe('asset-parse-failed');
    expect(requests.filter((url) => url === '/catalog.json').length).toBeGreaterThanOrEqual(2);
    expect(requests.filter((url) => url === '/one.pack.json')).toHaveLength(1);
  } finally {
    registry.clearCatalogSource();
    registry.invalidateAll();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('does not reuse a cache for a source with an expected scope', async () => {
  const guid = '12121212-1212-4121-8121-121212121212';
  const requests: string[] = [];
  let baseUrl = '';
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    response.setHeader('content-type', 'application/json');
    if (url === '/catalog.json') {
      response.end(
        JSON.stringify([{ guid, kind: 'host-blob', packageUrl: `${baseUrl}/one.pack.json` }]),
      );
      return;
    }
    if (url === '/one.pack.json') {
      response.end(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            { guid, kind: 'host-blob', payload: { value: 'loaded' }, refs: [], artifacts: {} },
          ],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing HTTP listener');

  baseUrl = `http://127.0.0.1:${address.port}`;
  const registry = new AssetRegistry({} as ConstructorParameters<typeof AssetRegistry>[0]);
  registry.loaders.register({
    kind: 'host-blob',
    load(payload) {
      return payload;
    },
  });
  registry.configurePackIndex(`${baseUrl}/catalog.json`);

  try {
    expect((await registry.loadByGuid<{ value: string }>(registry.parseGuid(guid))).ok).toBe(true);
    const source = createCatalogSource({
      url: `${baseUrl}/catalog.json`,
      expectedScope: { scopeId: 'runtime-scope', generation: 7 },
    });
    const direct = await source.enumerate();
    expect(direct.ok).toBe(false);
    registry.setCatalogSource(source);
    const enumerated = await registry.enumerateCatalog();
    expect(enumerated.ok).toBe(false);
    if (!enumerated.ok) expect(enumerated.error.code).toBe('asset-parse-failed');
    expect(requests.filter((url) => url === '/catalog.json').length).toBeGreaterThanOrEqual(2);
    expect(requests.filter((url) => url === '/one.pack.json')).toHaveLength(1);
  } finally {
    registry.clearCatalogSource();
    registry.invalidateAll();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each([
  {
    label: 'expected revision',
    guid: '13131313-1313-4131-8131-131313131313',
    path: '/revision.json',
    expectedRevision: { digest: 'sha256:accepted', observedAt: 2, rootId: 'producer' },
  },
  {
    label: 'expected scope',
    guid: '14141414-1414-4141-8141-141414141414',
    path: '/scope.json',
    expectedScope: { scopeId: 'runtime-scope', generation: 7 },
  },
])('reuses an accepted constrained baseline for $label consumers', async (fixture) => {
  const requests: string[] = [];
  let baseUrl = '';
  const row = {
    guid: fixture.guid,
    kind: 'host-blob',
    packageUrl: `${baseUrl}/one.pack.json`,
    ...(fixture.expectedRevision === undefined ? {} : { revision: fixture.expectedRevision }),
  };
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    response.setHeader('content-type', 'application/json');
    if (url === fixture.path) {
      const body =
        fixture.expectedScope === undefined
          ? [row]
          : {
              schemaVersion: 'runtime-catalog-snapshot-v1',
              scopeId: fixture.expectedScope.scopeId,
              generation: fixture.expectedScope.generation,
              authority: 'authoritative',
              entries: [row],
            };
      response.end(JSON.stringify(body));
      return;
    }
    if (url === '/one.pack.json') {
      response.end(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid: fixture.guid,
              kind: 'host-blob',
              payload: { value: 'accepted' },
              refs: [],
              artifacts: {},
            },
          ],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing HTTP listener');

  baseUrl = `http://127.0.0.1:${address.port}`;
  const catalogUrl = `${baseUrl}${fixture.path}`;
  const registry = new AssetRegistry({} as ConstructorParameters<typeof AssetRegistry>[0]);
  registry.loaders.register({
    kind: 'host-blob',
    load(payload) {
      return payload;
    },
  });
  registry.configurePackIndex(catalogUrl);
  registry.setCatalogSource(
    createCatalogSource({
      url: catalogUrl,
      ...(fixture.expectedRevision === undefined
        ? { expectedScope: fixture.expectedScope }
        : { expectedRevision: fixture.expectedRevision }),
    }),
  );

  try {
    const [enumerated, loaded] = await Promise.all([
      registry.enumerateCatalog(),
      registry.loadByGuid<{ value: string }>(registry.parseGuid(fixture.guid)),
    ]);
    expect(enumerated.ok).toBe(true);
    expect(loaded.unwrap()).toEqual({ value: 'accepted' });
    await registry.enumerateCatalog();
    expect((await registry.loadByGuid(registry.parseGuid(fixture.guid))).ok).toBe(true);
    expect(requests.filter((url) => url === fixture.path)).toHaveLength(1);
    expect(requests.filter((url) => url === '/one.pack.json')).toHaveLength(1);
  } finally {
    registry.clearCatalogSource();
    registry.invalidateAll();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('does not accept a catalog response that crossed invalidation', async () => {
  const guid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const requests: string[] = [];
  let catalogVersion = 1;
  let releaseFirstCatalog: (() => void) | undefined;
  let firstCatalogSeen: (() => void) | undefined;
  const firstCatalog = new Promise<void>((resolve) => {
    firstCatalogSeen = resolve;
  });
  const server = createServer(async (request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    response.setHeader('content-type', 'application/json');
    if (url === '/catalog.json') {
      const version = catalogVersion;
      if (requests.filter((path) => path === '/catalog.json').length === 1) {
        firstCatalogSeen?.();
        await new Promise<void>((resolve) => {
          releaseFirstCatalog = resolve;
        });
      }
      response.end(
        JSON.stringify([{ guid, kind: 'host-blob', packageUrl: `/one-v${version}.pack.json` }]),
      );
      return;
    }
    if (url === '/one-v1.pack.json' || url === '/one-v2.pack.json') {
      const version = url.includes('v2') ? 2 : 1;
      response.end(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            { guid, kind: 'host-blob', payload: { value: version }, refs: [], artifacts: {} },
          ],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing HTTP listener');

  const registry = new AssetRegistry({} as ConstructorParameters<typeof AssetRegistry>[0]);
  registry.loaders.register({
    kind: 'host-blob',
    load(payload) {
      return payload;
    },
  });
  const catalogUrl = `http://127.0.0.1:${address.port}/catalog.json`;
  registry.configurePackIndex(catalogUrl);
  registry.setCatalogSource(createCatalogSource({ url: catalogUrl }));

  try {
    const pending = registry.loadByGuid<{ value: number }>(registry.parseGuid(guid));
    await firstCatalog;
    catalogVersion = 2;
    registry.invalidateAll();
    releaseFirstCatalog?.();

    const invalidated = await pending;
    expect(invalidated.ok).toBe(false);
    if (!invalidated.ok) expect(invalidated.error.code).toBe('asset-invalidated');

    const fresh = await registry.loadByGuid<{ value: number }>(registry.parseGuid(guid));
    expect(fresh.unwrap()).toEqual({ value: 2 });
    expect(requests.filter((url) => url === '/catalog.json')).toHaveLength(2);
    expect(requests).toContain('/one-v2.pack.json');
    expect(requests).not.toContain('/one-v1.pack.json');
  } finally {
    registry.clearCatalogSource();
    registry.invalidateAll();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('reconciles missed changes and removals without discarding unchanged payloads', async () => {
  const changed = '10000000-0000-4000-8000-000000000001';
  const removed = '10000000-0000-4000-8000-000000000002';
  const stable = '10000000-0000-4000-8000-000000000003';
  let version = 1;
  let listener: ((delta: CatalogDelta) => void) | undefined;
  const row = (guid: string, revision: number): CatalogEntry => ({
    guid,
    kind: 'host-blob',
    sourcePath: 'runtime/cache-proof',
    packageUrl: `https://assets.test/${guid}.pack.json`,
    revision: { digest: `revision-${revision}`, observedAt: revision, rootId: 'test' },
  });
  const registry = new AssetRegistry({} as never);
  const loads = new Map<string, number>();
  registry.loaders.register({ kind: 'host-blob', load: (payload) => payload });
  registry.setCatalogSource(
    {
      enumerate: async () =>
        ok(
          version === 1
            ? [row(changed, 1), row(removed, 1), row(stable, 1)]
            : [row(changed, 2), row(stable, 1)],
        ),
      subscribe(fn) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    },
    async (input) => {
      const guid = String(input).split('/').pop()?.replace('.pack.json', '') ?? '';
      loads.set(guid, (loads.get(guid) ?? 0) + 1);
      return new Response(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            { guid, kind: 'host-blob', payload: { value: version }, refs: [], artifacts: {} },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  );
  const load = async (guid: string) =>
    (await registry.loadByGuid<{ value: number }>(registry.parseGuid(guid))).unwrap();
  try {
    const old = await load(changed);
    await load(removed);
    const unchanged = await load(stable);
    version = 2;
    listener?.({
      added: [],
      changed: [],
      removed: [],
      authority: 'degraded',
      diagnostics: [
        {
          code: 'catalog-gap',
          severity: 'blocking',
          expected: 'contiguous producer revisions',
          hint: 'reconcile',
          authority: 'catalog',
        },
      ],
    });
    expect(registry.catalogSnapshot()?.stale).toBe(true);
    expect((await registry.reconcileCatalog()).ok).toBe(true);
    expect(registry.lookup(registry.parseGuid(changed))).toBeUndefined();
    const next = await load(changed);
    expect(next).not.toBe(old);
    expect(next.value).toBe(2);
    expect((await registry.loadByGuid(registry.parseGuid(removed))).ok).toBe(false);
    expect(await load(stable)).toBe(unchanged);
    expect(loads.get(changed)).toBe(2);
    expect(loads.get(stable)).toBe(1);
    await registry.reconcileCatalog();
    expect(await load(changed)).toBe(next);
    expect(loads.get(changed)).toBe(2);
  } finally {
    registry.clearCatalogSource();
    registry.invalidateAll();
  }
});

it('accepts a delta arriving between baseline completion and registry acceptance', async () => {
  const first = {
    guid: '10000000-0000-4000-8000-000000000011',
    kind: 'mesh',
    sourcePath: 'runtime/cache-proof',
    packageUrl: 'https://assets.test/first.pack.json',
  };
  const added = {
    guid: '10000000-0000-4000-8000-000000000012',
    kind: 'mesh',
    sourcePath: 'runtime/cache-proof',
    packageUrl: 'https://assets.test/added.pack.json',
  };
  let listener: ((delta: CatalogDelta) => void) | undefined;
  let release: (() => void) | undefined;
  let fresh = false;
  const registry = new AssetRegistry({} as never);
  registry.setCatalogSource({
    enumerate: () =>
      fresh
        ? new Promise((resolve) => {
            release = () => resolve(ok([first]));
          })
        : Promise.resolve(ok([first])),
    subscribe(fn) {
      listener = fn;
      return () => {};
    },
  });
  try {
    await registry.ensurePackIndexCache();
    fresh = true;
    const pending = registry.reconcileCatalog();
    release?.();
    queueMicrotask(() => listener?.({ added: [added], changed: [], removed: [] }));
    expect((await pending).ok).toBe(true);
    expect(registry.catalogSnapshot()?.entries.map((row) => row.guid)).toContain(added.guid);
    expect(registry.packIndexCache?.has(added.guid)).toBe(true);
  } finally {
    registry.clearCatalogSource();
    registry.invalidateAll();
  }
});

it('preserves unchanged in-flight loads and rejects changed loads across reconciliation', async () => {
  const changed = '10000000-0000-4000-8000-000000000021';
  const stable = '10000000-0000-4000-8000-000000000022';
  let revision = 1;
  const waiting = new Map<string, () => void>();
  let started: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const registry = new AssetRegistry({} as never);
  registry.loaders.register({ kind: 'host-blob', load: (payload) => payload });
  registry.setCatalogSource(
    {
      enumerate: async () =>
        ok(
          [changed, stable].map((guid) => ({
            guid,
            kind: 'host-blob',
            sourcePath: 'runtime/cache-proof',
            packageUrl: `https://assets.test/${guid}.pack.json`,
            revision: {
              digest: String(guid === changed ? revision : 1),
              observedAt: guid === changed ? revision : 1,
              rootId: 'test',
            },
          })),
        ),
      subscribe() {
        return () => {};
      },
    },
    async (input) => {
      const guid = String(input).split('/').pop()?.replace('.pack.json', '') ?? '';
      const value = revision;
      if (revision === 1) {
        await new Promise<void>((resolve) => {
          waiting.set(guid, resolve);
          if (waiting.size === 2) started?.();
        });
      }
      return new Response(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [{ guid, kind: 'host-blob', payload: { value }, refs: [], artifacts: {} }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  );
  try {
    await registry.ensurePackIndexCache();
    const oldChanged = registry.loadByGuid(registry.parseGuid(changed));
    const oldStable = registry.loadByGuid(registry.parseGuid(stable));
    await bothStarted;
    revision = 2;
    expect((await registry.reconcileCatalog()).ok).toBe(true);
    for (const release of waiting.values()) release();
    expect(await oldChanged).toMatchObject({ ok: false, error: { code: 'asset-invalidated' } });
    const stablePayload = (await oldStable).unwrap();
    expect((await registry.loadByGuid(registry.parseGuid(stable))).unwrap()).toBe(stablePayload);
    expect((await registry.loadByGuid(registry.parseGuid(changed))).unwrap()).toEqual({ value: 2 });
  } finally {
    for (const release of waiting.values()) release();
    registry.clearCatalogSource();
    registry.invalidateAll();
  }
});
