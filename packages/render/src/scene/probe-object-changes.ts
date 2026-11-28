import type { ProbeSceneDirtyReason, ProbeSceneObjectInput } from './probe-blend';
import { SceneSlotFrame } from './scene-slots';

export type ProbeObjects = SceneSlotFrame | readonly ProbeSceneObjectInput[];

/** Manual callers can edit the same array and positions between publications. */
export function captureProbeObjects(
  current: ProbeObjects,
  previous: ProbeObjects | undefined,
): ProbeObjects {
  if (current instanceof SceneSlotFrame) return current;
  const before = previous instanceof SceneSlotFrame ? undefined : previous;
  let next: ProbeSceneObjectInput[] | undefined;
  for (let i = 0; i < current.length; i++) {
    const object = current[i] as ProbeSceneObjectInput;
    const old = before?.[i];
    if (
      old !== undefined &&
      old.objectKey === object.objectKey &&
      old.generation === object.generation &&
      old.position[0] === object.position[0] &&
      old.position[1] === object.position[1] &&
      old.position[2] === object.position[2]
    ) {
      next?.push(old);
    } else {
      next ??= before?.slice(0, i) ?? [];
      next.push({
        objectKey: object.objectKey,
        generation: object.generation,
        position: [...object.position],
      });
    }
  }
  return (
    next ?? (before?.length === current.length ? before : (before?.slice(0, current.length) ?? []))
  );
}

function forEachProbeObject(
  objects: ProbeObjects,
  visit: (object: ProbeSceneObjectInput) => void,
): void {
  if (objects instanceof SceneSlotFrame) {
    objects.visitPoses(
      (objectKey, _version, _content, column, offset, _rank, _entity, generation) => {
        visit({
          objectKey,
          generation,
          position: [
            column[offset + 12] as number,
            column[offset + 13] as number,
            column[offset + 14] as number,
          ],
        });
      },
    );
  } else for (const object of objects) visit(object);
}

/** Compare the accepted scene rows. A retired journal falls back to the same numeric comparison. */
export function probeObjectChanges(
  current: ProbeObjects,
  previous: ProbeObjects | undefined,
  global: boolean,
  reasons: Set<ProbeSceneDirtyReason>,
  translations: Float32Array,
) {
  const affected = new Map<number, ProbeSceneObjectInput>();
  const removed = new Set<number>();
  function compare(
    before: ProbeSceneObjectInput | undefined,
    after: ProbeSceneObjectInput | undefined,
  ): void {
    if (after === undefined) {
      if (before !== undefined) {
        removed.add(before.objectKey);
        reasons.add('object-boundary');
      }
      return;
    }
    if (before === undefined) {
      reasons.add('object-boundary');
      affected.set(after.objectKey, after);
      return;
    }
    const differentPose =
      before.position[0] !== after.position[0] ||
      before.position[1] !== after.position[1] ||
      before.position[2] !== after.position[2];
    if (differentPose) reasons.add('object-position');
    if (before.generation !== after.generation) reasons.add('generation');
    if (global || differentPose || before.generation !== after.generation)
      affected.set(after.objectKey, after);
  }
  if (previous === undefined) {
    reasons.add('object-boundary');
    forEachProbeObject(current, (object) => affected.set(object.objectKey, object));
  } else if (current === previous) {
    if (global) forEachProbeObject(current, (object) => affected.set(object.objectKey, object));
  } else if (current instanceof SceneSlotFrame && previous instanceof SceneSlotFrame) {
    const compareSlot = (key: number): void => {
      const before = previous.writeTranslation(key, translations);
      const after = current.writeTranslation(key, translations, 3);
      if (after === undefined) {
        if (before !== undefined) {
          removed.add(key);
          reasons.add('object-boundary');
        }
        return;
      }
      if (before === undefined) reasons.add('object-boundary');
      else {
        const differentPose =
          translations[0] !== translations[3] ||
          translations[1] !== translations[4] ||
          translations[2] !== translations[5];
        if (differentPose) reasons.add('object-position');
        if (before !== after) reasons.add('generation');
        if (!global && !differentPose && before === after) return;
      }
      if (affected.has(key)) return;
      affected.set(key, {
        objectKey: key,
        generation: after,
        position: [translations[3] as number, translations[4] as number, translations[5] as number],
      });
    };
    if (!current.changesSince(previous, compareSlot)) {
      current.visitPoses(compareSlot);
      previous.visitPoses((key) => {
        if (current.generationAt(key) !== undefined) return;
        removed.add(key);
        reasons.add('object-boundary');
      });
    }
    if (global) forEachProbeObject(current, (object) => affected.set(object.objectKey, object));
  } else {
    const old = new Map<number, ProbeSceneObjectInput>();
    forEachProbeObject(previous, (object) => old.set(object.objectKey, object));
    forEachProbeObject(current, (object) => {
      compare(old.get(object.objectKey), object);
      old.delete(object.objectKey);
    });
    for (const object of old.values()) compare(object, undefined);
  }
  return { affected, removed };
}
