// Fixed 4-BGL GPU scene buffers and bind groups for `RhiPhysicalExecutor` (WebGPU / Dawn).
// Byte-for-byte mirror of Rust `kernel-wgpu/src/scene_gpu.rs` (`LAYOUT_FAMILY_SCENE_4BGL = 2`):
//   @group(0) @binding(0): var<uniform> view (dynamic offset, VIEW_UNIFORM_SLOT_STRIDE = 1536)
//   @group(1) @binding(0..6): material UBO + baseColor, sampler, normal, metallicRoughness, emissive, occlusion
//   @group(2) @binding(0..4): scene_objects (96B/row), scene_lights (64B/light), shadow depth tex, shadow cmp sampler, skin_joints
//   @group(3) @binding(0): instance_rows (array<u32>)

import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  PipelineLayout,
  RhiDevice,
  Sampler,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { VIEW_UNIFORM_SLOT_STRIDE } from './pso-key.js';

export const SCENE_OBJECT_STRIDE_BYTES = 96;
export const SCENE_LIGHT_STRIDE_BYTES = 64;

const STAGE_VERTEX = 0x1;
const STAGE_FRAGMENT = 0x2;
const STAGE_VERTEX_FRAGMENT = STAGE_VERTEX | STAGE_FRAGMENT;
const BUF_COPY_DST = 0x0008;
const BUF_UNIFORM = 0x0040;
const BUF_STORAGE = 0x0080;
const TEX_COPY_DST = 0x02;
const TEX_BINDING = 0x04;
const TEX_RENDER_ATTACHMENT = 0x10;

function align4Bytes(bytes: Uint8Array): Uint8Array {
  const aligned = (bytes.byteLength + 3) & ~3;
  if (aligned === bytes.byteLength) return bytes;
  const padded = new Uint8Array(aligned);
  padded.set(bytes);
  return padded;
}

function nextPow2(minValue: number, floor: number): number {
  let cap = Math.max(floor, 1);
  while (cap < minValue) cap *= 2;
  return cap;
}

export interface RhiScene4BglMaterialViews {
  readonly uniformBuffer: Buffer;
  readonly baseColor?: TextureView | undefined;
  readonly normal?: TextureView | undefined;
  readonly metallicRoughness?: TextureView | undefined;
  readonly emissive?: TextureView | undefined;
  readonly occlusion?: TextureView | undefined;
  readonly sampler?: Sampler | undefined;
}

interface BglBundle {
  readonly bglView: BindGroupLayout;
  readonly bglMaterial: BindGroupLayout;
  readonly bglMeshScene: BindGroupLayout;
  readonly bglInstances: BindGroupLayout;
  readonly pipelineLayout: PipelineLayout;
}

