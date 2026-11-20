import type { CameraSnapshot } from '../render-contract';
import { cameraAdmitsLayers } from '../render-layers';
import type { PersistentGpuDrivenState } from '../scene/render-scene';

const layerSuppressions = new WeakMap<
  object,
  Map<number, { layers: Uint32Array | undefined; combined: WeakMap<Uint32Array, Uint32Array> }>
>();
/** Immutable SceneSlotFrame identity retains camera membership independently
 * of camera pose. A static scene is not scanned again when a camera moves. */
export function mainLayerSuppression(
  scene: PersistentGpuDrivenState,
  camera: CameraSnapshot,
  base: Uint32Array | undefined,
): Uint32Array | undefined {
  let masks = layerSuppressions.get(scene.slots);
  if (!masks) {
    masks = new Map();
    layerSuppressions.set(scene.slots, masks);
  }
  const mask = camera.cullMask ?? 0xffffffff;
  let found = masks.get(mask);
  if (!found) {
    let layers: Uint32Array | undefined;
    for (const row of scene.slots) {
      if (cameraAdmitsLayers(camera, row.snapshot)) continue;
      layers ??= new Uint32Array(Math.max(1, Math.ceil(scene.scene.rowCapacity / 32)));
      const word = row.slot >>> 5;
      layers[word] = (layers[word] ?? 0) | (1 << (row.slot & 31));
    }
    found = { layers, combined: new WeakMap() };
    if (masks.size >= 16) {
      const oldest = masks.keys().next().value;
      if (oldest !== undefined) masks.delete(oldest);
    }
    masks.set(mask, found);
  }
  if (!found.layers) return base;
  if (!base) return found.layers;
  let combined = found.combined.get(base);
  if (!combined) {
    combined = base.slice();
    for (const [i, word] of found.layers.entries()) combined[i] = (combined[i] ?? 0) | word;
    found.combined.set(base, combined);
  }
  return combined;
}
