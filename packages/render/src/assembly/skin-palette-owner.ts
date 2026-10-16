import type { RhiDevice } from '@forgeax/engine-rhi';
import {
  createSkinPaletteAllocator,
  type SkinPaletteAllocator,
} from '../systems/skin-palette-allocator';

/**
 * Constructs the renderer's single skin palette owner. Capability selection
 * stays at assembly, while allocation and writes remain in the allocator.
 */
export function createSkinPaletteOwner(
  device: RhiDevice,
  storageBufferCapable: boolean,
): SkinPaletteAllocator {
  const limitKey = storageBufferCapable
    ? 'maxStorageBufferBindingSize'
    : 'maxUniformBufferBindingSize';
  const deviceLimit = device.limits[limitKey];
  const maxBindingBytes = typeof deviceLimit === 'number' && deviceLimit > 0 ? deviceLimit : 65536;
  return createSkinPaletteAllocator(device, maxBindingBytes, storageBufferCapable);
}
