// Fixed 4-BGL binding layout contract and 128-bit integer PSO lookup key.

export const BGL_SLOT_VIEW = 0;
export const BGL_SLOT_MATERIAL = 1;
export const BGL_SLOT_MESH_SCENE = 2;
export const BGL_SLOT_INSTANCES = 3;

/** Explicit fixed 4-BGL scene layout family (`[view, material, scene-objects+lights, instance-rows]`). */
export const LAYOUT_FAMILY_SCENE_4BGL = 2;

/** Reserved TextureId targeting the attached native swapchain surface directly. */
export const SURFACE_SWAPCHAIN_HANDLE = 0x7fff_ffff;

/** Render-state bitmask flags decoded by native wgpu PSO compilation. */
export const RENDER_STATE_DEPTH_WRITE = 1 << 0;
export const RENDER_STATE_DEPTH_LESS_EQUAL = 0 << 1;
export const RENDER_STATE_DEPTH_GREATER_EQUAL = 1 << 1;
export const RENDER_STATE_DEPTH_LESS = 2 << 1;
export const RENDER_STATE_DEPTH_ALWAYS = 3 << 1;
export const RENDER_STATE_CULL_NONE = 0 << 3;
export const RENDER_STATE_CULL_BACK = 1 << 3;
export const RENDER_STATE_CULL_FRONT = 2 << 3;
export const RENDER_STATE_ALPHA_BLEND = 1 << 5;

export const VIEW_UNIFORM_BYTES = 1392;
export const VIEW_UNIFORM_SLOT_STRIDE = 1536;

export const PASS_TAG_FORWARD_OPAQUE = 0;
export const PASS_TAG_FORWARD_TRANSPARENT = 1;
export const PASS_TAG_SHADOW_DEPTH = 2;
export const PASS_TAG_DEPTH_PREPASS = 3;
export const PASS_TAG_GBUFFER = 4;
export const PASS_TAG_VELOCITY = 5;
export const PASS_TAG_CUSTOM = 16;

export interface PsoKeyWords {
  readonly w0: number;
  readonly w1: number;
  readonly w2: number;
  readonly w3: number;
}

/**
 * Packs the 128-bit integer PSO key identically to Rust `PsoKey::pack`:
 *   lo = (shaderProgramId:24 << 40) | (vertexLayoutId:16 << 24) | (passAttachmentId:16 << 8) | passTag:8
 *   hi = (layoutFamilyId:16 << 48) | (renderStateBits:32 << 16) | variantFlags:16
 */
export function packPsoKeyInto(
  out: Uint32Array,
  offset: number,
  shaderProgramId: number,
  vertexLayoutId: number,
  passAttachmentId: number,
  passTag: number,
  layoutFamilyId: number,
  renderStateBits: number,
  variantFlags: number,
): void {
  const s = shaderProgramId & 0x00ff_ffff;
  const v = vertexLayoutId & 0xffff;
  const a = passAttachmentId & 0xffff;
  const p = passTag & 0xff;
  const l = layoutFamilyId & 0xffff;
  const r = renderStateBits >>> 0;
  const vf = variantFlags & 0xffff;

  // lo low 32 bits: [31:24] v low 8b | [23:8] a 16b | [7:0] p 8b
  out[offset] = (((v & 0xff) << 24) | (a << 8) | p) >>> 0;
  // lo high 32 bits: [31:8] s 24b | [7:0] v high 8b
  out[offset + 1] = ((s << 8) | (v >>> 8)) >>> 0;
  // hi low 32 bits: [31:16] r low 16b | [15:0] vf 16b
  out[offset + 2] = (((r & 0xffff) << 16) | vf) >>> 0;
  // hi high 32 bits: [31:16] l 16b | [15:0] r high 16b
  out[offset + 3] = ((l << 16) | (r >>> 16)) >>> 0;
}

export function psoKeyBigInt(w0: number, w1: number, w2: number, w3: number): bigint {
  return (
    BigInt(w0 >>> 0) |
    (BigInt(w1 >>> 0) << 32n) |
    (BigInt(w2 >>> 0) << 64n) |
    (BigInt(w3 >>> 0) << 96n)
  );
}

export type PsoStatus = 'ready' | 'compiling' | 'failed';

export interface PsoTableEntry {
  readonly slotId: number;
  status: PsoStatus;
  readonly w0: number;
  readonly w1: number;
  readonly w2: number;
  readonly w3: number;
}

/** Zero-string integer PSO lookup table matching Rust `PsoTable` slot assignment order. */
export class IntegerPsoTable {
  private readonly byKey = new Map<bigint, PsoTableEntry>();
  private nextSlot = 1;

  get size(): number {
    return this.byKey.size;
  }

  get(w0: number, w1: number, w2: number, w3: number): PsoTableEntry | undefined {
    return this.byKey.get(psoKeyBigInt(w0, w1, w2, w3));
  }

  getOrAdmit(
    w0: number,
    w1: number,
    w2: number,
    w3: number,
    initialStatus: PsoStatus = 'ready',
  ): PsoTableEntry {
    const key = psoKeyBigInt(w0, w1, w2, w3);
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const entry: PsoTableEntry = {
      slotId: this.nextSlot++,
      status: initialStatus,
      w0: w0 >>> 0,
      w1: w1 >>> 0,
      w2: w2 >>> 0,
      w3: w3 >>> 0,
    };
    this.byKey.set(key, entry);
    return entry;
  }

  setStatus(w0: number, w1: number, w2: number, w3: number, status: PsoStatus): void {
    const entry = this.byKey.get(psoKeyBigInt(w0, w1, w2, w3));
    if (entry !== undefined) entry.status = status;
  }

  clear(): void {
    this.byKey.clear();
    this.nextSlot = 1;
  }
}
