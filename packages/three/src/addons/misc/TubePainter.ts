import { TubePainter as OriginalTubePainter } from 'three/examples/jsm/misc/TubePainter.js';
import type {
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three/src/Three.Core.js';

/** r187 returns this plain object; stroke/updateGeometry are private helpers. */
export interface TubePainter {
  mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  moveTo(position: Vector3): void;
  lineTo(position: Vector3): void;
  setSize(size: number): void;
  setColor(color: Color): void;
  update(): void;
}
export const TubePainter = OriginalTubePainter as unknown as {
  new (): TubePainter;
};
