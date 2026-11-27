import { validateChannelMask } from '../components/lighting-channels';
import type { CameraSnapshot } from '../render-contract';
import { cameraAdmitsLayers } from '../render-layers';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import { SceneSlotFrame } from '../scene/scene-slots';

const layerSuppressions = new WeakMap<
  object,
  Map<number, { layers: Uint32Array | undefined; combined: WeakMap<Uint32Array, Uint32Array> }>
>();
/** Captured scene content retains camera membership across object and camera motion. */
export function mainLayerSuppression(
  scene: PersistentGpuDrivenState,
  camera: CameraSnapshot,
  base: Uint32Array | undefined,
): Uint32Array | undefined {
  const mask = camera.cullMask ?? 0xffffffff;
  const invalid = validateChannelMask(mask, 'cullMask');
  if (invalid) throw invalid;
  const slots = scene.slots;
  const frame = slots instanceof SceneSlotFrame ? slots : undefined;
  if (frame?.allDefaultRenderLayers && (mask & 1) !== 0) return base;
  const content = frame?.contentEpoch ?? slots;
  let masks = layerSuppressions.get(content);
  if (!masks) {
    masks = new Map();
    layerSuppressions.set(content, masks);
  }
  let found = masks.get(mask);
  if (!found) {
    let layers: Uint32Array | undefined;
    for (const row of slots) {
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
    combined = new Uint32Array(Math.max(base.length, found.layers.length));
    combined.set(base);
    for (const [i, word] of found.layers.entries()) combined[i] = (combined[i] ?? 0) | word;
    found.combined.set(base, combined);
  }
  return combined;
}
