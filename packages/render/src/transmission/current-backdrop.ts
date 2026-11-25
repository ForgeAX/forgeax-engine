import { encodeMipmapLevel } from '@forgeax/engine-assets-runtime';
import type { GraphResourceResolver, RenderGraphNativePass } from '@forgeax/engine-render-graph';
import type {
  RhiRenderPassEncoder,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { mipDimension, numMipLevels } from '@forgeax/engine-types';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { isCanonicalStandardPbrMaterialShader } from '../pbr-pipeline';
import type { NativeMaterialView } from '../record/graph-binding-views';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { type ScenePassRequest, scenePassMaterialRows } from '../record/scene-pass-work';
import {
  type ViewTargetTexture,
  type ViewTargetTextures,
  viewTargetTextures,
} from '../record/view-target-textures';
import type { RenderPipelineTarget } from '../render-pipeline';
import type { PhysicalSceneRaster } from '../typed-render-graph-primitives';
import { transmissionMergeEncoder } from './merge';

interface BackdropImage {
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;
  readonly levels: number;
  readonly color: ViewTargetTexture;
  readonly scratch: ViewTargetTexture | undefined;
  readonly base: NativeMaterialView;
  readonly chain: NativeMaterialView;
  readonly sources: TextureView[];
  readonly destinations: TextureView[];
}

/** A view needs one backdrop even when backs and fronts each take a snapshot:
 * those copies and consuming draws are ordered commands on the same encoder. */
export class CurrentTransmissionTargets {
  private image: BackdropImage | undefined;
  private usedLevels = 0;
  private copiedScene = false;

  constructor(private readonly textures: ViewTargetTextures) {}

  begin(): void {
    this.usedLevels = 0;
    this.copiedScene = false;
  }
  finish(): void {
    if (this.usedLevels === 0) this.release();
  }
  get current(): BackdropImage | undefined {
    return this.usedLevels > 0 ? this.image : undefined;
  }

  get copied(): boolean | undefined {
    return this.usedLevels > 0 ? this.copiedScene : undefined;
  }

  noteCopy(): void {
    this.copiedScene = true;
  }

  get mipCount(): number {
    return this.usedLevels;
  }

  acquire(width: number, height: number, format: TextureFormat, rough: boolean): BackdropImage {
    const levels = rough ? numMipLevels({ width, height }) : 1;
    let image = this.image;
    if (
      image === undefined ||
      image.width !== width ||
      image.height !== height ||
      image.format !== format ||
      image.levels < levels
    ) {
      const next = this.create(width, height, format, levels);
      this.release();
      this.image = next;
      image = next;
    }
    this.usedLevels = levels;
    return image;
  }

  private create(
    width: number,
    height: number,
    format: TextureFormat,
    levels: number,
  ): BackdropImage {
    const device = this.textures.device;
    const color = this.textures.allocate(
      'transmission-backdrop',
      width,
      height,
      format,
      GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING |
        (format === 'rgba16float' ? GPU_TEXTURE_USAGE_RENDER_ATTACHMENT : 0),
      levels,
    );
    let scratch: ViewTargetTexture | undefined;
    try {
      const view = device.createTextureView(color.texture, { dimension: '2d' }).unwrap();
      const sources: TextureView[] = [];
      const destinations: TextureView[] = [];
      if (levels > 1) {
        scratch = this.textures.allocate(
          'transmission-backdrop-scratch',
          mipDimension(width, 1),
          mipDimension(height, 1),
          format,
          GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
          levels - 1,
        );
        for (let i = 0; i < levels - 1; i++) {
          const slice = { dimension: '2d' as const, baseMipLevel: i, mipLevelCount: 1 };
          sources.push(device.createTextureView(color.texture, slice).unwrap());
          destinations.push(device.createTextureView(scratch.texture, slice).unwrap());
        }
      }
      const binding = (view: TextureView): NativeMaterialView => ({
        view,
        currentTextureView: () => (this.image?.color === color ? view : undefined),
      });
      const chain = binding(view);
      return {
        width,
        height,
        format,
        levels,
        color,
        scratch,
        sources,
        destinations,
        base: sources[0] === undefined ? chain : binding(sources[0]),
        chain,
      };
    } catch (cause) {
      if (scratch !== undefined) this.textures.rollback(scratch);
      this.textures.rollback(color);
      throw cause;
    }
  }

  release(): void {
    const image = this.image;
    this.image = undefined;
    this.usedLevels = 0;
    if (image === undefined) return;
    this.textures.retire(image.color);
    if (image.scratch !== undefined) this.textures.retire(image.scratch);
  }
}

function targets(frame: _InternalRenderPipelineContext): CurrentTransmissionTargets {
  const state = frame.frameState;
  state.currentTransmissionTargets ??= new CurrentTransmissionTargets(viewTargetTextures(frame));
  return state.currentTransmissionTargets;
}

function canReplaceTransmission(
  frame: _InternalRenderPipelineContext,
  request: ScenePassRequest,
): boolean {
  if (frame.currentTransmissionDemand?.needsRoughMips === true) return false;
  const stock = scenePassMaterialRows(frame, request).dispatch;
  let found = false;
  for (const pass of stock) {
    if (
      pass.tags.LightMode !==
      (request.currentTransparencyPass === 'backs' ? 'TransmissionBack' : 'Forward')
    )
      continue;
    found = true;
    if (
      !isCanonicalStandardPbrMaterialShader(pass.materialShaderId) ||
      pass.renderState?.blend !== undefined ||
      pass.renderState?.outputs !== undefined ||
      (pass.renderState?.colorWriteMask ?? 15) !== 15
    )
      return false;
  }
  return found;
}

/** The graph grants scene color and depth together. The private backdrop is
 * produced, downsampled and consumed within this single command domain. */
export function currentTransmissionRaster(
  scene: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  backs: boolean,
  declaration?: string,
): PhysicalSceneRaster {
  const prefix = backs ? 'transmission-backdrop-backs' : 'transmission-backdrop';
  const name = backs ? 'transmission-backs' : 'transmission-forward';
  const canMerge = scene.format === 'rgba16float';
  const mergeProgram = transmissionMergeEncoder();
  return {
    colorFormats: [scene.format as GPUTextureFormat],
    add(graph, accesses, enabled, encodeScene, request) {
      accesses.push({ resource: scene.view, usage: 'copy-src' });
      if (canMerge) accesses.push({ resource: scene.view, usage: 'sampled-read' });
      let frame: _InternalRenderPipelineContext | undefined;
      let resolver: GraphResourceResolver | undefined;
      let image: BackdropImage | undefined;
      let mipCount = 0;
      let source: Texture | undefined;
      let colorView: TextureView | undefined;
      let directBackdrop: NativeMaterialView | undefined;
      let depthView: TextureView | undefined;
      const required = <T>(value: T | undefined): T => {
        if (value === undefined)
          throw new Error('Transmission commands require their current view');
        return value;
      };
      const copy: RenderGraphNativePass = {
        kind: 'copy',
        name: `${prefix}-copy`,
        encode(encoder) {
          const target = required(image);
          encoder.copyTextureToTexture(
            { texture: required(source) },
            { texture: target.color.texture },
            { width: target.width, height: target.height, depthOrArrayLayers: 1 },
          );
        },
      };
      const mips: RenderGraphNativePass[] = [];
      const copies: RenderGraphNativePass[] = [];
      function declareMip(index: number): void {
        const mipName = index === 1 ? `${prefix}-mip` : `${prefix}-mip-${index}`;
        mips[index] = {
          kind: 'raster',
          name: mipName,
          profileName: `${prefix}-mip`,
          descriptor: {
            label: mipName,
            colorAttachments: [
              {
                get view() {
                  return required(image?.destinations[index - 1]);
                },
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
              },
            ],
          },
          encode(pass: RhiRenderPassEncoder) {
            const target = required(image);
            encodeMipmapLevel(
              required(frame).runtime.device,
              pass,
              required(target.sources[index - 1]),
              target.format,
            ).unwrap();
          },
        };
        copies[index] = {
          kind: 'copy',
          name: `${prefix}-mip-copy-${index}`,
          profileName: `${prefix}-mip-copy`,
          encode(encoder) {
            const target = required(image);
            encoder.copyTextureToTexture(
              { texture: required(target.scratch).texture, mipLevel: index - 1 },
              { texture: target.color.texture, mipLevel: index },
              {
                width: mipDimension(target.width, index),
                height: mipDimension(target.height, index),
                depthOrArrayLayers: 1,
              },
            );
          },
        };
      }
      const draw: RenderGraphNativePass = {
        kind: 'raster',
        name,
        descriptor: {
          label: name,
          colorAttachments: [
            {
              get view() {
                return required(colorView);
              },
              loadOp: 'load',
              storeOp: 'store',
            },
          ],
          depthStencilAttachment: {
            get view() {
              return required(depthView);
            },
            depthLoadOp: 'load',
            depthStoreOp: 'store',
            ...(depth.format.includes('stencil')
              ? ({ stencilLoadOp: 'load', stencilStoreOp: 'store' } as const)
              : {}),
          },
        },
        encode(pass) {
          const target = required(image);
          encodeScene(
            pass,
            required(frame),
            required(resolver),
            mipCount === 1 ? target.base : target.chain,
          );
        },
      };
      const replacement: RenderGraphNativePass = {
        ...draw,
        name,
        descriptor: {
          ...draw.descriptor,
          colorAttachments: [
            {
              get view() {
                return required(image?.base.view);
              },
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: -1 },
            },
          ],
        },
        encode(pass: RhiRenderPassEncoder) {
          const view = required(colorView);
          if (directBackdrop?.view !== view) {
            directBackdrop = {
              view,
              currentTextureView: () => (directBackdrop?.view === view ? view : undefined),
            };
          }
          encodeScene(pass, required(frame), required(resolver), directBackdrop);
        },
      };
      const merge: RenderGraphNativePass = {
        kind: 'raster',
        name: `${name}-merge`,
        descriptor: {
          colorAttachments: [
            {
              get view() {
                return required(colorView);
              },
              loadOp: 'load',
              storeOp: 'store',
            },
          ],
        },
        encode(pass) {
          mergeProgram.encode(pass, required(frame), required(image?.base.view));
        },
      };
      return graph.addSubgraphPass(declaration ?? name, {
        accesses,
        profilePasses: () => [
          copy,
          { kind: 'raster', name: `${prefix}-mip` },
          { kind: 'copy', name: `${prefix}-mip-copy` },
          draw,
          ...(canMerge ? [merge] : []),
        ],
        executeIf: enabled,
        commandsDirect(activeFrame, resolved, issue, recording) {
          frame = activeFrame as _InternalRenderPipelineContext;
          resolver = resolved;
          try {
            const size = resolver.textureViewExtent(scene.view).unwrap();
            const owner = targets(frame);
            image = owner.acquire(
              size.width,
              size.height,
              scene.format,
              frame.currentTransmissionDemand?.needsRoughMips === true,
            );
            mipCount = owner.mipCount;
            source = resolver.texture(scene.texture).unwrap();
            colorView = resolver.textureView(scene.view).unwrap();
            depthView = resolver.textureView(depth.view).unwrap();
            if (canMerge && canReplaceTransmission(frame, request) && mergeProgram.prepare(frame)) {
              issue(recording, replacement);
              issue(recording, merge);
              return;
            }
            owner.noteCopy();
            issue(recording, copy);
            for (let level = 1; level < mipCount; level++) {
              if (mips[level] === undefined) declareMip(level);
              issue(recording, required(mips[level]));
              issue(recording, required(copies[level]));
            }
            issue(recording, draw);
          } finally {
            frame = resolver = image = source = colorView = depthView = undefined;
          }
        },
      });
    },
  };
}
