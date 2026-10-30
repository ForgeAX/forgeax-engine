// packages/wgpu-wasm/src/__tests__/ensureReady.test.ts — singleton-wrapper contract
// (plan-strategy D-P3 / research F-4).
//
// The three assertions below are the SSOT for the ensureReady contract:
//
// 1. Reference equality across calls (charter proposition 6 Idempotency):
//    ensureReady() === ensureReady() — N calls return the same Promise reference.
// 2. Reference equality across awaits: (await ensureReady()) === (await ensureReady())
//    — the resolved wasm namespace is the same object, N times.
// 3. Retry on transient failure (charter proposition 4 Explicit Failure):
//    if init rejects, the cached rejection is cleared (null-reset) and a subsequent
//    ensureReady() retries _loadWasm(). A second init that succeeds returns the
//    wasm namespace.
//
// The wasm namespace is mocked, while the provenance inputs are deterministic
// real bytes so the singleton tests exercise the same integrity gate as Node.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Track the number of init() invocations so we can assert "no second call after success".
/** @internal */
let _initCallCount = 0;
/** @internal */
let _initBehaviour: 'success' | 'reject' = 'success';

vi.mock('../../pkg/wgpu_wasm.js', () => {
  return {
    // Mock the wasm namespace surface (a placeholder identity object stays sufficient
    // for reference-equality assertions; production wasm symbols are not exercised
    // here — that responsibility belongs to integration tests).
    default: vi.fn((_input: unknown) => {
      _initCallCount += 1;
      if (_initBehaviour === 'reject') {
        return Promise.reject(new Error('mock init failure'));
      }
      return Promise.resolve({});
    }),
    parse: vi.fn(),
    validate: vi.fn(),
    emit_reflection: vi.fn(),
    RhiWgpuInstance: { create: vi.fn() },
  };
});

const MOCK_ARTIFACT = new Uint8Array([1, 2, 3]);
const MOCK_GLUE = new TextEncoder().encode('mock glue');
const MOCK_MANIFEST = new TextEncoder().encode(
  JSON.stringify({
    schemaVersion: 'wgpu-wasm-provenance/1',
    sourceContentKey: 'sha256-test',
    artifactSha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    artifactBytes: 3,
    glueSha256: 'f858c73a03609210271a7318f80bcec0cf278e0d86f7d098768993b83ed2f761',
    glueBytes: 9,
    toolchain: { rustc: 'test', wasmPack: 'test', wasmBindgen: 'test' },
    dependencies: { wgpu: 'test', naga: 'test', nagaOil: 'test', wasmBindgen: 'test' },
    compilerFingerprint: 'sha256-453c78d3ce45ec508b01c3f8319f99934c544599baf6aeeae1914e3bcc8723df',
  }),
);
let mockManifestBytes: Uint8Array = MOCK_MANIFEST;
let mockArtifactBytes: Uint8Array = MOCK_ARTIFACT;

async function manifestFor(artifact: Uint8Array): Promise<Uint8Array> {
  const sha256 = async (bytes: Uint8Array): Promise<string> =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  const original = JSON.parse(new TextDecoder().decode(MOCK_MANIFEST));
  const facts = {
    schemaVersion: original.schemaVersion,
    sourceContentKey: original.sourceContentKey,
    artifactSha256: await sha256(artifact),
    glueSha256: original.glueSha256,
    toolchain: original.toolchain,
    dependencies: original.dependencies,
  };
  return new TextEncoder().encode(
    JSON.stringify({
      ...original,
      ...facts,
      artifactBytes: artifact.byteLength,
      compilerFingerprint: `sha256-${await sha256(new TextEncoder().encode(JSON.stringify(facts)))}`,
    }),
  );
}

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    if (path.endsWith('provenance.json')) return mockManifestBytes;
    if (path.endsWith('wgpu_wasm.js')) return MOCK_GLUE;
    return mockArtifactBytes;
  }),
}));

