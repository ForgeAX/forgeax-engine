import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import type { ToolContribution } from '@forgeax/engine-tool-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativePreviewRun = vi.hoisted(() => vi.fn());
const backendStart = vi.hoisted(() => vi.fn(async () => ({ phase: 'ready' })));

vi.mock('../tools/native-preview.js', () => ({
  runNativePreviewTool: nativePreviewRun,
}));
vi.mock('../backend-process.js', () => ({
  callDevKitBackend: vi.fn(),
  devKitBackendHostPack: vi.fn(),
  startDevKitBackend: backendStart,
  devKitBackendStatus: vi.fn(async (root: string) => ({ root, phase: 'stopped' })),
  stopDevKitBackend: vi.fn(async (root: string) => ({ root, phase: 'stopped' })),
  runDevKitBackendTool: vi.fn(),
}));

import { createToolClient } from '../tools/client.js';
import { command, createUnifiedCommandContributions } from '../tools/unified-contributions.js';
import { runUnifiedCli } from '../unified-cli.js';

const roots: string[] = [];

afterEach(async () => {
  nativePreviewRun.mockReset();
  backendStart.mockReset().mockResolvedValue({ phase: 'ready' });
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-unified-cli-')));
  roots.push(root);
  await writeFile(join(root, 'package.json'), '{"name":"unified-cli-fixture","type":"module"}\n');
  await writeFile(
    join(root, 'forge.json'),
    JSON.stringify({
      id: 'unified-cli-fixture',
      name: 'Unified CLI fixture',
      schemaVersion: '3.0.0',
      roots: {},
    }),
  );
  return root;
}

describe('unified CLI', () => {
  it('exposes an explicit storage WebGPU validation profile without accepting portable claims', async () => {
    const root = await fixtureRoot();
    const help = await runUnifiedCli(['help', 'project', 'build', '--root', root, '--json']);
    expect(help.ok).toBe(true);
    const properties = (
      help.value as { leaf: { inputSchema: { properties: Record<string, unknown> } } }
    ).leaf.inputSchema.properties;
    expect(properties.materialProfile).toMatchObject({ enum: ['webgpu-storage'] });
    expect(
      await runUnifiedCli(['project', 'build', '--materialProfile', 'other', '--root', root]),
    ).toMatchObject({ ok: false });
    expect(
      await runUnifiedCli([
        'project',
        'build',
        '--target',
        'wechat',
        '--materialProfile',
        'webgpu-storage',
        '--root',
        root,
      ]),
    ).toMatchObject({ ok: false });
  });

  it('keeps product activation flags out of the built-in live command', async () => {
    const root = await fixtureRoot();
    const help = await runUnifiedCli(['help', 'dev', 'start', '--root', root, '--json']);
    expect(help.ok).toBe(true);
    const properties = (
      help.value as {
        leaf: { inputSchema: { properties: Record<string, unknown> } };
      }
    ).leaf.inputSchema.properties;
    expect(properties).not.toHaveProperty('shell');
    expect(properties).not.toHaveProperty('shellModule');
    for (const flag of ['--shell', '--shellModule']) {
      expect(await runUnifiedCli(['dev', 'start', flag, 'true', '--root', root])).toMatchObject({
        ok: false,
        error: { code: 'cli-parse-error' },
      });
    }
  });

  it.each([
    90_000,
    null,
  ])('passes package startup policy %s to backend startup', async (startupTimeoutMs) => {
    const root = await fixtureRoot();
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'unified-cli-fixture',
        type: 'module',
        forgeax: { startupTimeoutMs },
      }),
    );

    const result = await runUnifiedCli(['backend', 'start', '--root', root, '--json']);

    expect(result).toMatchObject({ ok: true, value: { phase: 'ready' } });
    expect(backendStart).toHaveBeenCalledWith(root, { startupTimeoutMs });
  });

  it('discovers Pack commands without activation and executes only an installed build root', async () => {
    const root = await fixtureRoot();
    const helpArgs = ['help', 'shell', 'start', '--root', root, '--json'];
    expect(await runUnifiedCli(helpArgs)).toMatchObject({
      ok: false,
      error: { code: 'tool-command-not-found' },
    });
    await mkdir(join(root, 'assets'));
    await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      resolve(import.meta.dirname, '../../../engine'),
      join(root, 'node_modules/@forgeax/engine'),
      'dir',
    );
    const namespace = '01900000-0000-7000-8000-000000008301';
    const guid = AssetGuid.format(AssetGuid.derive(definePackageId(namespace), 'tools'));
    const manifest = {
      id: 'unified-cli-fixture',
      name: 'Unified CLI fixture',
      schemaVersion: '3.0.0',
    };
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({ ...manifest, roots: { build: guid } }),
    );
    await writeFile(
      join(root, 'assets/tools.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: namespace,
        assets: {
          tools: {
            kind: 'plugin',
            payload: {
              module: { specifier: './shell.ts' },
              toolContract: { specifier: './shell-commands.ts' },
            },
          },
        },
      }),
    );
    await writeFile(
      join(root, 'assets/shell.ts'),
      "throw new Error('product activated during help');",
    );
    await writeFile(
      join(root, 'assets/shell-commands.ts'),
      `export default { schemaVersion: '1.0.0', commands: [{
      id: 'shell.start', path: ['shell', 'start'], title: 'Start shell', summary: 'Product command', realm: 'build',
      argsSchema: '{"type":"object","properties":{"label":{"type":"string"},"root":{"type":"string"}},"required":["label","root"],"additionalProperties":false}',
      executor: './shell-execute.ts'
    }] };`,
    );
    expect(await runUnifiedCli(helpArgs)).toMatchObject({
      ok: true,
      value: { leaf: { title: 'Start shell', realm: 'build' } },
    });
    await writeFile(
      join(root, 'assets/shell.ts'),
      `import { registerAssetTools } from '@forgeax/engine/plugin';
      export default { inject: ['toolApi', 'pluginPrograms'], apply(ctx) { ctx.effect(() => registerAssetTools(ctx)); } };`,
    );
    await writeFile(
      join(root, 'assets/shell-execute.ts'),
      "export default async ({ label, root }) => ({ owner: 'shell', label, root });",
    );
    const args = ['shell', 'start', '--label', 'hello', '--root', root, '--json'];
    expect(await runUnifiedCli(args)).toMatchObject({
      ok: true,
      value: { owner: 'shell', label: 'hello', root },
    });
    await writeFile(join(root, 'forge.json'), JSON.stringify({ ...manifest, roots: {} }));
    expect(await runUnifiedCli(helpArgs)).toMatchObject({ ok: true });
    expect(await runUnifiedCli(args)).toMatchObject({
      ok: false,
      error: { code: 'tool-capability-unavailable' },
    });
    expect(await runUnifiedCli(['help', 'dev', 'start', '--root', root])).toMatchObject({
      ok: true,
    });
  });

  it('reads one profile artifact file for summary, frame and phase without decoding its path as data', async () => {
    const root = await fixtureRoot();
    const artifact = join(root, 'profile.json');
    await writeFile(
      artifact,
      JSON.stringify({
        schemaVersion: '1.0',
        captureId: 'capture-0001',
        timeUnit: 'microseconds',
        frameLimit: 1,
        eventLimit: 8,
        phaseCatalog: { app: ['frame-total'], render: [] },
        records: [
          {
            kind: 'phase',
            source: 'app',
            frameId: 1,
            phase: 'frame-total',
            startMicros: 1000,
            endMicros: 1100,
            durationMicros: 100,
          },
        ],
        completeness: { status: 'complete', retainedEventCount: 1, droppedEventCount: 0 },
      }),
    );
    for (const args of [
      ['summary'],
      ['frame', '--frame-id', '1'],
      ['phase', '--source', 'app', '--phase', 'frame-total'],
    ]) {
      const result = await runUnifiedCli([
        'profile',
        ...args,
        '--artifact',
        artifact,
        '--root',
        root,
        '--json',
      ]);
      expect(result, JSON.stringify({ args, result })).toMatchObject({ ok: true });
      expect(JSON.stringify(result.value)).toContain('capture-0001');
    }
    const missing = join(root, 'absent-profile.json');
    expect(
      await runUnifiedCli(['profile', 'summary', '--artifact', missing, '--root', root, '--json']),
    ).toMatchObject({
      ok: false,
      error: { code: 'cli-input-file-read-failed', detail: { path: missing } },
    });
  });
  it('runs read-only asset discovery without a caller-minted mutation request id', async () => {
    const root = await fixtureRoot();
    const listed = await runUnifiedCli(['asset', 'list', '--root', root, '--json']);
    expect(listed.ok).toBe(true);
    const inspectHelp = await runUnifiedCli(['help', 'asset', 'inspect', '--root', root, '--json']);
    expect(inspectHelp).toMatchObject({
      ok: true,
      value: {
        leaf: {
          inputSchema: {
            required: ['subject'],
            properties: {
              root: { type: 'string' },
              subject: { type: 'string' },
              json: { type: 'boolean' },
            },
          },
        },
      },
    });
    expect(JSON.stringify(inspectHelp.value)).not.toContain('requestId');
    const missingSubject = await runUnifiedCli(['asset', 'inspect', '--root', root, '--json']);
    expect(missingSubject).toMatchObject({ ok: false, error: { code: 'cli-parse-error' } });
    const created = await runUnifiedCli(['asset', 'source', 'create', '--root', root, '--json']);
    expect(created.ok).toBe(false);
    expect(created.error?.hint).toContain('requestId');
  });

  it('accepts the documented dry-run flag on the unified asset import command', async () => {
    const root = await fixtureRoot();
    const contribution = createUnifiedCommandContributions(root).find(
      (entry) => entry.descriptor.id === 'asset.import',
    );
    expect(contribution?.descriptor.inputSchema).toMatchObject({
      properties: { dryRun: { type: 'boolean' } },
    });
  });
  it('passes the canonical RHI workIndex from discovered CLI input to the replay owner', async () => {
    const root = await fixtureRoot();
    const result = await runUnifiedCli([
      'rhi',
      'inspect',
      '--root',
      root,
      '--artifact',
      join(root, 'missing.rhitape'),
      '--digest',
      'sha256:missing',
      '--work-index',
      '0',
      '--fields',
      '["pipeline"]',
      '--json',
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: 'artifact-read-failed' } });
  });

  it('uses one registry for progressive and recursive help', async () => {
    const root = await fixtureRoot();
    const immediate = await runUnifiedCli(['help', '--root', root, '--json']);
    expect(immediate.ok).toBe(true);
    const nodes = (immediate.value as { readonly nodes: readonly { readonly name: string }[] })
      .nodes;
    expect(nodes.map(({ name }) => name)).toEqual([
      'asset',
      'backend',
      'dev',
      'engine',
      'help',
      'preview',
      'profile',
      'project',
      'rhi',
      'sdk',
    ]);
    expect(nodes.every((node) => !('children' in node))).toBe(true);

    const tree = await runUnifiedCli(['help', 'dev', '--tree', '--root', root, '--json']);
    expect(tree.ok).toBe(true);
    expect(JSON.stringify(tree.value)).toContain('dev camera get');
    const leaf = await runUnifiedCli(['help', 'dev', 'focus', '--root', root, '--json']);
    expect(leaf.ok).toBe(true);
    expect(
      (leaf.value as { readonly leaf?: { readonly inputSchema?: unknown } }).leaf,
    ).toMatchObject({
      inputSchema: expect.any(Object),
    });
    const start = await runUnifiedCli(['help', 'dev', 'start', '--root', root, '--json']);
    expect(start.ok).toBe(true);
    expect(
      (
        start.value as {
          readonly leaf?: {
            readonly inputSchema?: { readonly properties?: Record<string, unknown> };
          };
        }
      ).leaf?.inputSchema?.properties?.workers,
    ).toMatchObject({
      type: 'object',
      properties: {
        engine: { enum: ['auto', true, false] },
        render: { enum: ['auto', true, false] },
        kernels: { enum: ['auto', true, false] },
      },
    });
  }, 60_000);

  it('keeps project plugin inspection JSON-safe and parses structured flags', async () => {
    const root = await fixtureRoot();
    const plugins = await runUnifiedCli(['asset', 'plugin', 'inspect', '--root', root, '--json']);
    expect(plugins).toMatchObject({ ok: true, value: { assets: [], roots: {} } });
    const camera = await runUnifiedCli([
      'dev',
      'camera',
      'set',
      '--root',
      root,
      '--revision',
      'missing',
      '--position',
      '[1,2,3]',
      '--json',
    ]);
    expect(camera.ok).toBe(false);
    expect(camera.error?.code).not.toBe('cli-parse-error');
  });

  it('accepts bounded asset pages and temporary camera lens fields from the CLI schema', async () => {
    const root = await fixtureRoot();
    const listed = await runUnifiedCli([
      'asset',
      'list',
      '--root',
      root,
      '--type',
      'mesh',
      '--limit',
      '1',
      '--cursor',
      '0',
      '--json',
    ]);
    expect(listed).toMatchObject({ ok: true, value: { items: [], page: { total: 0 } } });
    const camera = await runUnifiedCli([
      'dev',
      'camera',
      'set',
      '--root',
      root,
      '--revision',
      'missing',
      '--lens',
      '{"projection":"perspective","fov":1.0472}',
      '--exposure',
      '{"kind":"manual","multiplier":1}',
      '--json',
    ]);
    expect(camera).toMatchObject({ ok: false, error: { code: 'live-not-running' } });
  });

  it('declares live-not-running on every live leaf that can return it', async () => {
    const root = await fixtureRoot();
    const missing = await runUnifiedCli([
      'dev',
      'find',
      '--name',
      'Player',
      '--root',
      root,
      '--json',
    ]);
    expect(missing).toMatchObject({ ok: false, error: { code: 'live-not-running' } });
    const help = await runUnifiedCli(['help', 'dev', 'find', '--root', root, '--json']);
    expect((help.value as { leaf: { errors: readonly string[] } }).leaf.errors).toContain(
      'live-not-running',
    );
    const status = await runUnifiedCli(['help', 'dev', 'status', '--root', root, '--json']);
    expect((status.value as { leaf: { errors: readonly string[] } }).leaf.errors).not.toContain(
      'live-not-running',
    );
  });

  it('forwards native preview lane, viewport, and output options to the owner', async () => {
    const root = await fixtureRoot();
    nativePreviewRun.mockResolvedValue({
      outcome: 'succeeded',
      result: { kind: 'mesh', guid: 'mesh-guid' },
      artifacts: [],
    });
    const result = await runUnifiedCli([
      'asset',
      'preview',
      '--root',
      root,
      '--kind',
      'mesh',
      '--guid',
      'mesh-guid',
      '--backend',
      'software',
      '--headless=false',
      '--width',
      '128',
      '--height',
      '64',
      '--output',
      'artifacts/mesh.png',
      '--json',
    ]);
    expect(result).toMatchObject({ ok: true, value: { kind: 'mesh', guid: 'mesh-guid' } });
    expect(nativePreviewRun).toHaveBeenCalledOnce();
    expect(nativePreviewRun.mock.calls[0]?.[4]).toEqual({
      backend: 'software',
      headless: false,
      width: 128,
      height: 64,
      output: 'artifacts/mesh.png',
    });
  });

  it('keeps owner evidence refs visible when a native preview fails', async () => {
    const root = await fixtureRoot();
    const evidence = {
      kind: 'png' as const,
      digest: 'sha256:preview-failure',
      uri: '.forgeax/tool-runs/material.preview/fresh-replay.png',
      mediaType: 'image/png',
      sizeBytes: 128,
    };
    nativePreviewRun.mockResolvedValue({
      outcome: 'failed',
      failure: {
        code: 'tool-preview-capability-unavailable',
        expected: 'a supported preview representation',
        hint: 'Use a scene-backed material preview.',
        detail: { phase: 'capture-render' },
      },
      artifacts: [evidence],
    });
    const result = await runUnifiedCli([
      'asset',
      'preview',
      '--root',
      root,
      '--kind',
      'material',
      '--guid',
      'material-guid',
      '--json',
    ]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'tool-preview-capability-unavailable' },
      artifacts: [evidence],
    });
  });

  it('analyzes a retained preview report through its sibling manifest', async () => {
    const root = await fixtureRoot();
    const runRoot = join(root, '.forgeax', 'tool-runs', 'mesh.preview-run');
    await mkdir(runRoot, { recursive: true });
    await writeFile(
      join(runRoot, 'manifest.json'),
      JSON.stringify({
        schemaVersion: '2.0.0',
        identity: {
          runId: 'mesh.preview-run',
          snapshotDigest: 'sha256:snapshot',
          subjectDigest: 'sha256:subject',
          presentationDigest: 'sha256:presentation',
          captureId: 'capture',
          frameId: 1,
        },
        artifacts: [],
      }),
    );
    await writeFile(join(runRoot, 'report.json'), JSON.stringify({ runId: 'mesh.preview-run' }));
    const result = await runUnifiedCli([
      'preview',
      'analyze',
      '--root',
      root,
      '--artifact',
      join(runRoot, 'report.json'),
      '--json',
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: { runId: 'mesh.preview-run', captureId: 'capture', artifacts: [] },
    });
  });

  it('passes the FrameModel workIndex through the public RHI inspect CLI', async () => {
    const root = await fixtureRoot();
    const result = await runUnifiedCli([
      'rhi',
      'inspect',
      '--root',
      root,
      '--artifact',
      join(root, 'missing.rhitape'),
      '--digest',
      'sha256:fixture',
      '--work-index',
      '0',
      '--json',
    ]);
    // Reaching the real artifact reader proves both typed CLI parsing and
    // domain workIndex validation succeeded; no GPU is required for this gate.
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'artifact-read-failed',
        detail: { path: join(root, 'missing.rhitape') },
      },
    });
  });

  it('preserves domain report fields that resemble runtime envelopes', async () => {
    const root = await fixtureRoot();
    for (const report of [
      { ok: true, captures: [] },
      { ok: false, diagnostics: [] },
      { outcome: 'failed', observations: [] },
    ]) {
      const client = await createToolClient({
        projectRoot: root,
        projectDiscovery: async () => [],
        baseContributions: [
          command('report', 'Report', 'Returns a domain report.', async () => ({
            ok: true,
            value: report,
          })) as ToolContribution,
        ],
      });
      expect(await client.runPath(['report'], {})).toMatchObject({
        outcome: 'succeeded',
        result: report,
      });
    }
  });

  it('routes duplicate same-realm owners by explicit source and provider identity', async () => {
    const root = await fixtureRoot();
    const makeOwnerTool = (value: string) =>
      command(
        'shared.operation',
        'Shared operation',
        'A same-realm owner fixture.',
        async () => ({ ok: true, value: { owner: value } }),
        'host',
      ) as ToolContribution;
    const client = await createToolClient({
      projectRoot: root,
      projectDiscovery: async () => [],
      baseContributions: [],
      realmOwners: [
        {
          realm: 'host',
          sourceId: 'source-one',
          providerId: 'provider-one',
          contributions: [makeOwnerTool('one')],
        },
        {
          realm: 'host',
          sourceId: 'source-two',
          providerId: 'provider-two',
          contributions: [makeOwnerTool('two')],
        },
      ],
    });
    try {
      await expect(client.run('shared.operation', {})).resolves.toMatchObject({
        outcome: 'failed',
        failure: { code: 'tool-domain-failed', detail: { code: 'api-provider-route-required' } },
      });
      await expect(
        client.run('shared.operation', {}, { sourceId: 'source-two', providerId: 'provider-two' }),
      ).resolves.toMatchObject({ outcome: 'succeeded', result: { owner: 'two' } });
    } finally {
      await client.dispose?.();
    }
  });

  it('admits default providers for every tool realm', async () => {
    const root = await fixtureRoot();
    const realms = ['build', 'host', 'engine', 'frontend'] as const;
    const client = await createToolClient({
      projectRoot: root,
      projectDiscovery: async () => [],
      baseContributions: realms.map(
        (realm) =>
          command(
            `fixture.${realm}`,
            realm,
            'Realm provider fixture.',
            async () => ({ ok: true, value: { realm } }),
            realm,
          ) as ToolContribution,
      ),
    });
    try {
      for (const realm of realms) {
        await expect(client.runPath(['fixture', realm], {})).resolves.toMatchObject({
          outcome: 'succeeded',
          result: { realm },
        });
      }
    } finally {
      await client.dispose?.();
    }
  });

  it('accepts equals syntax for schema-typed values and root', async () => {
    const root = await fixtureRoot();
    expect(
      await runUnifiedCli([
        'dev',
        'camera',
        'set',
        `--root=${root}`,
        '--position=[1,2,3]',
        '--json',
      ]),
    ).toMatchObject({ ok: false, error: { code: 'live-not-running' } });
    expect(
      await runUnifiedCli(['asset', 'plugin', 'inspect', `--root=${root}`, '--json']),
    ).toMatchObject({ ok: true, value: { assets: [], roots: {} } });
  });

  it('rejects the removed exec entrance with a non-zero process result', async () => {
    const root = await fixtureRoot();
    const result = await runUnifiedCli(['exec', '--root', root, '--json']);
    expect(result).toMatchObject({ ok: false, error: { code: 'tool-command-not-found' } });
  });

  it('rejects unknown paths, flags, and malformed typed values before execution', async () => {
    const root = await fixtureRoot();
    await expect(runUnifiedCli(['help', 'dev', 'typo', '--root', root])).resolves.toMatchObject({
      ok: false,
      error: { code: 'tool-command-not-found' },
    });
    await expect(
      runUnifiedCli(['dev', 'status', '--unknown', '1', '--root', root]),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'cli-parse-error' },
    });
    await expect(
      runUnifiedCli(['dev', 'find', '--limit', 'not-an-integer', '--root', root]),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'cli-parse-error' },
    });
  });
});
