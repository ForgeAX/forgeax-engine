import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactCliResult } from '../cli-presentation.js';

const root = '/game';
const context = { root, args: { root }, tree: false };

function artifact(path: string, bytes: number) {
  return { path, mediaType: 'application/json', bytes, sha256: '0'.repeat(64) };
}

describe('compact CLI presentation', () => {
  it('summarizes build artifacts and points at the on-disk manifest', () => {
    const artifacts = [
      artifact('index.html', 900),
      artifact('pack-index.json', 50),
      ...Array.from({ length: 300 }, (_, index) => artifact(`assets/${index}.pack.json`, index)),
    ];
    const result = compactCliResult(
      {
        ok: true,
        command: 'project build',
        value: {
          schemaVersion: '1.0.0',
          target: 'browser',
          project: { id: 'game', name: 'Game' },
          base: '/',
          runtime: { packIndexUrl: 'pack-index.json', shaderManifestUrl: 'shaders/manifest.json' },
          artifacts,
        },
        artifacts: [],
      },
      { ...context, args: { root, outDir: 'release' } },
    );
    expect(result).toEqual({
      ok: true,
      command: 'project build',
      artifacts: [],
      value: {
        schemaVersion: '1.0.0',
        target: 'browser',
        project: { id: 'game', name: 'Game' },
        base: '/',
        runtime: { packIndexUrl: 'pack-index.json', shaderManifestUrl: 'shaders/manifest.json' },
        manifestPath: resolve(root, 'release/forgeax-dist.json'),
        entry: 'index.html',
        artifactCount: 302,
        artifactBytes: 950 + (299 * 300) / 2,
        largestArtifacts: [
          { path: 'index.html', bytes: 900 },
          { path: 'assets/299.pack.json', bytes: 299 },
          { path: 'assets/298.pack.json', bytes: 298 },
        ],
      },
      omitted: { fields: ['value.artifacts'], flag: '--detail' },
    });
    expect(JSON.stringify(result).length).toBeLessThan(1024);
  });

  it('keeps live status decisions and drops the execution report detail', () => {
    const selection = {
      requested: 'auto',
      enabled: true,
      reason: 'enabled',
      missingCapabilities: [],
    };
    const result = compactCliResult(
      {
        ok: true,
        command: 'dev status',
        value: {
          schemaVersion: '1.0.0',
          root,
          endpoint: 'http://127.0.0.1:1',
          phase: 'ready',
          revision: 'r1',
          url: 'http://127.0.0.1:2/',
          frameId: 42,
          bridgeConnected: true,
          workers: {
            engine: selection,
            render: selection,
            kernels: { ...selection, enabled: false, reason: 'no-eligible-kernel' },
          },
          execution: {
            schemaVersion: 3,
            capabilities: { worker: { available: true, reason: 'observed' } },
            engine: { realm: 'worker', health: 'running' },
            world: { identity: 'world-1', health: 'healthy', partialWrite: false, retryable: true },
            frame: { submitted: 42, completed: 41, inFlight: 1, highWater: 1, throttledTicks: 0 },
            performance: { hostFrameMs: { samples: 3, p50: 1, p95: 5.7612, p99: 9, jitter: 1 } },
            audio: { owner: 'host' },
            render: { epoch: 1, state: 'alive', submittedFrame: 42, completedFrame: 41 },
            fault: null,
          },
        },
        artifacts: [],
      },
      context,
    );
    expect(result.value).toEqual({
      schemaVersion: '1.0.0',
      root,
      endpoint: 'http://127.0.0.1:1',
      phase: 'ready',
      revision: 'r1',
      url: 'http://127.0.0.1:2/',
      frameId: 42,
      bridgeConnected: true,
      workers: {
        engine: true,
        render: true,
        kernels: { ...selection, enabled: false, reason: 'no-eligible-kernel' },
      },
      execution: {
        engine: 'running',
        world: 'healthy',
        worldIdentity: 'world-1',
        render: 'alive',
        frames: 41,
        hostFrameP95Ms: 5.76,
        engineUpdateP95Ms: null,
        fault: null,
      },
    });
    expect(result.omitted?.fields).toEqual(['value.workers', 'value.execution']);
  });

  it('leaves a stopped live status unchanged', () => {
    const stopped = { ok: true, command: 'dev status', value: { root, phase: 'stopped' } };
    expect(compactCliResult(stopped, context)).toBe(stopped);
  });

  it('replaces the UI authoring profile with its version', () => {
    const result = compactCliResult(
      {
        ok: true,
        command: 'project check',
        value: { root, projectId: 'game', uiAuthoringProfile: { version: '1', css: {} } },
      },
      context,
    );
    expect(result.value).toEqual({ root, projectId: 'game', uiAuthoringProfileVersion: '1' });
    expect(result.omitted?.fields).toEqual(['value.uiAuthoringProfile']);
  });

  it('reduces asset verification to counts and assets needing attention', () => {
    const asset = (guid: string, status: string, availability: string) => ({
      guid,
      type: 'plugin',
      source: { path: `${root}/assets/${guid}.pack.json`, format: 'pack.json', role: 'author' },
      output: { status, availability, freshness: 'unknown' },
      dependencies: [],
      producer: { state: 'not-run' },
    });
    const result = compactCliResult(
      {
        ok: true,
        command: 'asset verify',
        value: {
          schemaVersion: 'asset-verification-v1',
          root,
          scope: {
            sourceCount: 2,
            assetCount: 2,
            sourcePaths: [`${root}/assets/a.pack.json`],
            omittedSourceCount: 0,
            assetLimit: 256,
            truncated: false,
            scriptablePackSourceCount: 1,
            scriptablePackSources: [{ sourcePath: `${root}/assets/c.pack.ts` }],
            omittedScriptablePackSourceCount: 0,
          },
          assets: [asset('a', 'produced', 'available'), asset('b', 'produced', 'missing')],
          summary: { assetCount: 2 },
        },
      },
      context,
    );
    expect(result.value).toEqual({
      schemaVersion: 'asset-verification-v1',
      root,
      scope: {
        sourceCount: 2,
        assetCount: 2,
        omittedSourceCount: 0,
        assetLimit: 256,
        truncated: false,
        scriptablePackSourceCount: 1,
        omittedScriptablePackSourceCount: 0,
      },
      attention: [
        {
          guid: 'b',
          type: 'plugin',
          source: 'assets/b.pack.json',
          status: 'produced',
          availability: 'missing',
        },
      ],
      summary: { assetCount: 2 },
    });
  });

  it('lists unproduced assets up to the cap and counts the rest', () => {
    const assets = Array.from({ length: 25 }, (_, index) => ({
      guid: `g${index}`,
      type: 'plugin',
      source: { path: `${root}/assets/${index}.pack.ts` },
      output: { status: 'unproduced', availability: 'unknown', freshness: 'unknown' },
    }));
    const result = compactCliResult(
      {
        ok: true,
        command: 'asset verify',
        value: {
          schemaVersion: 'asset-verification-v1',
          root,
          scope: { sourceCount: 25, sourcePaths: [], scriptablePackSources: [] },
          assets: [
            { guid: 'ready', output: { status: 'produced', availability: 'available' } },
            ...assets,
          ],
          summary: { assetCount: 26, unproducedAssetCount: 25 },
        },
      },
      context,
    );
    const value = result.value as {
      readonly attention: readonly { readonly guid: string; readonly status: string }[];
      readonly omittedAttentionCount: number;
    };
    expect(value.attention).toHaveLength(20);
    expect(value.attention[0]).toMatchObject({
      guid: 'g0',
      status: 'unproduced',
      source: 'assets/0.pack.ts',
    });
    expect(value.attention.some(({ guid }) => guid === 'ready')).toBe(false);
    expect(value.omittedAttentionCount).toBe(5);
  });

  it('keeps a live fault and a failed render visible', () => {
    const fault = { code: 'world-step-failed', message: 'system threw', retryable: false };
    const result = compactCliResult(
      {
        ok: true,
        command: 'dev status',
        value: {
          root,
          phase: 'failed',
          error: 'world step failed',
          workers: {
            render: {
              requested: true,
              enabled: false,
              reason: 'missing-capability',
              missingCapabilities: ['offscreenCanvas'],
            },
          },
          execution: {
            engine: { realm: 'host', health: 'faulted' },
            world: { identity: 'world-2', health: 'poisoned', partialWrite: true },
            frame: { completed: 7 },
            performance: {},
            render: { state: 'failed' },
            fault,
          },
        },
      },
      context,
    );
    expect(result.value).toEqual({
      root,
      phase: 'failed',
      error: 'world step failed',
      workers: {
        render: {
          requested: true,
          enabled: false,
          reason: 'missing-capability',
          missingCapabilities: ['offscreenCanvas'],
        },
      },
      execution: {
        engine: 'faulted',
        world: 'poisoned',
        worldIdentity: 'world-2',
        partialWrite: true,
        render: 'failed',
        frames: 7,
        hostFrameP95Ms: null,
        engineUpdateP95Ms: null,
        fault,
      },
    });
  });

  it('keeps tree names and leaf purposes only', () => {
    const result = compactCliResult(
      {
        ok: true,
        command: 'help',
        value: {
          path: '',
          nodes: [
            {
              name: 'asset',
              path: 'asset',
              summary: 'echo of a descendant',
              children: [{ name: 'list', path: 'asset list', summary: 'Lists assets.' }],
            },
          ],
        },
      },
      { ...context, tree: true },
    );
    expect(result.value).toEqual({
      path: '',
      nodes: [{ name: 'asset', children: [{ name: 'list', summary: 'Lists assets.' }] }],
    });
  });

  it('never rewrites failures or leaf help', () => {
    const failed = { ok: false, command: 'project build', error: { code: 'game-build-failed' } };
    expect(compactCliResult(failed, context)).toBe(failed);
    const leaf = {
      ok: true,
      command: 'dev status',
      value: { path: 'dev status', nodes: [], leaf: { title: 'Live status' } },
    };
    expect(compactCliResult(leaf, { ...context, tree: true })).toBe(leaf);
  });
});