describe('ensureReady singleton wrapper', () => {
  beforeEach(async () => {
    // Reset module state so each test exercises a fresh _instance closure.
    _initCallCount = 0;
    _initBehaviour = 'success';
    mockManifestBytes = MOCK_MANIFEST;
    mockArtifactBytes = MOCK_ARTIFACT;
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns the same Promise reference across N calls (charter proposition 6 idempotency)', async () => {
    const mod = await import('../index.js');
    const p1 = mod.ensureReady();
    const p2 = mod.ensureReady();
    const p3 = mod.ensureReady();
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    // init() must be called exactly once even after 3 ensureReady() calls.
    await p1;
    expect(_initCallCount).toBe(1);
  });

  it('returns the same wasm namespace reference across N awaits (charter proposition 6 idempotency)', async () => {
    const mod = await import('../index.js');
    const ns1 = await mod.ensureReady();
    const ns2 = await mod.ensureReady();
    expect(ns1).toBe(ns2);
    expect(_initCallCount).toBe(1);
  });

  it('retries _loadWasm after transient failure (null-reset, charter proposition 4 retry)', async () => {
    _initBehaviour = 'reject';
    const mod = await import('../index.js');
    // First call rejects — init runs once.
    await expect(mod.ensureReady()).rejects.toThrow('mock init failure');
    expect(_initCallCount).toBe(1);
    // Switch to success — the cached rejection was null-reset, so the next
    // ensureReady() retries _loadWasm and succeeds.
    _initBehaviour = 'success';
    const ns = await mod.ensureReady();
    expect(_initCallCount).toBe(2);
    expect(typeof ns).toBe('object');
  });

  it('rejects tampered provenance before invoking wasm init', async () => {
    mockManifestBytes = new TextEncoder().encode(
      new TextDecoder().decode(MOCK_MANIFEST).replace('sha256-test', 'sha256-tampered'),
    );
    const mod = await import('../index.js');
    await expect(mod.ensureReady()).rejects.toThrow('compiler fingerprint');
    expect(_initCallCount).toBe(0);
  });

  it('returns the identity of the verified initialized owner while preserving the ready Promise', async () => {
    const mod = await import('../index.js');
    const ready = mod.ensureReady();
    expect(await mod.getCompilerFingerprint()).toBe(
      JSON.parse(new TextDecoder().decode(MOCK_MANIFEST)).compilerFingerprint,
    );
    expect(mod.ensureReady()).toBe(ready);
    expect(_initCallCount).toBe(1);
  });

  it('changes identity after a new verified native payload with unchanged glue and keeps loaded identity stable', async () => {
    const mod = await import('../index.js');
    const original = await mod.getCompilerFingerprint();
    mockArtifactBytes = new Uint8Array([4, 5, 6]);
    mockManifestBytes = await manifestFor(mockArtifactBytes);
    // Disk changes do not pretend that the already-loaded compiler changed.
    expect(await mod.getCompilerFingerprint()).toBe(original);
    mod.__resetForTests();
    const replacement = await mod.getCompilerFingerprint();
    expect(replacement).not.toBe(original);
    expect(replacement).toBe(
      JSON.parse(new TextDecoder().decode(mockManifestBytes)).compilerFingerprint,
    );
    expect(_initCallCount).toBe(2);
  });

  it('rejects an invalid identity-only load and retries without publishing a stale fingerprint', async () => {
    const mod = await import('../index.js');
    mockArtifactBytes = new Uint8Array([4, 5, 6]);
    await expect(mod.getCompilerFingerprint()).rejects.toThrow('artifact bytes');
    expect(_initCallCount).toBe(0);
    mockManifestBytes = await manifestFor(mockArtifactBytes);
    await expect(mod.getCompilerFingerprint()).resolves.toBe(
      JSON.parse(new TextDecoder().decode(mockManifestBytes)).compilerFingerprint,
    );
    expect(_initCallCount).toBe(1);
  });

  it('normalizes Vite raw glue transport before provenance verification', async () => {
    // Import while Vite's own Node transport still has process; the tested loader
    // detects the browser branch when ensureReady runs below.
    const mod = await import('../index.js');
    vi.stubGlobal('process', undefined);
    const fetchMock = vi.fn(async (input: URL) => {
      const url = new URL(input.href);
      const response = (bytes: Uint8Array): Response =>
        ({
          ok: true,
          arrayBuffer: async () => bytes.slice().buffer,
        }) as Response;

      if (url.pathname.endsWith('/provenance.json')) {
        return response(MOCK_MANIFEST);
      }
      if (url.pathname.endsWith('/wgpu_wasm_bg.wasm')) {
        return response(MOCK_ARTIFACT);
      }
      expect(url.pathname.endsWith('/wgpu_wasm.js')).toBe(true);
      expect(url.search).toBe('?raw');
      expect(url.searchParams.has('raw')).toBe(true);
      const glueSource = new TextDecoder().decode(MOCK_GLUE);
      return response(new TextEncoder().encode(`export default ${JSON.stringify(glueSource)}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(mod.ensureReady()).resolves.toBeDefined();
    expect(_initCallCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    { encoding: 'base64', tampered: false },
    { encoding: 'percent', tampered: false },
    { encoding: 'base64', tampered: true },
    { encoding: 'percent', tampered: true },
  ])('verifies embedded $encoding provenance without fetch (tampered=$tampered)', async ({
    encoding,
    tampered,
  }) => {
    const mod = await import('../index.js');
    const NativeURL = globalThis.URL;
    const manifest = new TextDecoder()
      .decode(MOCK_MANIFEST)
      .replace('sha256-test', tampered ? 'sha256-tampered' : 'sha256-test');
    const embedded =
      encoding === 'base64'
        ? `data:application/json;charset=utf-8;base64,${btoa(manifest)}`
        : `data:application/json,${encodeURIComponent(manifest)}`;
    vi.stubGlobal(
      'URL',
      class extends NativeURL {
        constructor(input: string | URL, base?: string | URL) {
          super(String(input).endsWith('/provenance.json') ? embedded : input, base);
        }
      },
    );
    vi.stubGlobal('process', undefined);
    const fetchMock = vi.fn(async (input: URL) => {
      if (input.protocol === 'data:') throw new TypeError('Failed to fetch');
      const bytes = input.pathname.endsWith('/wgpu_wasm_bg.wasm') ? MOCK_ARTIFACT : MOCK_GLUE;
      return new Response(bytes.slice().buffer);
    });
    vi.stubGlobal('fetch', fetchMock);
    if (tampered) {
      await expect(mod.ensureReady()).rejects.toThrow('compiler fingerprint');
      expect(_initCallCount).toBe(0);
    } else {
      await expect(mod.ensureReady()).resolves.toBeDefined();
      expect(_initCallCount).toBe(1);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
