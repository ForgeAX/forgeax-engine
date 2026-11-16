import { type MeshAttributeWindow, meshAttributeWindow } from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import { type Line, LineDashedMaterial, type Material } from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';

function segmentLength(position: MeshAttributeWindow, a: number, b: number) {
  const start = position.offset + a * position.stride,
    finish = position.offset + b * position.stride;
  return Math.hypot(
    (position.data[finish] ?? 0) - (position.data[start] ?? 0),
    (position.data[finish + 1] ?? 0) - (position.data[start + 1] ?? 0),
    (position.data[finish + 2] ?? 0) - (position.data[start + 2] ?? 0),
  );
}

/** Validate source distances against native cumulative lengths without material policy. */
function affineLineRate(
  line: Line,
  mesh: MeshAsset,
  submesh: MeshAsset['submeshes'][number],
  scale: number,
) {
  const positions = meshAttributeWindow(mesh, 'position');
  if (positions === undefined || !(positions.data instanceof Float32Array))
    return invalid('Line geometry position channel', line.uuid).unwrap();
  const attribute = line.geometry.getAttribute('lineDistance');
  const indices = mesh.indices as Uint16Array | Uint32Array;
  const first = submesh.indexOffset,
    end = first + submesh.indexCount;
  const strip = submesh.topology === 'line-strip';
  const phase = attribute.getX(indices[first] ?? 0) * scale;
  let distance = 0,
    slope: number | undefined;
  for (let cursor = first; cursor + 1 < end; cursor += strip ? 1 : 2) {
    const a = indices[cursor] ?? 0,
      b = indices[cursor + 1] ?? 0;
    const length = segmentLength(positions, a, b);
    const startValue = attribute.getX(a) * scale,
      endValue = attribute.getX(b) * scale;
    if (length > 0 && slope === undefined) slope = (endValue - startValue) / length;
    const rate = slope ?? 0;
    if (
      !Number.isFinite(startValue) ||
      !Number.isFinite(endValue) ||
      Math.abs(startValue - phase - rate * distance) > 1e-5 * Math.max(1, Math.abs(startValue)) ||
      Math.abs(endValue - phase - rate * (distance + length)) >
        1e-5 * Math.max(1, Math.abs(endValue))
    )
      return unsupported(
        'LineDashedMaterial requires affine cumulative lineDistance; arbitrary endpoint distances need native input',
        line.uuid,
      ).unwrap();
    distance += length;
  }
  return { phase, rate: slope ?? 0 };
}

/** Native expansion computes cumulative local arc length, independently per submesh. */
export function lineStyle(line: Line, mesh: MeshAsset, materials: readonly Material[]) {
  const solid = { dashSize: 1, gapSize: 0, dashOffset: 0 };
  const attribute = line.geometry.getAttribute('lineDistance');
  let style: typeof solid | undefined;
  for (const submesh of mesh.submeshes) {
    const material = materials[submesh.materialSlot ?? 0];
    let selected = solid;
    if (material instanceof LineDashedMaterial && attribute !== undefined && material.scale !== 0) {
      if (
        ![material.scale, material.dashSize, material.gapSize].every(Number.isFinite) ||
        material.dashSize <= 0 ||
        material.gapSize < 0
      )
        return invalid('LineDashedMaterial scale/dashSize/gapSize', material.uuid).unwrap();
      const { phase, rate } = affineLineRate(line, mesh, submesh, material.scale);
      if (rate === 0) {
        const period = material.dashSize + material.gapSize;
        if (((phase % period) + period) % period > material.dashSize) return null;
      } else
        selected = {
          dashSize: material.dashSize / Math.abs(rate),
          gapSize: material.gapSize / Math.abs(rate),
          dashOffset: rate > 0 ? phase / rate : (material.dashSize - phase) / -rate,
        };
    }
    if (style !== undefined && JSON.stringify(style) !== JSON.stringify(selected))
      return unsupported(
        'Different dash styles/phases in one Line require native per-submesh line style',
        line.uuid,
      ).unwrap();
    style = selected;
  }
  return style ?? solid;
}
