import type { RhiDevice, Texture } from '@forgeax/engine-rhi';

/** Working shadow targets are required for either drawing route and are accounted separately. */
export const DEFAULT_STATIC_SHADOW_BUDGET_BYTES = 64 * 1024 * 1024;
export type StaticShadowProduct =
  | 'directional-shadow-static'
  | 'point-shadow-static'
  | 'spot-shadow-static';

export function isStaticShadowProduct(label: string): label is StaticShadowProduct {
  return (
    label === 'directional-shadow-static' ||
    label === 'point-shadow-static' ||
    label === 'spot-shadow-static'
  );
}

export interface StaticShadowLayout {
  directional: boolean;
  pointMask: number;
  spotMask: number;
}

/** Aggregate promised, live and retiring depth on this device. No view or texture is held here. */
const devices = new WeakMap<RhiDevice, { bytes: number }>();

/** One view owns its promised allocations until recording consumes them or its attempt ends. */
export class StaticShadowMemory {
  readonly layout: StaticShadowLayout = { directional: false, pointMask: 0, spotMask: 0 };
  private readonly deviceTotal: { bytes: number };
  private readonly promised = new Map<StaticShadowProduct, number>();
  private readonly textures = new WeakMap<Texture, number>();
  private ceiling = DEFAULT_STATIC_SHADOW_BUDGET_BYTES;
  revision = 0;

  constructor(private readonly device: RhiDevice) {
    const total = devices.get(device) ?? { bytes: 0 };
    this.deviceTotal = total;
    devices.set(device, total);
  }

  begin(ceiling: number): void {
    this.cancel();
    this.ceiling = ceiling;
    this.revision++;
    this.layout.directional = false;
    this.layout.pointMask = 0;
    this.layout.spotMask = 0;
  }

  cancel(revision = this.revision): void {
    if (revision !== this.revision || this.promised.size === 0) return;
    for (const bytes of this.promised.values()) this.deviceTotal.bytes -= bytes;
    this.promised.clear();
  }

  promise(label: StaticShadowProduct, bytes: number): boolean {
    const prior = this.promised.get(label) ?? 0;
    if (bytes > prior && !this.charge(bytes - prior)) return false;
    if (bytes < prior) this.deviceTotal.bytes -= prior - bytes;
    this.promised.set(label, bytes);
    return true;
  }

  /** Convert the promised bytes to a live native creation before callbacks can reenter. */
  acquire(label: StaticShadowProduct, bytes: number): boolean {
    const promised = this.promised.get(label);
    if (promised !== undefined) {
      this.promised.delete(label);
      if (promised === bytes) return true;
      this.deviceTotal.bytes -= promised;
    }
    return this.charge(bytes);
  }

  private charge(bytes: number): boolean {
    if (bytes > this.ceiling - this.deviceTotal.bytes) return false;
    this.deviceTotal.bytes += bytes;
    return true;
  }

  rejectCreation(bytes: number): void {
    this.deviceTotal.bytes -= bytes;
  }

  adopt(texture: Texture, bytes: number): void {
    this.textures.set(texture, bytes);
  }

  destroyed(texture: Texture): number {
    const bytes = this.textures.get(texture) ?? 0;
    this.textures.delete(texture);
    return bytes;
  }

  /** Native destruction may leave storage in use by a submitted command buffer. */
  releaseAfterCompletion(bytes: number): void {
    if (bytes === 0) return;
    const total = this.deviceTotal;
    void this.device.queue.onSubmittedWorkDone().then(
      () => {
        total.bytes -= bytes;
      },
      // Unknown completion keeps the charge with this device until its lifetime ends.
      () => {},
    );
  }
}
