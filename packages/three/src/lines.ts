import { type MeshAttributeWindow, meshAttributeWindow } from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import type {
  BufferAttribute,
  InterleavedBufferAttribute,
  Line,
  LineDashedMaterial,
  Material,
} from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';
import { isDashedMaterial } from './material-kinds';
import { surfaceScalar } from './node-inputs';

type Submesh = MeshAsset['submeshes'][number];
const solid = { dashSize: 1, gapSize: 0, dashOffset: 0 };

function segmentLength(position: MeshAttributeWindow, a: number, b: number) {
  const start = position.offset + a * position.stride,
    finish = position.offset + b * position.stride;
  return Math.hypot(
    (position.data[finish] ?? 0) - (position.data[start] ?? 0),
    (position.data[finish + 1] ?? 0) - (position.data[start + 1] ?? 0),
    (position.data[finish + 2] ?? 0) - (position.data[start + 2] ?? 0),
  );
}

/** Native expansion computes cumulative local arc length, independently per submesh. */
export function lineStyle(line: Line, mesh: MeshAsset, materials: readonly Material[]) {
  let style: typeof solid | undefined;
  for (const submesh of mesh.submeshes) {
    const material = materials[submesh.materialSlot ?? 0];
    const selected =
      material !== undefined && isDashedMaterial(material)
        ? dashedStyle(line, mesh, submesh, material)
        : solid;
    if (selected === null) return null;
    if (style !== undefined && JSON.stringify(style) !== JSON.stringify(selected))
      return unsupported(
        'Different dash styles/phases in one Line require native per-submesh line style',
        line.uuid,
      ).unwrap();
    style = selected;
  }
  return style ?? solid;
}

function constantDash(phase: number, dashSize: number, gapSize: number) {
  const period = dashSize + gapSize;
  const remainder = phase % period;
  return (remainder < 0 ? remainder + period : remainder) > dashSize ? null : solid;
}

function dashedStyle(line: Line, mesh: MeshAsset, submesh: Submesh, material: LineDashedMaterial) {
  const offset = surfaceScalar(
    material,
    'offsetNode',
    'dashOffset' in material ? Number(material.dashOffset) : 0,
  );
  const scale = surfaceScalar(material, 'dashScaleNode', material.scale);
  const dashSize = surfaceScalar(material, 'dashSizeNode', material.dashSize);
  const gapSize = surfaceScalar(material, 'gapSizeNode', material.gapSize);
  if (![scale, dashSize, gapSize, offset].every(Number.isFinite) || dashSize <= 0 || gapSize < 0)
    return invalid('LineDashedMaterial scale/dashSize/gapSize/dashOffset', material.uuid).unwrap();
  const attribute = line.geometry.getAttribute('lineDistance');
  if (attribute === undefined || scale === 0) return constantDash(offset, dashSize, gapSize);
  const indices = mesh.indices as Uint16Array | Uint32Array;
  const phase = attribute.getX(indices[submesh.indexOffset] ?? 0) * scale + offset;
  const rate = affineDistance(line, mesh, submesh, attribute, scale, offset, phase);
  if (rate === 0) return constantDash(phase, dashSize, gapSize);
  return {
    dashSize: dashSize / Math.abs(rate),
    gapSize: gapSize / Math.abs(rate),
    dashOffset: rate > 0 ? phase / rate : (dashSize - phase) / -rate,
  };
}

/** Keep the existing affine-distance admission; source offsets do not alter the slope. */
function affineDistance(
  line: Line,
  mesh: MeshAsset,
  submesh: Submesh,
  attribute: BufferAttribute | InterleavedBufferAttribute,
  scale: number,
  offset: number,
  phase: number,
) {
  const positions = meshAttributeWindow(mesh, 'position');
  if (positions === undefined || !(positions.data instanceof Float32Array))
    return invalid('Line geometry position channel', line.uuid).unwrap();
  const indices = mesh.indices as Uint16Array | Uint32Array;
  const first = submesh.indexOffset,
    end = first + submesh.indexCount;
  const strip = submesh.topology === 'line-strip';
  let distance = 0,
    slope: number | undefined;
  for (let cursor = first; cursor + 1 < end; cursor += strip ? 1 : 2) {
    const a = indices[cursor] ?? 0,
      b = indices[cursor + 1] ?? 0;
    const length = segmentLength(positions, a, b);
    const startValue = attribute.getX(a) * scale + offset,
      endValue = attribute.getX(b) * scale + offset;
    if (length > 0 && slope === undefined) slope = (endValue - startValue) / length;
    const rate = slope ?? 0;
    if (
      ![startValue, endValue].every(Number.isFinite) ||
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
  return slope ?? 0;
}
