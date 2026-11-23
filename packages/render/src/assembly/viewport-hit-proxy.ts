import type { MeshVertexStreamRange } from '@forgeax/engine-geometry';
import type {
  BindGroup,
  Buffer,
  RenderPipeline,
  RhiDevice,
  ShaderModule,
  Texture,
} from '@forgeax/engine-rhi';
import { textureReadbackLayout } from '@forgeax/engine-rhi';
import { type MaterialRenderState, stripWgslComments } from '@forgeax/engine-types';
import { bindMeshVertexStreams } from '../device/mesh-vertex-streams';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
} from '../gpu-texture-usage';
import { materialDepthStencil } from '../material-render-state';
import { materialRasterSource } from '../pipeline-builder';
import type { CameraSnapshot } from '../render-contract';

type PickFailure = 'geometry-coverage' | 'material-coverage';
type PickDetail = Extract<
  import('../viewport-hit').ViewportHitResult,
  { kind: 'unavailable' }
>['detail'];

export interface ViewportHitDraw {
  readonly entity: number | null;
  readonly pipeline: RenderPipeline;
  readonly state: MaterialRenderState | undefined;
  readonly bindings: readonly { readonly group: BindGroup; readonly offsets?: readonly number[] }[];
  readonly vertex: Buffer;
  readonly vertexStreams?: readonly MeshVertexStreamRange[] | undefined;
  readonly indices: { readonly buffer: Buffer; readonly format: 'uint16' | 'uint32' } | null;
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
  readonly instanceCount: number;
  readonly firstInstance: number;
}

type HitPipeline = Pick<ViewportHitDraw, 'pipeline' | 'state'>;

export function createViewportHitCapture(camera: CameraSnapshot, warmup = false) {
  const draws: ViewportHitDraw[] = [];
  const recipes: HitPipeline[] = [];
  const seen = warmup ? new Map<RenderPipeline, Set<string>>() : undefined;
  let failure: PickFailure | undefined;
  let detail: PickDetail;
  return {
    camera,
    draws,
    warmup,
    recipes,
    get failure() {
      return failure;
    },
    get detail() {
      return detail;
    },
    reject(reason: PickFailure, evidence?: PickDetail) {
      if (failure === undefined) {
        failure = reason;
        detail = evidence;
      }
    },
    recordPipeline({ pipeline, state }: HitPipeline) {
      if (seen === undefined || failure !== undefined || recipes.length === MAX_WARMUP_PIPELINES)
        return;
      const key = JSON.stringify(hitDepth(state));
      let variants = seen.get(pipeline);
      if (variants === undefined) {
        variants = new Set();
        seen.set(pipeline, variants);
      }
      if (variants.has(key)) return;
      variants.add(key);
      recipes.push({ pipeline, state });
    },
    record(draw: ViewportHitDraw) {
      if (failure !== undefined) return;
      if (draws.length === MAX_DRAWS) failure = 'geometry-coverage';
      else draws.push(draw);
    },
  };
}

export type ViewportHitCapture = ReturnType<typeof createViewportHitCapture>;

export interface ViewportHitPixel {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// The blend constant supplies the draw's ID without changing the vertex ABI.
const SHADER = /* wgsl */ `
@fragment fn fs() -> @location(0) vec4f {
  return vec4f(1.0);
}
`;
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_DRAWS = 16384;
const MAX_WARMUP_PIPELINES = 32;
const WARMUP_CONCURRENCY = 2;
const row = textureReadbackLayout(1, 1, { blockWidth: 1, blockHeight: 1, bytesPerBlock: 4 });

/** Keep evaluation of the actual fragment, including discards, and replace its color only. */
export function viewportHitFragmentSource(source: string, entry: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/u.test(entry)) return undefined;
  const code = stripWgslComments(source);
  const declaration = new RegExp(`\\bfn\\s+${entry}\\s*\\(`, 'u').exec(code);
  if (declaration === null) return undefined;
  const close = code.indexOf('->', declaration.index + declaration[0].length);
  const bodyStart = code.indexOf('{', declaration.index + declaration[0].length);
  if (bodyStart < 0 || close < 0 || close > bodyStart) return undefined;
  let nesting = 1;
  let end = bodyStart + 1;
  while (end < code.length && nesting > 0) {
    if (code[end] === '{') nesting++;
    if (code[end] === '}') nesting--;
    end++;
  }
  if (nesting !== 0) return undefined;
  const body = code.slice(bodyStart + 1, end - 1);
  const returns = /\breturn\s+([^;]+);/gu;
  if (!returns.test(body)) return undefined;
  return `${code.slice(0, close)}-> @location(0) vec4f {
${body.replace(returns, (_statement, expression) => `{ _ = ${expression}; return vec4f(1.0); }`)}
}${code.slice(end)}`;
}

