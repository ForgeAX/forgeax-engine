import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactIncompleteError,
  artifactManifestError,
  cancellationError,
  capabilityUnavailableError,
  cleanupError,
  createArtifactRef,
  createAuthenticatedLoopbackTransport,
  createCarrierStateMachine,
  createLoopbackTransport,
  createRealmCapabilityMatrix,
  createServiceCapability,
  createSnapshotRef,
  createToolRuntime,
  defineTool,
  disconnectedError,
  domainFailureError,
  invalidArgsError,
  isSerializableValue,
  isSnapshotRef,
  snapshotStaleError,
  terminalError,
  terminalSnapshot,
  timeoutError,
  createPreviewArtifactManifest,
  validatePreviewArtifactManifest,
  validateArtifactRefs,
  validateRealmBootstrapPayload,
  type PreviewArtifactManifest,
} from '../src/index.js';
import {
  artifactManifestError as directArtifactManifestError,
} from '../src/errors.js';
import type { ToolContribution, ToolSchema } from '../src/types.js';

const textSchema: ToolSchema<string> = {
  parse(value) {
    return typeof value === 'string'
      ? { ok: true, value }
      : { ok: false, error: 'expected string' };
  },
};

const resultSchema: ToolSchema<unknown> = {
  parse(value) {
    return value !== undefined ? { ok: true, value } : { ok: false, error: 'missing result' };
  },
};

const manifest: PreviewArtifactManifest = {
  schemaVersion: '2.0.0',
  identity: {
    runId: 'run',
    snapshotDigest: 'sha256:snapshot',
    subjectDigest: 'sha256:subject',
    presentationDigest: 'sha256:presentation',
    frameId: 0,
    captureId: 'capture',
  },
  artifacts: [
    {
      owner: 'rhi-debug',
      kind: 'rhi-tape',
      role: 'rhi-tape',
      uri: 'file:///tape',
      digest: 'sha256:tape',
      byteLength: 1,
      mediaType: 'application/json',
      derivedFrom: [],
    },
    {
      owner: 'visual',
      kind: 'png',
      role: 'capture',
      uri: 'file:///frame',
      digest: 'sha256:png',
      byteLength: 1,
      mediaType: 'image/png',
      derivedFrom: [],
    },
    {
      owner: 'profiler',
      kind: 'profile-capture',
      role: 'profile-capture',
      uri: 'file:///profile',
      digest: 'sha256:profile',
      byteLength: 1,
      mediaType: 'application/json',
      derivedFrom: [],
    },
  ],
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        }),
    ),
  );
});

function tool(
  id: string,
  execute: ToolContribution<string, unknown>['execute'],
  schema: ToolSchema<unknown> = resultSchema,
): ToolContribution<string, unknown> {
  return defineTool(
    { id, title: id, summary: id, realm: 'build', argsSchema: textSchema, resultSchema: schema, evidence: [] },
    execute,
  );
}

