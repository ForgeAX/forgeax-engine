import type { Texture, TextureView } from '@forgeax/engine-rhi';
import type { GraphTextureAllocation } from './kernel-internal.js';
import type { GraphTextureViewDescriptor } from './types.js';

interface BoundViews {
  readonly descriptor: GraphTextureViewDescriptor;
  readonly first: TextureView;
  additional?: Map<string, TextureView>;
}

function sameSlice(a: GraphTextureViewDescriptor, b: GraphTextureViewDescriptor): boolean {
  return (
    a.format === b.format &&
    a.dimension === b.dimension &&
    a.aspect === b.aspect &&
    a.baseMipLevel === b.baseMipLevel &&
    a.mipLevelCount === b.mipLevelCount &&
    a.baseArrayLayer === b.baseArrayLayer &&
    a.arrayLayerCount === b.arrayLayerCount
  );
}

function sliceKey(d: GraphTextureViewDescriptor): string {
  return `${d.format ?? ''}/${d.dimension ?? ''}/${d.aspect ?? ''}/${d.baseMipLevel ?? ''}/${d.mipLevelCount ?? ''}/${d.baseArrayLayer ?? ''}/${d.arrayLayerCount ?? ''}`;
}

/** Physical bindings available to a successor on this device. Only the actual
 * owning slot can lend its allocation. Views belong to the texture and exact
 * subresource range, including when multiple pass-local labels alias it. */
export class AttachmentBindings {
  private textures: Map<string, GraphTextureAllocation> | undefined;
  private views: Map<Texture, BoundViews> | undefined;

  own(label: string, allocation: GraphTextureAllocation): void {
    this.textures ??= new Map();
    this.textures.set(label, allocation);
  }

  texture(label: string, signature: string): GraphTextureAllocation | undefined {
    const allocation = this.textures?.get(label);
    return allocation?.signature === signature ? allocation : undefined;
  }

  view(texture: Texture, descriptor: GraphTextureViewDescriptor): TextureView | undefined {
    const views = this.views?.get(texture);
    if (views === undefined) return undefined;
    return sameSlice(views.descriptor, descriptor)
      ? views.first
      : views.additional?.get(sliceKey(descriptor));
  }

  bindView(texture: Texture, descriptor: GraphTextureViewDescriptor, view: TextureView): void {
    this.views ??= new Map();
    const existing = this.views.get(texture);
    if (existing === undefined) this.views.set(texture, { descriptor, first: view });
    else {
      existing.additional ??= new Map();
      existing.additional.set(sliceKey(descriptor), view);
    }
  }

  /** Revocation does not release the native leases held by in-flight commands. */
  revoke(): void {
    this.textures = undefined;
    this.views = undefined;
  }
}
