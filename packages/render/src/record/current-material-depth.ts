import type {
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphNativePass,
} from '@forgeax/engine-render-graph';
import type {
  RenderPassDescriptor,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import type { _InternalRenderPipelineContext } from './render-context';
import {
  type ViewTargetTexture,
  type ViewTargetTextures,
  viewTargetTextures,
} from './view-target-textures';

interface DepthImage extends ViewTargetTexture {
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;
  readonly sampled: TextureView;
  readonly clear: RenderPassDescriptor;
}

/** Sequential ordinary Scene passes in one view share one writable depth snapshot.
 * Nothing outside a consuming pass observes its contents. The last user of the
 * view returns the allocation through the renderer's actual submission fence. */
export class CurrentMaterialDepth {
  private image: DepthImage | undefined;
  private writer: object | undefined;

  constructor(private readonly textures: ViewTargetTextures) {}

  begin(): void {
    this.writer = undefined;
  }

  finish(): void {
    if (this.writer === undefined) this.release();
  }

  release(): void {
    const image = this.image;
    this.image = undefined;
    this.writer = undefined;
    if (image !== undefined) this.textures.retire(image);
  }

  sampled(writer: object): TextureView | undefined {
    return this.writer === writer ? this.image?.sampled : undefined;
  }

  write(writer: object, width: number, height: number, format: TextureFormat): DepthImage {
    let image = this.image;
    if (
      image === undefined ||
      image.width !== width ||
      image.height !== height ||
      image.format !== format
    ) {
      const device = this.textures.device;
      const allocation = this.textures.allocate(
        'ordinary-material-depth',
        width,
        height,
        format,
        GPU_TEXTURE_USAGE_COPY_DST |
          GPU_TEXTURE_USAGE_TEXTURE_BINDING |
          GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
      );
      const texture = allocation.texture;
      try {
        const sampled = device
          .createTextureView(texture, { aspect: 'depth-only', dimension: '2d' })
          .unwrap();
        const attachment = device.createTextureView(texture, { dimension: '2d' }).unwrap();
        image = {
          width,
          height,
          format,
          ...allocation,
          sampled,
          clear: {
            colorAttachments: [],
            depthStencilAttachment: {
              view: attachment,
              depthClearValue: 0,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
              ...(format.includes('stencil')
                ? ({
                    stencilClearValue: 0,
                    stencilLoadOp: 'clear',
                    stencilStoreOp: 'store',
                  } as const)
                : {}),
            },
          },
        };
      } catch (cause) {
        this.textures.rollback(allocation);
        throw cause;
      }
      this.release();
      this.image = image;
    }
    this.writer = writer;
    return image;
  }
}

function viewDepth(frame: _InternalRenderPipelineContext): CurrentMaterialDepth {
  const state = frame.frameState;
  if (state.ordinaryMaterialDepth !== undefined) return state.ordinaryMaterialDepth;
  state.ordinaryMaterialDepth = new CurrentMaterialDepth(viewTargetTextures(frame));
  return state.ordinaryMaterialDepth;
}

export interface MaterialDepthExtent {
  readonly width: number;
  readonly height: number;
}

/** The built-in Scene pass has exclusive use of the view's snapshot until the
 * next producer. Only the source is graph-owned; the scratch image never aliases it. */
export function addCurrentMaterialDepth(
  graph: Pick<RenderGraphBuilder<RenderPipelineFrame>, 'addSubgraphPass'>,
  depth: RenderPipelineTarget,
  extent: MaterialDepthExtent,
  request: object,
  name: string,
  clear: boolean,
  readsDepth: (frame: RenderPipelineFrame) => boolean,
): Result<void, RenderGraphError> {
  const label = name + (clear ? '.material-depth-clear' : '.material-depth-copy');
  const cares = (frame: RenderPipelineFrame): boolean =>
    (frame as _InternalRenderPipelineContext).currentMaterialDepthDemand === true &&
    readsDepth(frame);
  let source: Texture | undefined;
  let current: DepthImage | undefined;
  const clearPass: RenderGraphNativePass = {
    kind: 'raster',
    name: label,
    get descriptor() {
      if (current === undefined)
        throw new Error('Material depth clear requires its current target');
      return current.clear;
    },
    encode() {},
  };
  const size = { width: extent.width, height: extent.height, depthOrArrayLayers: 1 };
  const copy: RenderGraphNativePass = {
    kind: 'copy',
    name: label,
    encode(encoder) {
      if (source === undefined || current === undefined)
        throw new Error('Material depth copy requires its current source and destination');
      encoder.copyTextureToTexture(
        { texture: source, aspect: 'all' },
        { texture: current.texture, aspect: 'all' },
        size,
      );
    },
  };
  return graph.addSubgraphPass(`${label}.producer`, {
    profilePasses: () => [clear ? clearPass : copy],
    accesses: clear ? [] : [{ resource: depth.view, usage: 'copy-src' }],
    executeIf: cares,
    appendPassNames(frame, names) {
      if (cares(frame)) names.push(label);
    },
    commandsDirect(frame, resources, issue, recording) {
      const owner = viewDepth(frame as _InternalRenderPipelineContext);
      const image = owner.write(request, extent.width, extent.height, depth.format);
      source = clear ? undefined : resources.texture(depth.texture).unwrap();
      current = image;
      try {
        issue(recording, clear ? clearPass : copy);
      } finally {
        current = source = undefined;
      }
    },
  });
}
