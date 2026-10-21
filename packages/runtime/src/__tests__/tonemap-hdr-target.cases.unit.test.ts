// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { Renderer as RendererType } from '@forgeax/engine-render';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardMaterialShaderVariants } from './helpers/standard-material-manifest';

afterEach(() => vi.restoreAllMocks());
{
  // --- from tonemap-hdr-target.test.ts ---

  const ENGINE = '../createRenderer';
  // Load the runtime source graph before measuring each bootstrap assertion.
  beforeAll(async () => {
    await import(ENGINE);
  });

  // ─── Mock helpers (mirrors renderer-ready.test.ts shape) ───────────────────

  function makeMockGL2(): Record<string, unknown> {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      isContextLost: () => false,
    };
  }

  function makeMockCanvas(): HTMLCanvasElement {
    return {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') return makeMockGL2();
        if (kind === 'webgpu') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({
              createView: () => ({}),
              width: 800,
              height: 600,
            }),
          };
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
  }

  interface CallRecord {
    readonly type: string;
    readonly label?: string | undefined;
    readonly code?: string | undefined;
    readonly format?: string | undefined;
    readonly size?: number | undefined;
    readonly entries?: number | undefined;
    readonly fragmentTargets?: readonly string[] | undefined;
    readonly fragmentSource?: string | undefined;
    readonly vertexLocations?: readonly number[] | undefined;
  }

  interface DeviceCallLog {
    readonly records: CallRecord[];
  }

  function makeMockDevice(log: DeviceCallLog): unknown {
    const lost = new Promise<unknown>(() => undefined);
    return {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      // Model a native WebGPU device: this test exercises the preferred
      // swap-chain format selected by the storage-buffer path.  An empty
      // limits object describes a downlevel device and correctly selects the
      // rgba fallback instead.
      limits: {
        maxStorageBuffersPerShaderStage: 8,
      },
      queue: {
        submit: () => undefined,
        writeBuffer: () => undefined,
        writeTexture: () => undefined,
        onSubmittedWorkDone: async () => undefined,
      },
      createShaderModule: (desc: { label?: string; code: string }) => {
        log.records.push({ type: 'createShaderModule', label: desc.label, code: desc.code });
        return { code: desc.code, getCompilationInfo: async () => ({ messages: [] }) };
      },
      createBindGroupLayout: (desc: { label?: string; entries?: unknown[] }) => {
        log.records.push({
          type: 'createBindGroupLayout',
          label: desc?.label,
          entries: Array.isArray(desc?.entries) ? desc.entries.length : 0,
        });
        return {};
      },
      createPipelineLayout: (desc: { label?: string }) => {
        log.records.push({ type: 'createPipelineLayout', label: desc?.label });
        return {};
      },
      createRenderPipeline: (desc: {
        label?: string;
        vertex?: { buffers?: Array<{ attributes: Array<{ shaderLocation: number }> }> };
        fragment?: { module?: { code?: string }; targets?: Array<{ format?: string }> };
      }) => {
        const targets = desc?.fragment?.targets ?? [];
        const formats = targets.map((t) => t?.format ?? '<missing>');
        log.records.push({
          type: 'createRenderPipeline',
          label: desc?.label,
          fragmentTargets: formats,
          fragmentSource: desc.fragment?.module?.code,
          vertexLocations: desc.vertex?.buffers?.flatMap((buffer) =>
            buffer.attributes.map((attribute) => attribute.shaderLocation),
          ),
        });
        return {};
      },
      createBindGroup: () => ({}),
      createBuffer: (desc: { label?: string; size?: number }) => {
        log.records.push({
          type: 'createBuffer',
          label: desc?.label,
          size: desc?.size,
        });
        return {
          getMappedRange: () => new ArrayBuffer(64),
          unmap: () => undefined,
        };
      },
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setVertexBuffer: () => undefined,
          setBindGroup: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
        }),
        finish: () => ({}),
      }),
      createTexture: (desc: { label?: string; format?: string }) => {
        log.records.push({ type: 'createTexture', label: desc?.label, format: desc?.format });
        return {
          createView: () => ({}),
        };
      },
      createTextureView: () => ({}),
      createSampler: (desc: { label?: string }) => {
        log.records.push({ type: 'createSampler', label: desc?.label });
        return {};
      },
      destroy: () => undefined,
    };
  }

  function makeMockGPU(deviceObj: unknown): unknown {
    return {
      requestAdapter: async () => ({
        requestDevice: async () => deviceObj,
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  const pbrSource = '/* mock pbr.wgsl - calls f_schlick( for PBR direct lighting */';
  const unlitSource = '/* mock unlit.wgsl - constant-shading path */';
  const tonemapSource = '/* mock tonemap.wgsl - struct TonemapParams { exposure: f32 }; */';

  function buildManifestDataUrl(uvSetCount = 1): string {
    const materialShaderStub = (identifier: string) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: identifier === 'forgeax::default-standard-pbr' ? pbrSource : unlitSource,
      paramSchema: '[]',
      uvSetCount,
      variants:
        identifier === 'forgeax::default-standard-pbr'
          ? standardMaterialShaderVariants(pbrSource)
          : [],
    });
    const manifest = {
      entries: [
        {
          hash: 'pbr00000',
          wgsl: pbrSource,
          glsl: '',
          bindings: '',
        },
        {
          hash: 'unlit000',
          wgsl: unlitSource,
          glsl: '',
          bindings: '',
        },
        {
          hash: 'tonemap0',
          wgsl: tonemapSource,
          glsl: '',
          bindings: '',
        },
      ],
      materialShaders: [
        materialShaderStub('forgeax::default-standard-pbr'),
        materialShaderStub('forgeax::default-unlit'),
      ],
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  // ─── Tests ─────────────────────────────────────────────────────────────────

  const baseNavigator = { userAgent: 'mock-engine-test' } as unknown as Navigator;

  beforeEach(() => {
    vi.stubGlobal('navigator', { ...baseNavigator });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('feat-20260519-tonemap-reinhard-mvp T-M2.4 / T-M2.5: HDR target + tonemap pipeline shape', () => {
    // feat-20260621 M-A3 (D-5): the prior "row 1" asserting boot-time creation of
    // a dedicated tonemap pipeline / 3-entry BGL / sampler / 16 B params UBO is
    // deleted. The built-in tonemap now registers on the unified post-process
    // channel (`postProcess.register('forgeax::tonemap', { source, params })`);
    // its pipeline + BGL + sampler compile lazily on the first tonemap frame
    // (dispatchFullscreenPass), not at boot. The 3-entry BGL shape +
    // params-UBO byteSize=16 are covered by dispatch-fullscreen-pass-params.unit.
    // test.ts; observable tonemap output is smoke-gated (w12, plan-strategy R-1).
    it.each([
      1, 4, 8,
    ])('row 2: unlit bootstrap preserves attachments and %i reflected UV sets', async (uvSetCount) => {
      const log: DeviceCallLog = { records: [] };
      const device = makeMockDevice(log);
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
      const canvas = makeMockCanvas();
      const { createRenderer } = (await import(ENGINE)) as {
        createRenderer: (canvas: unknown, opts?: unknown, bundler?: unknown) => Promise<unknown>;
      };
      const result = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl(uvSetCount) },
      );
      expect(result.ok).toBe(true);
      result.unwrap();

      // bug-20260612: sRGB siblings stay on the swap-chain srgb view; Channel 2
      // (storageBufferCapable=true) follows getPreferredCanvasFormat() — mocked
      // as 'bgra8unorm' here for Chromium parity, paired with 'bgra8unorm-srgb'.
      const unlitSrgb = log.records.find(
        (r) => r.type === 'createRenderPipeline' && r.label === 'pbr-pipeline-unlit',
      );
      expect(unlitSrgb?.fragmentTargets).toEqual(['bgra8unorm-srgb']);
      expect(
        log.records.filter(
          (r) =>
            r.type === 'createRenderPipeline' &&
            /^pbr-pipeline-standard(?:-hdr)?$/.test(r.label ?? ''),
        ),
      ).toEqual([]);

      // HDR variants ship the rgba16float target.
      const unlitHdr = log.records.find(
        (r) => r.type === 'createRenderPipeline' && r.label === 'pbr-pipeline-unlit-hdr',
      );
      expect(unlitHdr).toBeDefined();
      expect(unlitHdr?.fragmentTargets).toEqual(['rgba16float']);
      expect(unlitHdr?.fragmentSource).toBe(unlitSource);
      for (const pipeline of [unlitSrgb, unlitHdr]) {
        expect(
          pipeline?.vertexLocations?.filter((location) => location === 2 || location >= 6),
        ).toEqual(Array.from({ length: uvSetCount }, (_, i) => (i === 0 ? 2 : i + 5)));
      }
      // Standard attachment admission is exercised after real material publication
      // and draw in native-shader-labels.dawn.test.ts, instead of unused boot PSOs.
    });

    it('row 3: lazy HDR colour + depth attachments start null (AC-03(c) zero-cost on tonemap none path)', async () => {
      const log: DeviceCallLog = { records: [] };
      const device = makeMockDevice(log);
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
      const canvas = makeMockCanvas();
      const { createRenderer } = (await import(ENGINE)) as {
        createRenderer: (...args: unknown[]) => Promise<{ ok: boolean; unwrap(): RendererType }>;
      };
      const result = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      expect(result.ok).toBe(true);
      result.unwrap();

      // No `createTexture(format='rgba16float')` call for the HDR colour
      // attachment before any opt-in frame. The geometry-side fallback
      // white texture is 'rgba8unorm'; the depth attachment is
      // 'depth24plus-stencil8'. An HDR-target rgba16float allocation only fires
      // inside the record stage when the active camera carries
      // tonemap !== 'none'. AC-03(c).
      //
      // feat-20260520-skylight-ibl-cubemap M2 round-2 / t40 + plan-strategy
      // D-5 carve-out: the skylight fallback bundle allocates two 1x1
      // rgba16float texture_cubes (labels `skylight-fallback-irradiance-cube`
      // / `skylight-fallback-prefilter-cube`) inside createRenderer. They
      // are NOT HDR colour attachments -- they seed the @group(4) fallback
      // bind group so PBR pipelines dispatch with ambient=0 when no Skylight
      // ECS entity exists. Filter by label so the AC-03(c) lazy-HDR contract
      // remains testable.
      //
      // tweak-20260608-rhi-hdr-renderable-caps-and-warn-once M1 carve-out:
      // RhiCaps probe creates a 1x1 rgba16float texture (label
      // `forgeax-caps-probe-rgba16float-renderable`) during deriveCaps to
      // test if the format is RENDER_ATTACHMENT-renderable. NOT an HDR
      // colour attachment -- a one-shot probe destroyed immediately. Filter
      // by label so the AC-03(c) lazy-HDR contract remains testable.
      // The neutral normal-map fallback uses float16 to represent 0.5 exactly;
      // it is a 1x1 sampled material input, not a scene HDR attachment.
      const hdrTextureCalls = log.records.filter(
        (r) =>
          r.type === 'createTexture' &&
          r.format === 'rgba16float' &&
          r.label !== 'fallback-normal-1x1' &&
          !(r.label?.startsWith('skylight-fallback-') ?? false) &&
          !(r.label?.startsWith('forgeax-caps-probe-') ?? false),
      );
      expect(hdrTextureCalls.map((record) => record.label)).toEqual([]);
    });

    it('row 4: engine modules prewarm at boot while the tonemap pipeline waits for its first frame', async () => {
      const log: DeviceCallLog = { records: [] };
      const device = makeMockDevice(log);
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
      const canvas = makeMockCanvas();
      const { createRenderer } = (await import(ENGINE)) as {
        createRenderer: (...args: unknown[]) => Promise<{ ok: boolean; unwrap(): RendererType }>;
      };
      const result = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      expect(result.ok).toBe(true);
      result.unwrap();

      const moduleSources = log.records
        .filter((r) => r.type === 'createShaderModule')
        .map((r) => r.code);
      expect(moduleSources).toContain(pbrSource);
      expect(moduleSources).toContain(unlitSource);
      // The unified channel prewarms its module so the first synchronous frame
      // does not wait for compilation; pipeline admission still belongs to draw.
      expect(moduleSources).toContain(tonemapSource);
      expect(
        log.records.filter(
          (record) =>
            record.type === 'createRenderPipeline' && record.fragmentSource === tonemapSource,
        ),
      ).toEqual([]);
    });
  });
}
