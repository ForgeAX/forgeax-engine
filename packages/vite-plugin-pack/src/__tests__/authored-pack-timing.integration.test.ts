import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';
import { testGate } from '../../../../scripts/test/test-gate.mjs';
import type { PluginPackProgress } from '../plugin-contract.js';
import { createPluginPackInternal } from '../plugin-pack.js';

type TimingRecord = Record<string, unknown>;

function captureTimings() {
  const records: TimingRecord[] = [];
  vi.spyOn(console, 'error').mockImplementation((prefix: unknown, body: unknown) => {
    if (prefix === '[forgeax.authored-pack.timing]' && typeof body === 'string')
      records.push(JSON.parse(body));
  });
  return records;
}

async function createPublicationFixture(cook: NativeCooker['cook']) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-authored-pack-timing-'));
  const path = join(root, 'fixture.pack.ts');
  await writeFile(
    path,
    `export default {
      schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(79),
      build() { return { ok: true, value: {
        room: { kind: 'fixture-binary', execution: 'cooked', source: { text: 'original' } }
      } }; }
    };`,
  );
  const serve = async (scope: string, onProgress?: (event: PluginPackProgress) => void) => {
    const plugin = createPluginPackInternal({
      roots: [path],
      watch: false,
      onProgress,
      cookers: [{ key: 'fixture-binary', cacheIdentity: () => 'fixture/1', cook }],
      runtimeBinding: createStandaloneRuntimeAssetBinding(scope),
      ddc: {
        buildCacheRoot: join(root, 'build-cache'),
        identityRoot: root,
        projectDdcRoot: join(root, 'project-ddc'),
      },
    });
    try {
      plugin.configureServer({ middlewares: { use() {} }, ws: { send() {} } });
      await plugin.ready();
      const [row] = plugin.catalogSnapshot();
      expect(row?.publication).toBeDefined();
      return row?.publication;
    } finally {
      await plugin.closeBundle();
    }
  };
  return { path, serve, close: () => rm(root, { recursive: true, force: true }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('reports a real blocked cook before readiness and isolates observer failures', async () => {
  vi.stubEnv('FORGEAX_WORKSPACE_TIMING', '0');
  const { promise: blocked, resolve: release } = testGate();
  const events: PluginPackProgress[] = [];
  const fixture = await createPublicationFixture(async ({ guid }) => {
    await blocked;
    return {
      guid,
      payload: { kind: 'fixture-binary' },
      refs: [],
      artifacts: {},
      inputFingerprint: 'progress',
    };
  });
  const serving = fixture.serve('progress', (event) => {
    events.push(event);
    throw new Error('observer failure');
  });
  try {
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'source' && event.source.phase === 'cook')).toBe(
        true,
      ),
    );
    expect(events.some((event) => event.kind === 'stage' && event.stage === 'ready')).toBe(false);
    release();
    await serving;
    expect(events.at(-1)).toMatchObject({ kind: 'stage', stage: 'ready' });
  } finally {
    release();
    await serving.catch(() => {});
    await fixture.close();
  }
});

it.each([
  true,
  false,
])('observes real cold and admitted cached publication with timing=%s', async (enabled) => {
  vi.stubEnv('FORGEAX_WORKSPACE_TIMING', enabled ? '1' : '0');
  const records = captureTimings();
  let cooks = 0;
  const fixture = await createPublicationFixture(({ guid, source }) => {
    cooks++;
    expect(source).toEqual({ text: 'original' });
    return {
      guid,
      payload: { kind: 'fixture-binary', text: 'original' },
      refs: [],
      artifacts: {
        body: {
          mediaType: 'application/octet-stream',
          bytes: new TextEncoder().encode('original'),
        },
      },
      inputFingerprint: 'original',
    };
  });
  try {
    const first = await fixture.serve('first');
    const second = await fixture.serve('second');
    expect(second?.digest).toBe(first?.digest);
    expect(second?.receipt.inputFingerprint).toBe(first?.receipt.inputFingerprint);
    expect(cooks).toBe(1);
    if (!enabled) {
      expect(records).toEqual([]);
      return;
    }
    const sources = records.filter((record) => record.stage === 'produce-source');
    expect(sources.map(({ phase, status, cache }) => [phase, status, cache])).toEqual([
      ['cache', 'start', undefined],
      ['cache', 'end', undefined],
      ['cook', 'start', 'miss'],
      ['cook', 'end', 'miss'],
      ['persist', 'start', 'miss'],
      ['persist', 'end', 'miss'],
      ['ready', 'end', 'miss'],
      ['cache', 'start', undefined],
      ['cache', 'end', undefined],
      ['ready', 'end', 'hit'],
    ]);
    for (const record of sources) {
      expect(record.sourcePath).toBe(fixture.path);
      expect(record.elapsedMs).toEqual(expect.any(Number));
      if (record.status === 'end') expect(record.durationMs).toBeGreaterThanOrEqual(0);
    }
    const recipes = records.filter((record) => record.stage === 'native-cook');
    expect(recipes).toHaveLength(2);
    expect(recipes[0]).toMatchObject({
      recipe: 'fixture-binary',
      sourcePath: fixture.path,
      sourceKey: 'room',
      status: 'start',
    });
    expect(recipes[1]).toMatchObject({
      recipe: 'fixture-binary',
      sourcePath: fixture.path,
      sourceKey: 'room',
      status: 'end',
      guid: recipes[0]?.guid,
    });
    expect(recipes[1]?.durationMs).toBeGreaterThanOrEqual(0);
  } finally {
    await fixture.close();
  }
});

it('retains the original failed recipe and unfinished source without a ready record', async () => {
  vi.stubEnv('FORGEAX_WORKSPACE_TIMING', '1');
  const records = captureTimings();
  const cause = Object.assign(new Error('original recipe failure'), {
    code: 'fixture-cook-failed',
    detail: { reason: 'original' },
  });
  const fixture = await createPublicationFixture(() => {
    throw cause;
  });
  const progress: PluginPackProgress[] = [];
  try {
    await expect(fixture.serve('failed', (event) => progress.push(event))).rejects.toMatchObject({
      code: 'produce-failed',
    });
    expect(progress.some((event) => event.kind === 'stage' && event.stage === 'failed')).toBe(true);
    expect(progress.some((event) => event.kind === 'stage' && event.stage === 'ready')).toBe(false);
    expect(
      records.find((record) => record.stage === 'native-cook' && record.status === 'failed'),
    ).toMatchObject({
      recipe: 'fixture-binary',
      sourcePath: fixture.path,
      sourceKey: 'room',
      failure: { code: 'fixture-cook-failed', message: cause.message, detail: cause.detail },
    });
    expect(
      records.find((record) => record.stage === 'produce-source' && record.status === 'unfinished'),
    ).toMatchObject({
      sourcePath: fixture.path,
      phase: 'cook',
      failure: { code: 'native-cook-failed' },
    });
    expect(
      records.find((record) => record.stage === 'produce-and-cook' && record.status === 'failed'),
    ).toMatchObject({ failure: { code: 'native-cook-failed' } });
    expect(records.some((record) => record.phase === 'ready')).toBe(false);
  } finally {
    await fixture.close();
  }
});
