import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { EngineWorkspacePreview } from '@forgeax/engine-app';
import { createBackendHost } from '@forgeax/engine-host/backend';
import type { PackDraftReply, PackDraftSnapshot } from '@forgeax/engine-pack/source';
import type { PluginPack } from '@forgeax/engine-vite-plugin-pack';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import { allocateLoopbackPort } from '../tools/browser-host.js';
import { createWorkspacePackAuthoring } from '../workspace-pack-authoring.js';

it('publishes saved authoring sources without replacing the editing document', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-authoring-publication-')));
  const backend = await createBackendHost();
  let server: ViteDevServer | undefined;
  const source = resolve(root, 'assets/scene.pack.json');
  const authored = (intensity: number) =>
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: '01900000-0000-7000-8000-000000001906',
      assets: {
        'scene/main': {
          kind: 'scene',
          refs: [],
          artifacts: {},
          payload: { entities: { sun: { components: { DirectionalLight: { intensity } } } } },
        },
      },
    });
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(
      resolve(root, 'package.json'),
      '{"name":"authoring-publication","type":"module"}',
    );
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'authoring-publication',
        name: 'Authoring',
        roots: {},
      }),
    );
    await writeFile(source, authored(3.2));
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const consumed: string[] = [];
    const config = await createViteConfig(facts.value, 'serve', '/', {
      host: {
        backend,
        authoringSourceChanged(path) {
          consumed.push(path);
          return true;
        },
      },
    });
    server = await createServer({
      ...config,
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        ...config.server,
        port: await allocateLoopbackPort(),
        strictPort: true,
        watch: null,
      },
    });
    await server.listen();
    const pack = server.config.plugins.find(
      (plugin) => plugin.name === 'forgeax:pack',
    ) as PluginPack;
    await pack.ready();
    const initial = pack.catalogSnapshot().find((row) => row.kind === 'scene');
    expect(initial?.revision?.digest).toBeDefined();
    const lifecycle = server.config.plugins.find(
      (plugin) => plugin.name === 'forgeax:project-session',
    ) as Plugin;
    if (typeof lifecycle.hotUpdate !== 'function') throw new Error('Project HMR owner missing');
    const reloads: unknown[] = [];
    const send = server.ws.send.bind(server.ws);
    server.ws.send = ((...args: Parameters<typeof send>) => {
      const message: unknown = args[0];
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'full-reload'
      )
        reloads.push(message);
      return send(...args);
    }) as typeof server.ws.send;
    for (const intensity of [1, 3.2]) {
      const previous = pack.catalogSnapshot().find((row) => row.kind === 'scene')?.revision?.digest;
      await writeFile(source, authored(intensity));
      await expect(
        lifecycle.hotUpdate.call(
          { environment: { name: 'client' } } as never,
          {
            type: 'update',
            file: source,
            timestamp: 1,
            modules: [],
            server,
            read: () => readFile(source, 'utf8'),
          } as never,
        ),
      ).resolves.toEqual([]);
      await expect
        .poll(() => pack.catalogSnapshot().find((row) => row.kind === 'scene')?.revision?.digest, {
          timeout: 3000,
        })
        .not.toBe(previous);
    }
    expect(consumed).toEqual([source, source]);
    expect(reloads).toEqual([]);
    expect(pack.catalogSnapshot().find((row) => row.kind === 'scene')?.revision?.digest).toBe(
      initial?.revision?.digest,
    );

    const notificationsBeforeNonclient = consumed.length;
    let nonclientReads = 0;
    await expect(
      lifecycle.hotUpdate.call(
        { environment: { name: 'ssr' } } as never,
        {
          type: 'update',
          file: source,
          timestamp: 1,
          modules: [],
          server,
          read() {
            nonclientReads += 1;
            return readFile(source, 'utf8');
          },
        } as never,
      ),
    ).resolves.toEqual([]);
    expect(nonclientReads).toBe(0);
    expect(consumed).toHaveLength(notificationsBeforeNonclient);

    let missingSourceReads = 0;
    const notificationsBeforeMissing = consumed.length;
    for (const type of ['create', 'update'] as const) {
      const missing = Object.assign(new Error(`${type} source is missing`), { code: 'ENOENT' });
      await expect(
        lifecycle.hotUpdate.call(
          { environment: { name: 'client' } } as never,
          {
            type,
            file: source,
            timestamp: 1,
            modules: [],
            server,
            read() {
              missingSourceReads += 1;
              return Promise.reject(missing);
            },
          } as never,
        ),
      ).resolves.toEqual([]);
    }
    expect(missingSourceReads).toBe(2);
    expect(consumed.slice(notificationsBeforeMissing)).toEqual([source, source]);

    const readFailure = Object.assign(new Error('source read failed'), { code: 'EIO' });
    const notificationsBeforeFailure = consumed.length;
    let failedReads = 0;
    await expect(
      lifecycle.hotUpdate.call(
        { environment: { name: 'client' } } as never,
        {
          type: 'update',
          file: source,
          timestamp: 1,
          modules: [],
          server,
          read() {
            failedReads += 1;
            return Promise.reject(readFailure);
          },
        } as never,
      ),
    ).rejects.toBe(readFailure);
    expect(failedReads).toBe(1);
    expect(consumed).toHaveLength(notificationsBeforeFailure);

    for (const failure of [null, 'primitive read failure'] as const) {
      await expect(
        lifecycle.hotUpdate.call(
          { environment: { name: 'client' } } as never,
          {
            type: 'update',
            file: source,
            timestamp: 1,
            modules: [],
            server,
            read: () => Promise.reject(failure),
          } as never,
        ),
      ).rejects.toBe(failure);
    }
    expect(consumed).toHaveLength(notificationsBeforeFailure);

    await rm(source);
    let deletedReads = 0;
    await expect(
      lifecycle.hotUpdate.call(
        { environment: { name: 'client' } } as never,
        {
          type: 'delete',
          file: source,
          timestamp: 1,
          modules: [],
          server,
          read() {
            deletedReads += 1;
            return Promise.reject(Object.assign(new Error('deleted source'), { code: 'ENOENT' }));
          },
        } as never,
      ),
    ).resolves.toEqual([]);
    expect(deletedReads).toBe(0);
    expect(consumed.at(-1)).toBe(source);
  } finally {
    await server?.close();
    await backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('waits for the Vite read barrier before notifying the Pack authoring owner', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-authoring-read-barrier-')));
  const backend = await createBackendHost();
  let server: ViteDevServer | undefined;
  let owner: ReturnType<typeof createWorkspacePackAuthoring> | undefined;
  let update: Promise<unknown> | undefined;
  let hookOutcome: Promise<'hook-settled' | 'hook-rejected'> | undefined;
  let completeRead: ((text: string) => void) | undefined;
  let readInvoked = false;
  let readSettled = false;
  let completeReadInvoked: (() => void) | undefined;
  const readInvokedPromise = new Promise<void>((resolve) => {
    completeReadInvoked = resolve;
  });
  let completeOwnerNotified: (() => void) | undefined;
  const ownerNotifiedPromise = new Promise<void>((resolve) => {
    completeOwnerNotified = resolve;
  });
  let completeOwner: (() => void) | undefined;
  const ownerSettled = new Promise<void>((resolve) => {
    completeOwner = resolve;
  });
  const events: string[] = [];
  const replies: PackDraftReply[] = [];
  let clientNotifications = 0;
  const relativeSource = 'assets/scene.pack.ts';
  const source = resolve(root, relativeSource);
  const authored = (withRadius: boolean) =>
    `import {definePack,definePackageId} from '@forgeax/engine/pack/source';\nimport {ok} from '@forgeax/engine/types';\nexport default definePack({schemaVersion:'2.0.0',packageId:definePackageId('01900000-0000-7000-8000-000000000058'),${withRadius ? "parameters:[{name:'radius',type:'f32',default:1.4}]," : ''}build:()=>ok({'sampler/read-barrier':{kind:'sampler',magFilter:'linear'}})});`;
  const finalSource = authored(false);
  const preview = {
    target: { targetId: 'read-barrier-target', generation: 1 },
    asset: { path: relativeSource },
  } as unknown as EngineWorkspacePreview;
  try {
    await mkdir(resolve(root, 'assets'));
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      resolve(import.meta.dirname, '../../../engine'),
      resolve(root, 'node_modules/@forgeax/engine'),
      'dir',
    );
    await writeFile(
      resolve(root, 'package.json'),
      '{"name":"authoring-read-barrier","type":"module"}',
    );
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'authoring-read-barrier',
        name: 'Authoring read barrier',
        roots: {},
      }),
    );
    await writeFile(source, authored(true));
    const authoringOwner = createWorkspacePackAuthoring({
      root,
      sourceRoots: ['assets'],
      preview: (targetId) => (targetId === 'read-barrier-target' ? preview : undefined),
      changed(reply) {
        replies.push(reply);
        if ('fields' in reply && reply.error) events.push('empty-error-published');
        else events.push('draft-snapshot-published');
      },
    });
    owner = authoringOwner;
    const opened = await authoringOwner.execute({
      project: { id: 'authoring-read-barrier', root },
      previewTargetId: 'read-barrier-target',
      request: { action: 'open', sourcePath: relativeSource },
    });
    if (!('fields' in opened)) throw new Error('The Pack authoring owner did not open a snapshot');
    const initialSequence = opened.sequence;
    expect(opened.fields.map((field) => field.name)).toContain('radius');
    replies.splice(0);
    events.splice(0);

    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'serve', '/', {
      host: {
        backend,
        async authoringSourceChanged(path) {
          clientNotifications += 1;
          events.push('authoring-notified');
          completeOwnerNotified?.();
          try {
            return await authoringOwner.sourceChanged(path);
          } finally {
            events.push('owner-settled');
            completeOwner?.();
          }
        },
      },
    });
    server = await createServer({
      ...config,
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        ...config.server,
        port: await allocateLoopbackPort(),
        strictPort: true,
        watch: null,
      },
    });
    await server.listen();
    const pack = server.config.plugins.find(
      (plugin) => plugin.name === 'forgeax:pack',
    ) as PluginPack;
    await pack.ready();
    const lifecycle = server.config.plugins.find(
      (plugin) => plugin.name === 'forgeax:project-session',
    ) as Plugin;
    if (typeof lifecycle.hotUpdate !== 'function') throw new Error('Project HMR owner missing');

    await writeFile(source, '');
    const readGate = new Promise<string>((resolve) => {
      completeRead = resolve;
    });
    update = Promise.resolve(
      lifecycle.hotUpdate.call(
        { environment: { name: 'client' } } as never,
        {
          type: 'update',
          file: source,
          timestamp: 1,
          modules: [],
          server,
          read() {
            readInvoked = true;
            events.push('read-invoked');
            completeReadInvoked?.();
            return readGate;
          },
        } as never,
      ),
    );
    hookOutcome = update.then(
      () => {
        events.push('hook-settled');
        return 'hook-settled' as const;
      },
      () => {
        events.push('hook-rejected');
        return 'hook-rejected' as const;
      },
    );

    const firstBoundary = await Promise.race([
      readInvokedPromise.then(() => 'read-invoked' as const),
      ownerNotifiedPromise.then(() => 'authoring-notified' as const),
      hookOutcome,
    ]);
    if (firstBoundary === 'authoring-notified') {
      // Preserve the baseline empty-file publication before checking the missing barrier.
      await ownerSettled;
      const failures = replies.filter(
        (reply): reply is PackDraftSnapshot => 'fields' in reply && reply.error !== undefined,
      );
      expect(failures.at(-1)).toMatchObject({
        fields: [{ name: 'radius' }],
        error: { code: 'pack-source-mutation-unsupported' },
      });
    }

    expect(firstBoundary).toBe('read-invoked');
    expect(readSettled).toBe(false);
    expect(events).toEqual(['read-invoked']);
    expect(clientNotifications).toBe(0);
    expect(replies).toEqual([]);
    expect(await readFile(source, 'utf8')).toBe('');
    await writeFile(source, finalSource);
    completeRead?.(finalSource);
    readSettled = true;
    expect(await hookOutcome).toBe('hook-settled');

    expect(await readFile(source, 'utf8')).toBe(finalSource);
    expect(clientNotifications).toBe(1);
    const readIndex = events.indexOf('read-invoked');
    const notificationIndex = events.indexOf('authoring-notified');
    const ownerSettledIndex = events.indexOf('owner-settled');
    const hotUpdateSettledIndex = events.indexOf('hook-settled');
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(notificationIndex).toBeGreaterThan(readIndex);
    expect(ownerSettledIndex).toBeGreaterThan(notificationIndex);
    expect(hotUpdateSettledIndex).toBeGreaterThan(ownerSettledIndex);

    const latest = await authoringOwner.execute({
      project: { id: 'authoring-read-barrier', root },
      request: { action: 'get', draftId: opened.id },
    });
    if (!('fields' in latest))
      throw new Error('The Pack authoring owner did not return a snapshot');
    const digest = createHash('sha256').update(finalSource).digest('hex');
    expect(latest.sequence).toBeGreaterThan(initialSequence);
    expect(latest.revision).toBe(`sha256:${digest}`);
    expect(latest.fields.map((field) => field.name)).not.toContain('radius');
    expect(latest.error).toBeUndefined();
  } finally {
    if (update) {
      if (readInvoked && !readSettled) {
        await writeFile(source, finalSource);
        completeRead?.(finalSource);
        readSettled = true;
      }
      await hookOutcome;
    }
    await server?.close();
    owner?.dispose();
    await backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
