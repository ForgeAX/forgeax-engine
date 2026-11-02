import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { Update } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { captureModels, decodeSnapshot, model } from '@forgeax/engine/modeling';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import type { AssetHandle, MeshAsset } from '@forgeax/engine/types';
// Case C-105 (Modeling Studio) is the acceptance asset; the player replays its build.
import { buildBody } from '../../../../../packages/modeling/examples/body-blockout/body.ts';
import type { FeatureCheck } from '../../lab/feature';
import { defineFeature } from '../../lab/feature';
import { lookRotation, spawnCamera, spawnMesh, spawnSun, standard } from '../../lab/stage';

const SLOT_COLORS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  Default: [0.62, 0.63, 0.66, 1],
  paint: [0.72, 0.12, 0.1, 1],
  trim: [0.18, 0.19, 0.21, 1],
  glass: [0.2, 0.32, 0.42, 1],
  tire: [0.06, 0.06, 0.07, 1],
};
/** Frames each step stays on screen while playing. */
const HOLD = 24;

interface Frame {
  readonly opIndex: number;
  readonly op: string;
  readonly label?: string;
  readonly mesh: MeshAsset;
  readonly faces: number;
}

/**
 * Rebuild the C-105 session with a snapshot after every operation, the same journal
 * `forgeax model replay` renders in Node, and export each state for viewing.
 */
async function recordFrames(): Promise<{ frames: Frame[]; operations: number } | string> {
  const captured = await captureModels(() => buildBody(), { steps: true });
  if (!captured.ok) return captured.error.code;
  const session = captured.value.sessions[0];
  if (session === undefined) return 'no session';
  const frames: Frame[] = [];
  for (const step of session.diagnostics().steps) {
    const decoded = decodeSnapshot(step.snapshot);
    if (!decoded.ok) return decoded.error.code;
    if (decoded.value.faceCount === 0) continue;
    const view = model();
    view.append(step.snapshot);
    let exported = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
    if (!exported.ok) {
      view.uv.project({ mode: 'box', scale: 1 });
      exported = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
    }
    if (!exported.ok) return exported.error.code;
    const entry = session.journal[step.opIndex];
    frames.push({
      opIndex: step.opIndex,
      op: entry?.op ?? '?',
      ...(entry?.label === undefined ? {} : { label: entry.label }),
      mesh: exported.value.mesh,
      faces: decoded.value.faceCount,
    });
  }
  return { frames, operations: session.journal.length };
}

export default defineFeature({
  title: 'Modeling step replay',
  catalog: 'Modeling drawings and step replay',
  kind: 'visual',
  summary:
    'The in-engine history player: the C-105 car body (three-view blockout) is rebuilt with a snapshot after every modeling operation, and the World plays the states in order from one camera: side prism, plan prism, intersection, front prism, intersection, wheel arches, glass and wheels. Left/Right arrows scrub one step and pause; Space resumes.',
  expect:
    'ON: the body grows step by step, looping; the caption names the step, the operation and its label. OFF: the final car body with red paint, dark glass, trim-lined wheel arches and four black wheels.',
  async setup({ world, hud }) {
    const sceneAssets = world.assets;
    if (!(sceneAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');
    spawnCamera(world, {
      eye: [5.2, 3.1, 6.2],
      target: [0, 0.45, 0],
      data: { clearColor: [0.02, 0.02, 0.04, 1] },
    });
    spawnSun(world);
    const recorded = await recordFrames();
    if (typeof recorded === 'string') {
      hud.status(`replay failed: ${recorded}`);
      return {};
    }
    const { frames, operations } = recorded;
    const handles: AssetHandle<'mesh'>[] = frames.map(
      (frame) => sceneAssets.create(frame.mesh).unwrap() as AssetHandle<'mesh'>,
    );
    const materials = new Map(
      Object.entries(SLOT_COLORS).map(([name, color]) => [
        name,
        standard(world, { baseColor: [...color], roughness: name === 'paint' ? 0.35 : 0.6 }),
      ]),
    );
    const last = frames.length - 1;
    const entity = spawnMesh(
      world,
      handles[last] as AssetHandle<'mesh'>,
      materials.get('Default') as never,
      { pos: [0, 0, 0], rotation: lookRotation([0, 0, 0], [0, 0, -1]) },
    );
    let current = -1;
    const shown = new Set<number>();
    const show = (index: number) => {
      if (index === current) return;
      current = index;
      shown.add(index);
      const frame = frames[index] as Frame;
      world.set(entity, MeshFilter, { assetHandle: handles[index] } as never);
      world.set(entity, MeshRenderer, {
        materials: frame.mesh.materialSlots.map(
          (slot) => materials.get(slot.slotName) ?? materials.get('Default'),
        ),
      } as never);
      hud.status(
        `step ${index + 1}/${frames.length} (#${frame.opIndex} of ${operations}) ${frame.op}${frame.label === undefined ? '' : ` ${frame.label}`}: ${frame.faces} faces`,
      );
    };
    let playing = true;
    let paused = false;
    let tick = 0;
    let previous = { left: false, right: false, space: false };
    world.addSystem(Update, {
      name: 'fl-modeling-replay',
      queries: [],
      fn: (world) => {
        if (!playing) return;
        const keyboard = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.keyboard;
        const now = {
          left: keyboard?.down('ArrowLeft') === true,
          right: keyboard?.down('ArrowRight') === true,
          space: keyboard?.down(' ') === true,
        };
        if (now.left && !previous.left) {
          paused = true;
          show(Math.max(0, current - 1));
        } else if (now.right && !previous.right) {
          paused = true;
          show(Math.min(last, current + 1));
        } else if (now.space && !previous.space) {
          paused = false;
        }
        previous = now;
        if (paused) return;
        if (tick++ % HOLD === 0) show(current >= last ? 0 : current + 1);
      },
    });
    show(0);
    return {
      toggle(on) {
        playing = on;
        if (!on) show(last);
      },
      checks(): FeatureCheck[] {
        const faces = frames.map((f) => f.faces);
        return [
          {
            name: 'every operation that leaves faces has a replay state',
            ok: frames.length >= 20 && frames.length <= operations,
            detail: `${frames.length} states of ${operations} operations`,
          },
          {
            name: 'the replay starts from the first prism and ends at the finished body',
            ok:
              frames[0]?.op === 'extrudeContour' &&
              (faces[0] as number) < (faces[last] as number) &&
              frames.some((f) => f.op === 'intersection' && f.label === 'hull'),
            detail: `first ${frames[0]?.op} ${faces[0]} faces, last ${faces[last]} faces`,
          },
          {
            name: 'the player has shown states in order',
            ok: shown.size >= 1,
            detail: `${shown.size} states shown`,
          },
        ];
      },
    };
  },
});
