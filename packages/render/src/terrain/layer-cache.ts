import type {
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  RhiCommandEncoder,
  RhiDevice,
  Sampler,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import type { ImagePages, ImageVersion } from '../device/image-pages';
import { type ResidencyLease, ResidencyLifetime } from '../device/residency-lifetime';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { TERRAIN_LAYER_BAKE_SHADER } from './layer-bake';

export interface TerrainLayerInput {
  readonly id: number;
  readonly values: Float32Array;
  readonly images: readonly ImageVersion[];
}
export interface TerrainLayerSelection {
  readonly index: number;
  readonly input: TerrainLayerInput;
  readonly height?: ImageVersion;
  readonly heightRange?: readonly [number, number];
}
export interface TerrainLayerArrays {
  readonly selection: readonly TerrainLayerSelection[];
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly textures: readonly Texture[];
  readonly bindings: readonly { readonly textureView: TextureView; readonly sampler: Sampler }[];
  readonly life: ResidencyLifetime;
  release(completed?: Promise<unknown>): void;
}
interface Work {
  readonly output: TerrainLayerArrays;
  readonly before?: TerrainLayerArrays;
  readonly source: ReturnType<ImagePages['texture']['capture']>;
  readonly uniforms: readonly Float32Array[];
  readonly leases: readonly ResidencyLease[];
}
const NAMES = ['color', 'normal-height', 'orm', 'emission'] as const;

/** Actual selected frames own four derived arrays. Edits copy a retained frame
 * on GPU and bake only changed layers; there is no consumer list or CPU atlas. */
export class TerrainLayerCache {
  private readonly sampler: Sampler;
  private pipeline: ComputePipeline | undefined;
  private layout: BindGroupLayout | undefined;
  private readonly work: Work[] = [];
  constructor(
    private readonly device: RhiDevice,
    private readonly source: ImagePages,
    private readonly shader: PipelineBuilderShaderModuleFactory,
  ) {
    this.sampler = device
      .createSampler({
        minFilter: 'linear',
        magFilter: 'linear',
        mipmapFilter: 'nearest',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
      })
      .unwrap();
  }
  get pending(): boolean {
    return this.work.length > 0;
  }
  prepare(
    selection: readonly TerrainLayerSelection[],
    previous?: TerrainLayerArrays,
  ): TerrainLayerArrays {
    this.initialize();
    let width = 1,
      height = 1,
      depth = 1;
    for (const layer of selection) {
      depth = Math.max(depth, layer.index + 2);
      for (const image of [
        ...layer.input.images,
        ...(layer.height === undefined ? [] : [layer.height]),
      ]) {
        width = Math.max(width, image.width);
        height = Math.max(height, image.height);
      }
    }
    const before =
      previous?.width === width && previous.height === height && previous.depth === depth
        ? previous
        : undefined;
    const textures: Texture[] = [];
    const bindings: { textureView: TextureView; sampler: Sampler }[] = [];
    const sources = new Map<ImageVersion, ReturnType<ImagePages['retain']>>();
    let capture: ReturnType<ImagePages['texture']['capture']> | undefined;
    let life: ResidencyLifetime | undefined;
    let frameLease: ResidencyLease | undefined;
    const workLeases: ResidencyLease[] = [];
    try {
      for (const name of NAMES) {
        const texture = this.device
          .createTexture({
            label: `terrain-layer-${name}`,
            size: { width, height, depthOrArrayLayers: depth },
            format: 'rgba16float',
            usage: 1 | 2 | 4 | 8,
            textureBindingViewDimension: '2d-array',
          })
          .unwrap();
        textures.push(texture);
        bindings.push({
          textureView: this.device.createTextureView(texture, { dimension: '2d-array' }).unwrap(),
          sampler: this.sampler,
        });
      }
      const retain = (image: ImageVersion) => {
        let row = sources.get(image);
        if (row === undefined) {
          row = this.source.retain(image);
          sources.set(image, row);
        }
        return row.values;
      };
      const uniforms: Float32Array[] = [];
      for (const [i, layer] of selection.entries()) {
        const images = layer.input.images.map(retain);
        const heightImage = layer.height === undefined ? undefined : retain(layer.height);
        const old = before?.selection[i];
        if (
          old?.index === layer.index &&
          old.input === layer.input &&
          old.height === layer.height &&
          old.heightRange === layer.heightRange
        )
          continue;
        const bytes = new Float32Array(52);
        bytes.set(layer.input.values);
        for (const [channel, image] of images.entries()) bytes.set(image, 20 + channel * 4);
        if (heightImage !== undefined) bytes.set(heightImage, 40);
        bytes.set(
          [
            layer.heightRange?.[0] ?? 0,
            layer.heightRange?.[1] ?? 1,
            heightImage === undefined ? 0 : 1,
            0,
          ],
          44,
        );
        new Uint32Array(bytes.buffer).set([layer.index + 1, width, height, 0], 48);
        uniforms.push(bytes);
      }
      capture = this.source.texture.capture();
      life = new ResidencyLifetime(() => {
        for (const texture of textures) this.device.destroyTexture(texture);
        for (const source of sources.values()) source.release();
      });
      frameLease = life.retain(() => {});
      workLeases.push(life.retain(() => {}));
      if (before !== undefined) workLeases.push(before.life.retain(() => {}));
      const lease = frameLease;
      const result: TerrainLayerArrays = {
        selection,
        width,
        height,
        depth,
        textures,
        bindings,
        life,
        release: (completed) => {
          if (completed !== undefined) lease.track(completed);
          void lease.release(false);
        },
      };
      life.retire();
      this.work.push({
        output: result,
        ...(before === undefined ? {} : { before }),
        source: capture,
        uniforms,
        leases: workLeases,
      });
      return result;
    } catch (cause) {
      capture?.release();
      for (const lease of workLeases) void lease.release(false);
      void frameLease?.release(false);
      if (life === undefined) {
        for (const texture of textures) this.device.destroyTexture(texture);
        for (const source of sources.values()) source.release();
      } else life.retire();
      throw cause;
    }
  }
  encode(encoder: RhiCommandEncoder): { complete(submitted: boolean): void } {
    const work = this.work.slice();
    const buffers: Buffer[] = [];
    const { layout, pipeline } = this;
    try {
      for (const item of work) {
        if (layout === undefined || pipeline === undefined)
          throw new Error('missing prepared Terrain bake pipeline');
        if (item.before !== undefined)
          for (let channel = 0; channel < 4; channel++)
            encoder.copyTextureToTexture(
              { texture: item.before.textures[channel] as Texture },
              { texture: item.output.textures[channel] as Texture },
              {
                width: item.output.width,
                height: item.output.height,
                depthOrArrayLayers: item.output.depth,
              },
            );
        for (const bytes of item.uniforms) {
          const uniform = this.device.createBuffer({ size: bytes.byteLength, usage: 72 }).unwrap();
          buffers.push(uniform);
          this.device.queue.writeBuffer(uniform, 0, bytes).unwrap();
          const group = this.device
            .createBindGroup({
              layout,
              entries: [
                { binding: 0, resource: { kind: 'buffer', value: { buffer: uniform } } },
                { binding: 1, resource: { kind: 'textureView', value: item.source.textureView } },
                { binding: 2, resource: { kind: 'sampler', value: item.source.sampler } },
                ...item.output.bindings.map((binding, index) => ({
                  binding: index + 3,
                  resource: { kind: 'textureView' as const, value: binding.textureView },
                })),
              ],
            })
            .unwrap();
          const pass = encoder.beginComputePass({ label: 'terrain-layer-bake' });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(
            Math.ceil(item.output.width / 8),
            Math.ceil(item.output.height / 8),
          );
          pass.end();
        }
      }
    } catch (cause) {
      for (const buffer of buffers) this.device.destroyBuffer(buffer);
      throw cause;
    }
    let completed = false;
    return {
      complete: (submitted) => {
        if (completed) return;
        completed = true;
        const done = submitted ? this.device.queue.onSubmittedWorkDone() : undefined;
        const cleanup = () => {
          for (const buffer of buffers) this.device.destroyBuffer(buffer);
        };
        if (done === undefined) cleanup();
        else void done.then(cleanup, cleanup);
        if (!submitted) return;
        this.work.splice(0, work.length);
        for (const item of work) this.release(item, done);
      },
    };
  }
  dispose(): void {
    for (const item of this.work) this.release(item);
    this.work.length = 0;
  }
  private release(work: Work, done?: Promise<unknown>): void {
    work.source.release(done);
    for (const lease of work.leases) {
      if (done !== undefined) lease.track(done);
      void lease.release(false);
    }
  }
  private initialize(): void {
    if (this.pipeline !== undefined) return;
    this.layout = this.device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
          {
            binding: 1,
            visibility: 4,
            texture: { sampleType: 'float', viewDimension: '2d-array' },
          },
          { binding: 2, visibility: 4, sampler: { type: 'filtering' } },
          ...NAMES.map((_, i) => ({
            binding: i + 3,
            visibility: 4,
            storageTexture: {
              access: 'write-only' as const,
              format: 'rgba16float' as const,
              viewDimension: '2d-array' as const,
            },
          })),
        ],
      })
      .unwrap();
    this.pipeline = this.device
      .createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }).unwrap(),
        compute: {
          module: this.shader
            .createShaderModule({ code: TERRAIN_LAYER_BAKE_SHADER, label: 'terrain-layer-bake' })
            .unwrap(),
          entryPoint: 'bakeLayers',
        },
      })
      .unwrap();
  }
}