function createFourBindGroupLayouts(device: RhiDevice): BglBundle | undefined {
  const bglViewRes = device.createBindGroupLayout({
    label: 'kernel.4bgl.view',
    entries: [
      {
        binding: 0,
        visibility: STAGE_VERTEX_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      },
    ],
  });
  if (!bglViewRes.ok) return undefined;

  const bglMatRes = device.createBindGroupLayout({
    label: 'kernel.4bgl.material',
    entries: [
      { binding: 0, visibility: STAGE_VERTEX_FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: STAGE_FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: STAGE_FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: STAGE_FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 4, visibility: STAGE_FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 5, visibility: STAGE_FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 6, visibility: STAGE_FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });
  if (!bglMatRes.ok) return undefined;

  const bglSceneRes = device.createBindGroupLayout({
    label: 'kernel.4bgl.mesh-scene',
    entries: [
      { binding: 0, visibility: STAGE_VERTEX_FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: STAGE_VERTEX_FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: STAGE_FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 3, visibility: STAGE_FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 4, visibility: STAGE_VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  if (!bglSceneRes.ok) return undefined;

  const bglInstRes = device.createBindGroupLayout({
    label: 'kernel.4bgl.instances',
    entries: [
      { binding: 0, visibility: STAGE_VERTEX_FRAGMENT, buffer: { type: 'read-only-storage' } },
    ],
  });
  if (!bglInstRes.ok) return undefined;

  const plRes = device.createPipelineLayout({
    label: 'kernel.4bgl.pipeline-layout',
    bindGroupLayouts: [bglViewRes.value, bglMatRes.value, bglSceneRes.value, bglInstRes.value],
  });
  if (!plRes.ok) return undefined;

  return {
    bglView: bglViewRes.value,
    bglMaterial: bglMatRes.value,
    bglMeshScene: bglSceneRes.value,
    bglInstances: bglInstRes.value,
    pipelineLayout: plRes.value,
  };
}

function createSolid1x1Texture(
  device: RhiDevice,
  label: string,
  rgba: readonly [number, number, number, number],
): { readonly texture: Texture; readonly view: TextureView } | undefined {
  const texRes = device.createTexture({
    label,
    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: TEX_BINDING | TEX_COPY_DST,
  });
  if (!texRes.ok) return undefined;
  device.queue.writeTexture(
    { texture: texRes.value },
    new Uint8Array(rgba),
    { bytesPerRow: 4, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  const viewRes = device.createTextureView(texRes.value, {});
  if (!viewRes.ok) {
    device.destroyTexture(texRes.value);
    return undefined;
  }
  return { texture: texRes.value, view: viewRes.value };
}

function createDefaultShadowDepth(
  device: RhiDevice,
): { readonly texture: Texture; readonly view: TextureView } | undefined {
  const texRes = device.createTexture({
    label: 'kernel.4bgl.default-shadow',
    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    format: 'depth32float',
    usage: TEX_BINDING | TEX_RENDER_ATTACHMENT,
  });
  if (!texRes.ok) return undefined;
  const viewRes = device.createTextureView(texRes.value, {});
  if (!viewRes.ok) {
    device.destroyTexture(texRes.value);
    return undefined;
  }
  return { texture: texRes.value, view: viewRes.value };
}

export class RhiScene4BglState {
  readonly bglView: BindGroupLayout;
  readonly bglMaterial: BindGroupLayout;
  readonly bglMeshScene: BindGroupLayout;
  readonly bglInstances: BindGroupLayout;
  readonly pipelineLayout: PipelineLayout;

  private frameUniformBuf: Buffer;
  private frameUniformCap: number;
  viewBindGroup: BindGroup;

  private sceneObjectsBuf: Buffer;
  private sceneObjectsCapBytes: number;
  private sceneLightsBuf: Buffer;
  private sceneLightsCapBytes: number;
  private skinJointsBuf: Buffer;
  private skinJointsCapBytes: number;
  private instanceRowsBuf: Buffer;
  private instanceRowsCapBytes: number;

  private readonly defaultWhiteTex: Texture;
  readonly defaultWhiteView: TextureView;
  private readonly defaultNormalTex: Texture;
  readonly defaultNormalView: TextureView;
  readonly defaultSampler: Sampler;
  private readonly defaultShadowTex: Texture;
  readonly defaultShadowView: TextureView;
  readonly shadowSampler: Sampler;

  meshSceneBindGroup: BindGroup;
  instancesBindGroup: BindGroup;

  private constructor(
    private readonly device: RhiDevice,
    bgls: BglBundle,
    buffers: {
      readonly frameUniformBuf: Buffer;
      readonly frameUniformCap: number;
      readonly sceneObjectsBuf: Buffer;
      readonly sceneObjectsCapBytes: number;
      readonly sceneLightsBuf: Buffer;
      readonly sceneLightsCapBytes: number;
      readonly skinJointsBuf: Buffer;
      readonly skinJointsCapBytes: number;
      readonly instanceRowsBuf: Buffer;
      readonly instanceRowsCapBytes: number;
    },
    defaults: {
      readonly whiteTex: Texture;
      readonly whiteView: TextureView;
      readonly normalTex: Texture;
      readonly normalView: TextureView;
      readonly sampler: Sampler;
      readonly shadowTex: Texture;
      readonly shadowView: TextureView;
      readonly shadowSampler: Sampler;
    },
    bindGroups: {
      readonly viewBg: BindGroup;
      readonly meshSceneBg: BindGroup;
      readonly instancesBg: BindGroup;
    },
  ) {
    this.bglView = bgls.bglView;
    this.bglMaterial = bgls.bglMaterial;
    this.bglMeshScene = bgls.bglMeshScene;
    this.bglInstances = bgls.bglInstances;
    this.pipelineLayout = bgls.pipelineLayout;

    this.frameUniformBuf = buffers.frameUniformBuf;
    this.frameUniformCap = buffers.frameUniformCap;
    this.sceneObjectsBuf = buffers.sceneObjectsBuf;
    this.sceneObjectsCapBytes = buffers.sceneObjectsCapBytes;
    this.sceneLightsBuf = buffers.sceneLightsBuf;
    this.sceneLightsCapBytes = buffers.sceneLightsCapBytes;
    this.skinJointsBuf = buffers.skinJointsBuf;
    this.skinJointsCapBytes = buffers.skinJointsCapBytes;
    this.instanceRowsBuf = buffers.instanceRowsBuf;
    this.instanceRowsCapBytes = buffers.instanceRowsCapBytes;

    this.defaultWhiteTex = defaults.whiteTex;
    this.defaultWhiteView = defaults.whiteView;
    this.defaultNormalTex = defaults.normalTex;
    this.defaultNormalView = defaults.normalView;
    this.defaultSampler = defaults.sampler;
    this.defaultShadowTex = defaults.shadowTex;
    this.defaultShadowView = defaults.shadowView;
    this.shadowSampler = defaults.shadowSampler;

    this.viewBindGroup = bindGroups.viewBg;
    this.meshSceneBindGroup = bindGroups.meshSceneBg;
    this.instancesBindGroup = bindGroups.instancesBg;
  }

  static create(device: RhiDevice): RhiScene4BglState | undefined {
    const bgls = createFourBindGroupLayouts(device);
    if (bgls === undefined) return undefined;

    const frameUniformCap = 4096;
    const sceneObjectsCapBytes = 256 * SCENE_OBJECT_STRIDE_BYTES;
    const sceneLightsCapBytes = 16 * SCENE_LIGHT_STRIDE_BYTES;
    const skinJointsCapBytes = 64 * 64;
    const instanceRowsCapBytes = 1024 * 4;

    const fuRes = device.createBuffer({
      label: 'kernel.4bgl.view-ring',
      size: frameUniformCap,
      usage: BUF_UNIFORM | BUF_COPY_DST,
    });
    const objRes = device.createBuffer({
      label: 'kernel.4bgl.scene-objects',
      size: sceneObjectsCapBytes,
      usage: BUF_STORAGE | BUF_COPY_DST,
    });
    const lgtRes = device.createBuffer({
      label: 'kernel.4bgl.scene-lights',
      size: sceneLightsCapBytes,
      usage: BUF_STORAGE | BUF_COPY_DST,
    });
    const skinRes = device.createBuffer({
      label: 'kernel.4bgl.skin-joints',
      size: skinJointsCapBytes,
      usage: BUF_STORAGE | BUF_COPY_DST,
    });
    const instRes = device.createBuffer({
      label: 'kernel.4bgl.instance-rows',
      size: instanceRowsCapBytes,
      usage: BUF_STORAGE | BUF_COPY_DST,
    });
    if (!fuRes.ok || !objRes.ok || !lgtRes.ok || !skinRes.ok || !instRes.ok) return undefined;

    const white = createSolid1x1Texture(device, 'kernel.4bgl.default-white', [255, 255, 255, 255]);
    const normal = createSolid1x1Texture(
      device,
      'kernel.4bgl.default-normal',
      [128, 128, 255, 255],
    );
    const shadow = createDefaultShadowDepth(device);
    const smpRes = device.createSampler({
      label: 'kernel.4bgl.default-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    });
    const shSmpRes = device.createSampler({
      label: 'kernel.4bgl.shadow-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      compare: 'less-equal',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    if (
      white === undefined ||
      normal === undefined ||
      shadow === undefined ||
      !smpRes.ok ||
      !shSmpRes.ok
    ) {
      return undefined;
    }

    const viewBg = device.createBindGroup({
      label: 'kernel.4bgl.view-bg',
      layout: bgls.bglView,
      entries: [
        {
          binding: 0,
          resource: {
            kind: 'buffer',
            value: { buffer: fuRes.value, offset: 0, size: VIEW_UNIFORM_SLOT_STRIDE },
          },
        },
      ],
    });
    const meshSceneBg = device.createBindGroup({
      label: 'kernel.4bgl.mesh-scene-bg',
      layout: bgls.bglMeshScene,
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: objRes.value } } },
        { binding: 1, resource: { kind: 'buffer', value: { buffer: lgtRes.value } } },
        { binding: 2, resource: { kind: 'textureView', value: shadow.view } },
        { binding: 3, resource: { kind: 'sampler', value: shSmpRes.value } },
        { binding: 4, resource: { kind: 'buffer', value: { buffer: skinRes.value } } },
      ],
    });
    const instBg = device.createBindGroup({
      label: 'kernel.4bgl.instances-bg',
      layout: bgls.bglInstances,
      entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: instRes.value } } }],
    });
    if (!viewBg.ok || !meshSceneBg.ok || !instBg.ok) return undefined;

    return new RhiScene4BglState(
      device,
      bgls,
      {
        frameUniformBuf: fuRes.value,
        frameUniformCap,
        sceneObjectsBuf: objRes.value,
        sceneObjectsCapBytes,
        sceneLightsBuf: lgtRes.value,
        sceneLightsCapBytes,
        skinJointsBuf: skinRes.value,
        skinJointsCapBytes,
        instanceRowsBuf: instRes.value,
        instanceRowsCapBytes,
      },
      {
        whiteTex: white.texture,
        whiteView: white.view,
        normalTex: normal.texture,
        normalView: normal.view,
        sampler: smpRes.value,
        shadowTex: shadow.texture,
        shadowView: shadow.view,
        shadowSampler: shSmpRes.value,
      },
      {
        viewBg: viewBg.value,
        meshSceneBg: meshSceneBg.value,
        instancesBg: instBg.value,
      },
    );
  }

  uploadViewUniforms(uniformData: Uint8Array): void {
    const needed = Math.max(VIEW_UNIFORM_SLOT_STRIDE, (uniformData.byteLength + 255) & ~255);
    if (needed > this.frameUniformCap) {
      const nextCap = nextPow2(needed, 4096);
      const nextRes = this.device.createBuffer({
        label: 'kernel.4bgl.view-ring',
        size: nextCap,
        usage: BUF_UNIFORM | BUF_COPY_DST,
      });
      if (nextRes.ok) {
        const bgRes = this.device.createBindGroup({
          label: 'kernel.4bgl.view-bg',
          layout: this.bglView,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: { buffer: nextRes.value, offset: 0, size: VIEW_UNIFORM_SLOT_STRIDE },
              },
            },
          ],
        });
        if (bgRes.ok) {
          this.device.destroyBuffer(this.frameUniformBuf);
          this.frameUniformBuf = nextRes.value;
          this.frameUniformCap = nextCap;
          this.viewBindGroup = bgRes.value;
        }
      }
    }
    if (uniformData.byteLength > 0) {
      this.device.queue.writeBuffer(this.frameUniformBuf, 0, align4Bytes(uniformData));
    }
  }

  uploadSceneObjects(packedBytes: Uint8Array): void {
    if (packedBytes.byteLength === 0) return;
    let rebind = false;
    if (packedBytes.byteLength > this.sceneObjectsCapBytes) {
      const nextCap = nextPow2(packedBytes.byteLength, 256 * SCENE_OBJECT_STRIDE_BYTES);
      const res = this.device.createBuffer({
        label: 'kernel.4bgl.scene-objects',
        size: nextCap,
        usage: BUF_STORAGE | BUF_COPY_DST,
      });
      if (res.ok) {
        this.device.destroyBuffer(this.sceneObjectsBuf);
        this.sceneObjectsBuf = res.value;
        this.sceneObjectsCapBytes = nextCap;
        rebind = true;
      }
    }
    this.device.queue.writeBuffer(this.sceneObjectsBuf, 0, align4Bytes(packedBytes));
    if (rebind) this.rebuildDefaultMeshSceneBg();
  }

  uploadSceneLights(packedBytes: Uint8Array): void {
    if (packedBytes.byteLength === 0) return;
    let rebind = false;
    if (packedBytes.byteLength > this.sceneLightsCapBytes) {
      const nextCap = nextPow2(packedBytes.byteLength, 16 * SCENE_LIGHT_STRIDE_BYTES);
      const res = this.device.createBuffer({
        label: 'kernel.4bgl.scene-lights',
        size: nextCap,
        usage: BUF_STORAGE | BUF_COPY_DST,
      });
      if (res.ok) {
        this.device.destroyBuffer(this.sceneLightsBuf);
        this.sceneLightsBuf = res.value;
        this.sceneLightsCapBytes = nextCap;
        rebind = true;
      }
    }
    this.device.queue.writeBuffer(this.sceneLightsBuf, 0, align4Bytes(packedBytes));
    if (rebind) this.rebuildDefaultMeshSceneBg();
  }

  uploadSkinJoints(slotOffset: number, jointMatrices: Float32Array): void {
    if (jointMatrices.length === 0) return;
    const byteOffset = Math.max(0, slotOffset | 0) * 64;
    const byteLen = jointMatrices.byteLength;
    const needed = byteOffset + byteLen;
    let rebind = false;
    if (needed > this.skinJointsCapBytes) {
      const nextCap = nextPow2(needed, 64 * 64);
      const res = this.device.createBuffer({
        label: 'kernel.4bgl.skin-joints',
        size: nextCap,
        usage: BUF_STORAGE | BUF_COPY_DST,
      });
      if (res.ok) {
        this.device.destroyBuffer(this.skinJointsBuf);
        this.skinJointsBuf = res.value;
        this.skinJointsCapBytes = nextCap;
        rebind = true;
      }
    }
    this.device.queue.writeBuffer(
      this.skinJointsBuf,
      byteOffset,
      new Uint8Array(jointMatrices.buffer, jointMatrices.byteOffset, byteLen),
    );
    if (rebind) this.rebuildDefaultMeshSceneBg();
  }

  uploadInstanceRows(rows: Uint32Array): void {
    if (rows.length === 0) return;
    const needed = rows.byteLength;
    if (needed > this.instanceRowsCapBytes) {
      const nextCap = nextPow2(needed, 1024 * 4);
      const res = this.device.createBuffer({
        label: 'kernel.4bgl.instance-rows',
        size: nextCap,
        usage: BUF_STORAGE | BUF_COPY_DST,
      });
      if (res.ok) {
        const bgRes = this.device.createBindGroup({
          label: 'kernel.4bgl.instances-bg',
          layout: this.bglInstances,
          entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: res.value } } }],
        });
        if (bgRes.ok) {
          this.device.destroyBuffer(this.instanceRowsBuf);
          this.instanceRowsBuf = res.value;
          this.instanceRowsCapBytes = nextCap;
          this.instancesBindGroup = bgRes.value;
        }
      }
    }
    this.device.queue.writeBuffer(
      this.instanceRowsBuf,
      0,
      new Uint8Array(rows.buffer, rows.byteOffset, needed),
    );
  }

  createMaterialBindGroup(views: RhiScene4BglMaterialViews): BindGroup | undefined {
    const res = this.device.createBindGroup({
      label: 'kernel.4bgl.material-bg',
      layout: this.bglMaterial,
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: views.uniformBuffer } } },
        {
          binding: 1,
          resource: { kind: 'textureView', value: views.baseColor ?? this.defaultWhiteView },
        },
        { binding: 2, resource: { kind: 'sampler', value: views.sampler ?? this.defaultSampler } },
        {
          binding: 3,
          resource: { kind: 'textureView', value: views.normal ?? this.defaultNormalView },
        },
        {
          binding: 4,
          resource: {
            kind: 'textureView',
            value: views.metallicRoughness ?? this.defaultWhiteView,
          },
        },
        {
          binding: 5,
          resource: { kind: 'textureView', value: views.emissive ?? this.defaultWhiteView },
        },
        {
          binding: 6,
          resource: { kind: 'textureView', value: views.occlusion ?? this.defaultWhiteView },
        },
      ],
    });
    return res.ok ? res.value : undefined;
  }

  createMeshSceneBindGroup(shadowView?: TextureView): BindGroup | undefined {
    if (shadowView === undefined) return this.meshSceneBindGroup;
    const res = this.device.createBindGroup({
      label: 'kernel.4bgl.mesh-scene-shadow-bg',
      layout: this.bglMeshScene,
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: this.sceneObjectsBuf } } },
        { binding: 1, resource: { kind: 'buffer', value: { buffer: this.sceneLightsBuf } } },
        { binding: 2, resource: { kind: 'textureView', value: shadowView } },
        { binding: 3, resource: { kind: 'sampler', value: this.shadowSampler } },
        { binding: 4, resource: { kind: 'buffer', value: { buffer: this.skinJointsBuf } } },
      ],
    });
    return res.ok ? res.value : undefined;
  }

  private rebuildDefaultMeshSceneBg(): void {
    const res = this.device.createBindGroup({
      label: 'kernel.4bgl.mesh-scene-bg',
      layout: this.bglMeshScene,
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: this.sceneObjectsBuf } } },
        { binding: 1, resource: { kind: 'buffer', value: { buffer: this.sceneLightsBuf } } },
        { binding: 2, resource: { kind: 'textureView', value: this.defaultShadowView } },
        { binding: 3, resource: { kind: 'sampler', value: this.shadowSampler } },
        { binding: 4, resource: { kind: 'buffer', value: { buffer: this.skinJointsBuf } } },
      ],
    });
    if (res.ok) this.meshSceneBindGroup = res.value;
  }

  dispose(): void {
    this.device.destroyBuffer(this.frameUniformBuf);
    this.device.destroyBuffer(this.sceneObjectsBuf);
    this.device.destroyBuffer(this.sceneLightsBuf);
    this.device.destroyBuffer(this.skinJointsBuf);
    this.device.destroyBuffer(this.instanceRowsBuf);
    this.device.destroyTexture(this.defaultWhiteTex);
    this.device.destroyTexture(this.defaultNormalTex);
    this.device.destroyTexture(this.defaultShadowTex);
  }
}
