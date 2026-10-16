import type {
  GraphAccelerationStructure,
  GraphAccess,
  GraphBuffer,
  GraphResourceResolver,
  GraphTextureView,
} from '@forgeax/engine-render-graph';
import type { Buffer, TextureView, Tlas } from '@forgeax/engine-rhi';
import type { Binding } from './irradiance-field';

export type KernelGraphHandle = GraphBuffer | GraphTextureView | GraphAccelerationStructure;
export type KernelBindable = { readonly buffer: Buffer } | TextureView | Tlas;

/**
 * The graph access a compute-kernel roster slot declares, derived from its
 * binding kind so a world-traversal swap (`'tlas'` replacing the Global SDF
 * reads) changes the declared dependencies with the roster. `storage` names
 * how this pass uses its writable slots.
 */
export function kernelGraphAccess(
  kind: Binding,
  resource: KernelGraphHandle,
  storage: 'storage-write' | 'storage-read-write',
): GraphAccess {
  switch (kind) {
    case 'tlas':
      return {
        resource: resource as GraphAccelerationStructure,
        usage: 'acceleration-structure-read',
      };
    case 'uniform':
      return { resource: resource as GraphBuffer, usage: 'uniform-read' };
    case 'read':
      return { resource: resource as GraphBuffer, usage: 'storage-read' };
    case 'storage':
      return { resource: resource as GraphBuffer, usage: storage };
    case 'float':
    case 'depth':
    case 'uint':
      return { resource: resource as GraphTextureView, usage: 'sampled-read' };
  }
}

/** This frame's bindable value for one roster slot. */
export function resolveKernelBinding(
  resources: GraphResourceResolver,
  kind: Binding,
  handle: KernelGraphHandle,
): KernelBindable {
  switch (kind) {
    case 'tlas':
      return resources.accelerationStructure(handle as GraphAccelerationStructure).unwrap();
    case 'uniform':
    case 'read':
    case 'storage':
      return { buffer: resources.buffer(handle as GraphBuffer).unwrap() };
    case 'float':
    case 'depth':
    case 'uint':
      return resources.textureView(handle as GraphTextureView).unwrap();
  }
}
