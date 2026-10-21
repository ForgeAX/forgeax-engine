// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { Renderer as RendererType } from '@forgeax/engine-render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer } from '../createRenderer';
import { standardMaterialShaderVariants } from './helpers/standard-material-manifest';

afterEach(() => vi.restoreAllMocks());
{
  // --- from render-system-record-submesh.test.ts ---

  interface PassSpies {
    setIndexBuffer: ReturnType<typeof vi.fn>;
    setVertexBuffer: ReturnType<typeof vi.fn>;
    draw: ReturnType<typeof vi.fn>;
    drawIndexed: ReturnType<typeof vi.fn>;
  }

  function makeMockGL2(): unknown {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      isContextLost: () => false,
    };
  }

  function makeMockCanvas(): HTMLCanvasElement {
    const canvas = {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') return makeMockGL2();
        if (kind === 'webgpu') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({ createView: () => ({}) }),
          };
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
  }

  function makeMockGPUDevice(spies: PassSpies): { device: unknown } {
    const lost = new Promise<unknown>(() => undefined);
    const device = {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      limits: {},
      queue: {
        submit: () => undefined,
        onSubmittedWorkDone: () => Promise.resolve(undefined),
        writeBuffer: () => undefined,
        writeTexture: () => undefined,
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: () => ({}),
      createBuffer: () => ({
        getMappedRange: () => new ArrayBuffer(64),
        unmap: () => undefined,
      }),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setVertexBuffer: spies.setVertexBuffer,
          setIndexBuffer: spies.setIndexBuffer,
          setBindGroup: () => undefined,
          setStencilReference: () => undefined,
          setViewport: () => undefined,
          setScissorRect: () => undefined,
          draw: spies.draw,
          drawIndexed: spies.drawIndexed,
          end: () => undefined,
        }),
        finish: () => ({}),
      }),
      createTexture: () => ({ createView: () => ({}) }),
      createSampler: () => ({}),
      destroy: () => undefined,
    };
    return { device };
  }

  function makeMockGPU(deviceObj: unknown): unknown {
    return {
      requestAdapter: async () => ({ requestDevice: async () => deviceObj }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  const baseNavigator: Navigator = {
    userAgent: 'mock-engine-test',
  } as Partial<Navigator> as Navigator;

  function buildManifestDataUrl(): string {
    const materialShaderStub = (identifier: string) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: '/* stub */',
      paramSchema: '[]',
      variants:
        identifier === 'forgeax::default-standard-pbr' ? standardMaterialShaderVariants() : [],
    });
    const manifest = {
      entries: [
        { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
        {
          hash: 'tonemap0',
          wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
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

  function makePassSpies(): PassSpies {
    return {
      setIndexBuffer: vi.fn(),
      setVertexBuffer: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
    };
  }

  type RendererLike = RendererType;

  async function setupRenderer(spies: PassSpies): Promise<{ renderer: RendererLike }> {
    const { device } = makeMockGPUDevice(spies);
    vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
    const renderer = (
      await createRenderer(
        makeMockCanvas(),
        {},
        {
          shaderManifestUrl: buildManifestDataUrl(),
        },
      )
    ).unwrap();
    return { renderer };
  }

  // feat-20260612-skin-palette-per-frame-upload M1 / m1-1: the old
  // closure-held pipeline assertion is retired with the internal state
  // boundary. The public inspection snapshot is the supported evidence for
  // renderer construction and capability health.
  describe('renderer public inspection contract', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('reports an alive, available renderer through inspect()', async () => {
      const spies = makePassSpies();
      const { renderer } = await setupRenderer(spies);
      const inspection = renderer.inspect();
      expect(inspection.state).toBe('alive');
      expect(inspection.surface).toBe('available');
      expect(inspection.frame.deviceGeneration).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(inspection.features)).toBe(true);
      expect(inspection.capabilities).toBeDefined();
      await renderer.dispose();
    });
  });
}
