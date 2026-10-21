import { RhiError } from '@forgeax/engine-rhi';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { materialUsesSpriteGeometry } from '../material-resource';
import type { MaterialSnapshot } from '../render-system-extract';

/** Material-derived geometry is shared work, before visiting any draw members. */
export function materialGeometry(
  mesh: MeshGpuHandles,
  material: MaterialSnapshot,
  nineSlice: () => MeshGpuHandles,
): MeshGpuHandles {
  if (!materialUsesSpriteGeometry(material)) return mesh;
  const slices = material.paramSnapshot?.slicesAndMode as ArrayLike<number> | undefined;
  if (
    slices === undefined ||
    slices.length < 4 ||
    (slices[0] === 0 && slices[1] === 0 && slices[2] === 0 && slices[3] === 0)
  )
    return mesh;
  if (mesh.submeshes.length !== 1)
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'one source submesh for nine-slice sprite geometry',
      hint: 'bind each nine-slice sprite to its own mesh; replacing a multi-submesh mesh would discard other draws',
    });
  return nineSlice();
}
