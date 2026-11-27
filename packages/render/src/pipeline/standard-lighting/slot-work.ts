import type {
  PointLightSnapshot,
  RectAreaDirectLightSnapshot,
  SpotLightSnapshot,
} from '../../render-system-extract';
import type { StandardLocalLightInput } from './light-frame';

const empty = Object.freeze([]);

/** Slot addresses and resources consumed by this publication, after capacity and ablation. */
export function projectLightSlotWork(local: readonly StandardLocalLightInput[]) {
  let shadowSlots: number[] | undefined;
  let points: PointLightSnapshot[] | undefined;
  let spots: SpotLightSnapshot[] | undefined;
  let rects: RectAreaDirectLightSnapshot[] | undefined;
  let complete = true;
  for (let slot = 0; slot < local.length; slot++) {
    const row = local[slot] as StandardLocalLightInput;
    if (row.shadowed) {
      shadowSlots ??= [];
      shadowSlots.push(slot);
    }
    const source = row.source;
    if (source === undefined) {
      complete = false;
      continue;
    }
    if (source.kind === 'directional') continue;
    const ies = source.iesProfileSlice !== undefined && source.iesProfileData !== undefined;
    switch (source.kind) {
      case 'point':
        if (ies) {
          points ??= [];
          points.push(source);
        }
        break;
      case 'spot':
        if (ies || source.cookieSlice !== undefined || source.projectorSlice !== undefined) {
          spots ??= [];
          spots.push(source);
        }
        break;
      case 'rect-area':
        if (ies || source.cookieSlice !== undefined) {
          rects ??= [];
          rects.push(source);
        }
        break;
    }
  }
  return {
    local,
    complete,
    shadowSlots: shadowSlots ?? empty,
    point: points ?? empty,
    spot: spots ?? empty,
    rect: rects ?? empty,
  };
}

type SlotWork = ReturnType<typeof projectLightSlotWork>;

/** Stock views publish their own rows. Borrowed input remains readable at the call boundary. */
export function lightSlotWorkOf(prepared: {
  readonly local: readonly StandardLocalLightInput[];
  readonly slotWork?: SlotWork;
}) {
  return prepared.slotWork?.local === prepared.local
    ? prepared.slotWork
    : projectLightSlotWork(prepared.local);
}