type Preparation<T> =
  | { readonly kind: 'pending'; readonly completion: Promise<void> }
  | { readonly kind: 'failed'; readonly reason: 'material-coverage' | 'hit-pass' }
  | { readonly kind: 'ready'; readonly value: T };
const PENDING = { kind: 'pending' } as const;
const COVERAGE_FAILED = { kind: 'failed', reason: 'material-coverage' } as const;
const PIPELINE_FAILED = { kind: 'failed', reason: 'hit-pass' } as const;

// Fresh depth uses the authored comparison, before display depth priming.
const hitDepth = (state: MaterialRenderState | undefined) =>
  materialDepthStencil('depth32float', state);

/** Device-local Hit Proxy pipeline cache shared by observation and optional warmup. */
export function createViewportHitProxy(
  device: RhiDevice,
  createShader: (code: string) => Promise<ShaderModule>,
) {
  let shader: Promise<ShaderModule> | undefined;
  const coverageModules = new WeakMap<ShaderModule, Map<string, Preparation<ShaderModule>>>();
  const pipelines = new WeakMap<RenderPipeline, Map<string, Preparation<RenderPipeline>>>();
  const prepare = () =>
    (shader ??= createShader(SHADER).catch((error) => {
      shader = undefined;
      throw error;
    }));

  function coverage(
    source: NonNullable<ReturnType<typeof materialRasterSource>>,
  ): Preparation<ShaderModule> {
    const fragment = source.descriptor.fragment;
    const entry = fragment?.entryPoint;
    if (fragment === undefined || entry === undefined) return COVERAGE_FAILED;
    let entries = coverageModules.get(fragment.module);
    if (entries === undefined) {
      entries = new Map();
      coverageModules.set(fragment.module, entries);
    }
    const existing = entries.get(entry);
    if (existing !== undefined) return existing;
    const fragmentSource = viewportHitFragmentSource(
      typeof source.fragmentSource === 'string'
        ? source.fragmentSource
        : source.fragmentSource.source,
      entry,
    );
    if (fragmentSource === undefined) {
      entries.set(entry, COVERAGE_FAILED);
      return COVERAGE_FAILED;
    }
    const owner = entries;
    const completion = createShader(fragmentSource).then(
      (value) => {
        owner.set(entry, { kind: 'ready', value });
      },
      () => {
        owner.set(entry, COVERAGE_FAILED);
      },
    );
    const pending = { kind: 'pending', completion } as const;
    entries.set(entry, pending);
    return pending;
  }

  function pipeline(module: ShaderModule, draw: HitPipeline): Preparation<RenderPipeline> {
    const source = materialRasterSource(draw.pipeline);
    if (source === undefined || source.descriptor.layout === 'auto') return PIPELINE_FAILED;
    const depth = hitDepth(draw.state);
    const key = JSON.stringify(depth);
    let variants = pipelines.get(draw.pipeline);
    if (variants === undefined) {
      variants = new Map();
      pipelines.set(draw.pipeline, variants);
    }
    const cached = variants.get(key);
    if (cached !== undefined) return cached;
    const actualFragment = source.descriptor.fragment;
    const useCoverage = source.fragmentEffects?.mayDiscard === true;
    const specialized = useCoverage ? coverage(source) : undefined;
    if (specialized !== undefined && specialized.kind !== 'ready') return specialized;
    const descriptor = {
      label: 'viewport-hit-proxy',
      layout: source.descriptor.layout,
      vertex: source.descriptor.vertex,
      primitive: source.descriptor.primitive,
      fragment: {
        module: specialized?.value ?? module,
        ...(useCoverage
          ? { entryPoint: actualFragment?.entryPoint, constants: actualFragment?.constants }
          : { entryPoint: 'fs' }),
        targets: [
          {
            format: 'rgba8unorm',
            blend: {
              color: { operation: 'add', srcFactor: 'constant', dstFactor: 'zero' },
              alpha: { operation: 'add', srcFactor: 'constant', dstFactor: 'zero' },
            },
          },
        ],
      },
      depthStencil: depth,
    } satisfies import('@forgeax/engine-rhi').RenderPipelineDescriptor;
    const owner = variants;
    const completion = Promise.resolve()
      .then(async () => {
        const result =
          device.createRenderPipelineAsync === undefined
            ? device.createRenderPipeline(descriptor)
            : await device.createRenderPipelineAsync(descriptor);
        const value = result.unwrap();
        owner.set(key, { kind: 'ready', value });
      })
      .catch(() => {
        owner.set(key, PIPELINE_FAILED);
      });
    const pending = { kind: 'pending', completion } as const;
    variants.set(key, pending);
    return pending;
  }

  function prepareDraws(module: ShaderModule, draws: readonly ViewportHitDraw[]) {
    const ready: RenderPipeline[] = [];
    let pending = false;
    for (const draw of draws) {
      const result = pipeline(module, draw);
      if (result.kind === 'failed') return result;
      if (result.kind === 'pending') pending = true;
      else ready.push(result.value);
    }
    return pending ? PENDING : { kind: 'ready' as const, value: ready };
  }

  async function warm(recipes: readonly HitPipeline[], signal: AbortSignal): Promise<void> {
    if (signal.aborted || device.createRenderPipelineAsync === undefined || recipes.length === 0)
      return;
    const module = await prepare();
    let next = 0;
    const compile = async () => {
      while (!signal.aborted && next < recipes.length) {
        const recipe = recipes[next++];
        if (recipe === undefined) break;
        let result = pipeline(module, recipe);
        while (!signal.aborted && result.kind === 'pending') {
          await result.completion;
          if (!signal.aborted) result = pipeline(module, recipe);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(WARMUP_CONCURRENCY, recipes.length) }, compile),
    );
  }

  /** Encode and submit synchronously. The returned promise owns only completion and readback. */
  function submit(
    pixel: ViewportHitPixel,
    draws: readonly ViewportHitDraw[],
    drawPipelines: readonly RenderPipeline[],
    trackMeshes: (completion: Promise<unknown>) => void,
  ): Promise<number | null> {
    const { x, y, width, height } = pixel;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= width ||
      y >= height ||
      width * height * 8 > MAX_ATTACHMENT_BYTES ||
      draws.length > MAX_DRAWS
    )
      throw new Error('Hit Proxy pixel or allocation exceeds its supported range');
    if (draws.length === 0) return Promise.resolve(null);
    const size = { width, height, depthOrArrayLayers: 1 };
    let color: Texture | undefined;
    let depth: Texture | undefined;
    let readback: Buffer | undefined;
    const destroy = () => {
      if (readback) device.destroyBuffer(readback);
      if (depth) device.destroyTexture(depth);
      if (color) device.destroyTexture(color);
    };
    try {
      color = device
        .createTexture({
          label: 'viewport-hit-id',
          size,
          format: 'rgba8unorm',
          usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
        })
        .unwrap();
      depth = device
        .createTexture({
          label: 'viewport-hit-depth',
          size,
          format: 'depth32float',
          usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        .unwrap();
      const buffer = device
        .createBuffer({ label: 'viewport-hit-readback', size: row.byteLength, usage: 0x01 | 0x08 })
        .unwrap();
      readback = buffer;
      const encoder = device.createCommandEncoder({ label: 'viewport-hit-encoder' }).unwrap();
      const pass = encoder.beginRenderPass({
        label: 'viewport-hit-pass',
        colorAttachments: [
          {
            view: device.createTextureView(color, {}).unwrap(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
        depthStencilAttachment: {
          view: device.createTextureView(depth, {}).unwrap(),
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
          depthClearValue: 0,
        },
      });
      pass.setScissorRect(x, y, 1, 1);
      draws.forEach((draw, index) => {
        const pso = drawPipelines[index];
        if (pso === undefined) throw new Error('Missing Hit Proxy pipeline');
        pass.setPipeline(pso);
        const id = draw.entity === null ? 0 : index + 1;
        pass.setBlendConstant({
          r: (id & 255) / 255,
          g: ((id >>> 8) & 255) / 255,
          b: ((id >>> 16) & 255) / 255,
          a: (id >>> 24) / 255,
        });
        draw.bindings.forEach(({ group, offsets }, slot) => {
          pass.setBindGroup(slot, group, offsets);
        });
        bindMeshVertexStreams(pass, draw.vertex, draw.vertexStreams);
        if (draw.indices === null)
          pass.draw(draw.count, draw.instanceCount, draw.first, draw.firstInstance);
        else {
          pass.setIndexBuffer(draw.indices.buffer, draw.indices.format);
          pass.drawIndexed(
            draw.count,
            draw.instanceCount,
            draw.first,
            draw.baseVertex,
            draw.firstInstance,
          );
        }
      });
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: color, origin: { x, y, z: 0 } },
        { buffer, bytesPerRow: row.bytesPerRow },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const completion = device.queue.onSubmittedWorkDone();
      trackMeshes(completion);
      return buffer
        .mapAsync(1)
        .then((result) => {
          const mapped = result.unwrap();
          try {
            const index = new DataView(mapped.getMappedRange(0, 4).unwrap()).getUint32(0, true);
            if (index === 0) return null;
            const hit = draws[index - 1];
            if (hit === undefined) throw new Error('Hit Proxy read an unknown draw ID');
            return hit.entity;
          } finally {
            mapped.unmap();
          }
        })
        .finally(async () => {
          try {
            await completion;
          } finally {
            destroy();
          }
        });
    } catch (cause) {
      destroy();
      throw cause;
    }
  }

  return { prepare, prepareDraws, submit, warm };
}