describe('tool-runtime uncovered contracts', () => {
  it('covers snapshot, capability, serialization, refs, and error constructors', () => {
    const snapshot = createSnapshotRef({ revision: 0, digest: 'sha256:snapshot' });
    expect(isSnapshotRef(snapshot)).toBe(true);
    expect(isSnapshotRef({ revision: -1, digest: 'x' })).toBe(false);
    expect(isSnapshotRef({ revision: 1, digest: '' })).toBe(false);
    expect(isSnapshotRef(null)).toBe(false);
    expect(terminalSnapshot({ outcome: 'succeeded', result: 'ok', artifacts: [], snapshotAfter: snapshot })).toEqual(snapshot);
    expect(terminalSnapshot({ outcome: 'failed', failure: capabilityUnavailableError('x', 'build'), artifacts: [] })).toBeUndefined();
    expect(() => createSnapshotRef({ revision: -1, digest: 'x' })).toThrow();
    expect(() => createSnapshotRef({ revision: 1, digest: '' })).toThrow();
    expect(createArtifactRef({ kind: 'receipt', digest: 'sha256:r', sizeBytes: 0 })).toEqual({ kind: 'receipt', digest: 'sha256:r', sizeBytes: 0 });
    expect(() => createArtifactRef({ kind: 'png', digest: '', sizeBytes: 0 })).toThrow();
    expect(() => createArtifactRef({ kind: 'png', digest: 'x', sizeBytes: -1 })).toThrow();
    expect(validateArtifactRefs([{ kind: 'png', digest: 'x' }])).toBe(true);
    expect(validateArtifactRefs([{ kind: 'png', digest: 1 }])).toBe(false);
    expect(validateArtifactRefs(null)).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isSerializableValue(cycle)).toBe(false);
    expect(isSerializableValue({ nested: ['ok', 1, null] })).toBe(true);
    expect(validateRealmBootstrapPayload({ ok: true })).toEqual({ ok: true });
    expect(validateRealmBootstrapPayload({ fn: () => undefined }).ok).toBe(false);
    const serviceExpectation = {
      toolId: 'project.preview',
      descriptorDigest: 'sha256:descriptor',
      recipeDigest: 'sha256:recipe',
      workloadClass: 'preview.real-project-webgpu',
      codeDigest: 'sha256:code',
      browserVersion: 'Chromium 140',
      backend: 'webgpu' as const,
    };
    const admission = {
      schema: 'forgeax.tool-service-admission-ref.v1' as const,
      reportDigest: `sha256:${'a'.repeat(64)}`,
      ...serviceExpectation,
      frameCount: 300,
      samples: { privateCold: 30, privateWarm: 30, serviceCold: 30, serviceWarm: 30 },
      correctness: {
        terminalEquivalent: true,
        artifactIntegrity: true,
        freshReplay: true,
        hiddenParity: true,
        drawCalls: 2,
        nonBlackPixels: 100,
      },
      performance: {
        privateMedianMs: 100,
        privateP95Ms: 120,
        privateMaxMs: 140,
        privateRssBytes: 1000,
        serviceMedianMs: 70,
        serviceP95Ms: 90,
        serviceMaxMs: 145,
        serviceRssBytes: 1100,
      },
      cleanupPassed: true,
      evictionPassed: true,
    };
    expect(createServiceCapability(admission, serviceExpectation)).toEqual({
      available: true,
      reportDigest: admission.reportDigest,
    });
    expect(createServiceCapability({ ...admission, recipeDigest: 'sha256:other' }, serviceExpectation)).toMatchObject({
      available: false,
      detail: { reason: 'admission recipeDigest does not match this run' },
    });
    expect(createServiceCapability(undefined, serviceExpectation)).toMatchObject({ available: false, detail: { reason: expect.any(String) } });
    const matrix = createRealmCapabilityMatrix({ catalogDigest: 'sha256:catalog', supported: { build: true, host: false, engine: true } });
    expect(matrix.realms.host).toMatchObject({ supported: false, reason: 'realm-capability-unavailable' });
    expect(invalidArgsError('bad', null).code).toBe('tool-invalid-args');
    expect(snapshotStaleError('a', 'b').code).toBe('tool-snapshot-stale');
    expect(domainFailureError('x').code).toBe('tool-domain-failed');
    expect(domainFailureError('x', 'expected', 'hint', { value: 1 }).detail).toMatchObject({ payload: { value: 1 } });
    expect(artifactIncompleteError(['png'], 'run').code).toBe('tool-artifact-incomplete');
    expect(cancellationError('stop').code).toBe('tool-run-cancelled');
    expect(timeoutError(5).code).toBe('tool-run-timeout');
    expect(disconnectedError('loopback').code).toBe('tool-run-disconnected');
    expect(terminalError('run', 'succeeded').code).toBe('tool-run-terminal');
    expect(cleanupError('run', 'failed').code).toBe('tool-cleanup-failed');
    expect(directArtifactManifestError('expected', 'hint', { reason: 'bad' }).code).toBe('tool-artifact-manifest-invalid');
    expect(() => createSnapshotRef({ revision: Number.NaN, digest: 'x' })).toThrow();
  });

  it('covers manifest identity, entry, duplicate, and required-evidence failures', () => {
    expect(createPreviewArtifactManifest(manifest)).toEqual(manifest);
    expect(validatePreviewArtifactManifest(manifest, ['capture', 'rhi-tape', 'profile-capture']).ok).toBe(true);
    const cases: unknown[] = [
      { ...manifest, schemaVersion: '0.1.0' },
      { ...manifest, identity: { ...manifest.identity, runId: '' } },
      { ...manifest, identity: { ...manifest.identity, frameId: -1 } },
      { ...manifest, artifacts: [{ ...manifest.artifacts[0], owner: '' }, ...manifest.artifacts.slice(1)] },
      { ...manifest, artifacts: [{ ...manifest.artifacts[0], uri: '' }, ...manifest.artifacts.slice(1)] },
      { ...manifest, artifacts: [{ ...manifest.artifacts[0], digest: '' }, ...manifest.artifacts.slice(1)] },
      { ...manifest, artifacts: [{ ...manifest.artifacts[0], byteLength: -1 }, ...manifest.artifacts.slice(1)] },
      { ...manifest, artifacts: [...manifest.artifacts, manifest.artifacts[0]] },
    ];
    for (const candidate of cases)
      expect(
        validatePreviewArtifactManifest(candidate as PreviewArtifactManifest, ['capture']).ok,
      ).toBe(false);
    expect(
      validatePreviewArtifactManifest(
        { ...manifest, artifacts: manifest.artifacts.slice(0, 2) },
        ['profile-capture'],
      ).ok,
    ).toBe(false);
    expect(() =>
      createPreviewArtifactManifest({ ...manifest, schemaVersion: '1.0.0' as '2.0.0' }),
    ).toThrow();
  });

  it('covers loopback transport validation, payload rejection, and close state', async () => {
    const transport = createLoopbackTransport('http://127.0.0.1:1234/run');
    expect(transport.connected).toBe(true);
    expect(transport.send({ recipe: 'ok' })).toBe(true);
    expect(transport.send({ fn: () => undefined })).toBe(false);
    transport.close();
    expect(transport.connected).toBe(false);
    expect(transport.send({ recipe: 'ok' })).toBe(false);
    expect(() => createLoopbackTransport('https://127.0.0.1/run')).toThrow();
    expect(() => createLoopbackTransport('http://192.168.0.1/run')).toThrow();

    const server = createServer((request, response) => {
      if (request.url === '/ok') {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ outcome: 'succeeded', result: 'ok', artifacts: [] }));
      } else {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: 'server failed' }));
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server address missing');
    const options = { endpoint: `http://127.0.0.1:${address.port}/ok`, bearerToken: 'token-1234' };
    const authenticated = createAuthenticatedLoopbackTransport(options);
    await expect(authenticated.request({ descriptorDigest: 'd', recipeDigest: 'r', args: {} }, 'wrong')).rejects.toThrow('rejected');
    await expect(authenticated.request({ descriptorDigest: 'd', recipeDigest: 'r', args: { fn: () => undefined } }, options.bearerToken)).rejects.toThrow('structured-clone');
    await expect(authenticated.request({ descriptorDigest: 'd', recipeDigest: 'r', args: {} }, options.bearerToken)).resolves.toMatchObject({ outcome: 'succeeded' });
    const failing = createAuthenticatedLoopbackTransport({ ...options, endpoint: options.endpoint.replace('/ok', '/fail') });
    await expect(failing.request({ descriptorDigest: 'd', recipeDigest: 'r', args: {} }, options.bearerToken)).rejects.toThrow('server failed');
    failing.close();
    authenticated.close();
    await expect(authenticated.request({ descriptorDigest: 'd', recipeDigest: 'r', args: {} }, options.bearerToken)).rejects.toThrow('disconnected');
    expect(() => createAuthenticatedLoopbackTransport({ endpoint: 'https://127.0.0.1/run', bearerToken: options.bearerToken })).toThrow();
    expect(() => createAuthenticatedLoopbackTransport({ endpoint: options.endpoint, bearerToken: 'short' })).toThrow();
  });

  it('covers runtime validation, terminal forms, and lifecycle failure paths', async () => {
    expect(() => tool('Bad ID', async () => 'ok')).toThrow();
    expect(() => defineTool({ id: 'valid.id', title: '', summary: 'x', realm: 'build', argsSchema: textSchema, resultSchema, evidence: [] }, async () => 'ok')).toThrow();
    expect(() => defineTool({ id: 'valid.id', title: 'x', summary: '', realm: 'build', argsSchema: textSchema, resultSchema, evidence: [] }, async () => 'ok')).toThrow();
    expect(() => defineTool({ id: 'valid.id', title: 'x', summary: 'x', realm: 'build', argsSchema: textSchema, resultSchema, evidence: 'png' as never }, async () => 'ok')).toThrow();
    const duplicate = tool('duplicate.id', async () => 'ok');
    expect(() => createToolRuntime([duplicate, duplicate])).toThrow();
    expect(() => createToolRuntime([null])).toThrow();
    expect(() => createToolRuntime([{ descriptor: { id: 'bad' } }])).toThrow();
    const invalidArgs = tool('invalid.args', async () => 'ok');
    const runtime = createToolRuntime([invalidArgs]);
    expect(await runtime.run(invalidArgs, 1 as never).terminal).toMatchObject({ outcome: 'failed', failure: { code: 'tool-invalid-args' } });
    expect(runtime.list()).toHaveLength(1);
    expect(runtime.describe('missing')).toBeUndefined();
    expect(runtime.get('missing')).toBeUndefined();

    const terminalFailure = tool('terminal.failure', async () => ({ outcome: 'failed' as const, failure: domainFailureError('producer'), artifacts: [] }));
    const okTerminal = tool('terminal.ok', async () => ({ outcome: 'succeeded' as const, result: 'done', artifacts: [], snapshotAfter: { revision: 1, digest: 'sha256:after' } }));
    const falseResult = tool('false.result', async () => ({ ok: false as const, error: { code: 'bad', detail: { message: 'bad' } } }));
    const structuredHint = tool('structured.hint', async () => ({
      ok: false as const,
      error: {
        code: 'producer-failed',
        expected: 'the producer to succeed',
        hint: { reason: 'gpu-lost', code: 42 } as unknown as string,
      },
    }));
    const falseArtifact = createArtifactRef({ kind: 'png', digest: 'sha256:failure', uri: 'file:///failure.png' });
    const falseResultWithArtifact = tool('false.result.artifact', async () => ({ ok: false as const, error: { code: 'bad', detail: { message: 'bad' } }, artifacts: [falseArtifact] }));
    const invalidResult = tool('invalid.result', async () => ({ object: new Date() }));
    const schemaFailure = tool('schema.failure', async () => undefined, { parse: () => ({ ok: false, error: 'schema' }) });
    const invalidArtifact = tool('invalid.artifact', async () => ({ ok: true as const, value: 'ok', artifacts: [{ kind: 'png', digest: 1 }] as never }));
    const all = createToolRuntime([terminalFailure, okTerminal, falseResult, falseResultWithArtifact, invalidResult, schemaFailure, invalidArtifact]);
    expect(await all.run(terminalFailure, 'x').terminal).toMatchObject({ outcome: 'failed', failure: { code: 'tool-domain-failed' } });
    const structuredHintRuntime = createToolRuntime([structuredHint]);
    const structuredHintTerminal = await structuredHintRuntime.run(structuredHint, 'x').terminal;
    expect(structuredHintTerminal.outcome).toBe('failed');
    if (structuredHintTerminal.outcome === 'failed') {
      // A structured producer hint stays readable instead of String() loss.
      expect(typeof structuredHintTerminal.failure.hint).toBe('string');
      expect(structuredHintTerminal.failure.hint).toContain('gpu-lost');
    }
    expect(await all.run(okTerminal, 'x').terminal).toMatchObject({ outcome: 'succeeded', snapshotAfter: { revision: 1 } });
    expect(await all.run(falseResult, 'x').terminal).toMatchObject({ outcome: 'failed', failure: { code: 'tool-domain-failed' } });
    expect(await all.run(falseResultWithArtifact, 'x').terminal).toMatchObject({ outcome: 'failed', failure: { code: 'tool-domain-failed' }, artifacts: [falseArtifact] });
    expect(await all.run(invalidResult, 'x').terminal).toMatchObject({ outcome: 'failed', failure: { code: 'tool-domain-failed' } });
    expect(await all.run(schemaFailure, 'x').terminal).toMatchObject({ outcome: 'failed', failure: { code: 'tool-domain-failed' } });
    expect(await all.run(invalidArtifact, 'x').terminal).toMatchObject({ outcome: 'failed', failure: { code: 'tool-domain-failed' } });
    expect(await all.run(okTerminal, 'x', { snapshot: { revision: 1, digest: 'sha256:before' } }).terminal).toMatchObject({ outcome: 'succeeded', snapshotAfter: { revision: 1 } });

    let release: (() => void) | undefined;
    const pending = tool('pending.lifecycle', async (_args, context) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return 'done';
    });
    const lifecycle = createToolRuntime([pending]);
    const disconnected = lifecycle.run(pending, 'x');
    disconnected.disconnect('socket');
    expect(await disconnected.terminal).toMatchObject({ outcome: 'failed', failure: { code: 'tool-run-disconnected' } });
    release?.();
    const providerExit = lifecycle.run(pending, 'x');
    providerExit.providerExit('worker');
    expect(await providerExit.terminal).toMatchObject({ outcome: 'failed', failure: { code: 'tool-domain-failed' } });
    release?.();
    const timeout = lifecycle.run(pending, 'x', { deadlineMs: 0 });
    expect(await timeout.terminal).toMatchObject({ outcome: 'failed', failure: { code: 'tool-run-timeout' } });
    release?.();
    const abortController = new AbortController();
    abortController.abort('cancelled');
    const aborted = lifecycle.run(pending, 'x', { signal: abortController.signal });
    expect(await aborted.terminal).toMatchObject({ outcome: 'failed', failure: { code: 'tool-run-cancelled' } });
    release?.();
  });

  it('covers carrier lease overload, wrong lease, and fallback boundaries', () => {
    expect(() => createCarrierStateMachine({ projectId: '', consumerId: 'c', endpoint: 'http://127.0.0.1:1', now: 0, ttlMs: 1 })).toThrow();
    expect(() => createCarrierStateMachine({ projectId: 'p', consumerId: 'c', endpoint: 'https://127.0.0.1:1', now: 0, ttlMs: 1 })).toThrow();
    expect(() => createCarrierStateMachine({ projectId: 'p', consumerId: 'c', endpoint: 'http://127.0.0.1:1', now: Infinity, ttlMs: 1 })).toThrow();
    const machine = createCarrierStateMachine({ projectId: 'p', consumerId: 'c', endpoint: 'http://127.0.0.1:1', now: 0, ttlMs: 100 });
    expect(machine.lease('missing', { consumerId: 'c', bearerToken: machine.offer.bearerToken, now: 1 })).toMatchObject({ ok: false, error: { code: 'carrier-token-invalid' } });
    expect(machine.started('missing')).toMatchObject({ ok: false, error: { code: 'carrier-lease-required' } });
    expect(machine.exit('missing')).toMatchObject({ ok: false, error: { code: 'carrier-lease-required' } });
    expect(machine.lease({ consumerId: 'c', bearerToken: machine.offer.bearerToken, now: 1 })).toMatchObject({ ok: true });
    const leaseId = machine.snapshot().leaseId;
    if (leaseId === undefined) throw new Error('lease missing');
    expect(machine.lease(`wrong:${leaseId}`, { consumerId: 'c', bearerToken: machine.offer.bearerToken, now: 2 })).toMatchObject({ ok: false, error: { code: 'carrier-token-invalid' } });
    expect(machine.started(leaseId)).toMatchObject({ ok: true });
    expect(machine.lease({ consumerId: 'c', bearerToken: machine.offer.bearerToken, now: 2 })).toMatchObject({ ok: false, error: { code: 'carrier-started' } });
  });
});
