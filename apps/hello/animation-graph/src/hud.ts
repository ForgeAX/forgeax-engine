// hello-animation-graph HUD (feat-20260713-animation-state-machine-plugin M5 / w33).
//
// Renders the per-frame DAG evaluation readout:
//   - Current parameter knobs (locomotion, walkRunRatio, overlayOn)
//   - Final N-slot weights[] from AnimationPlayer (filled by evaluateAnimationGraph)
//   - Per-node label showing which clip maps to which slot
//   - Total weight sum -- visibly > 1 when overlay Add layer is active

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { AnimationPlayer } from '@forgeax/engine-animation';

export interface HudParams {
  readonly locomotion: number;
  readonly walkRunRatio: number;
  readonly overlayOn: boolean;
  readonly paused: boolean;
}

export function refreshHud(
  el: HTMLElement | null,
  world: World,
  playerEnt: EntityHandle,
  params: HudParams,
): void {
  if (!el) return;
  const apRes = world.get(playerEnt, AnimationPlayer);
  if (!apRes.ok) {
    el.textContent = 'AnimationPlayer not present';
    return;
  }
  const ap = apRes.value as unknown as {
    weights: Float32Array;
    clips: Uint32Array;
  };
  const { locomotion, walkRunRatio, overlayOn, paused } = params;

  // Slot-to-node label: clip leaves in graph construction order.
  //   slot 0 = surveyBase  (node 0, outer Blend child)
  //   slot 1 = walkLeaf    (node 1, inner Blend child)
  //   slot 2 = runLeaf     (node 2, inner Blend child)
  //   slot 3 = overlayLeaf (node 5, Add additive layer, static weight 0.3)
  const SLOT_LABELS = ['Survey(base)', 'Walk(base)', 'Run(base)', 'Survey(overlay@0.3)'];

  const slotCount = ap.weights.length;
  const lines: string[] = [];
  lines.push(`Params: locomotion=${locomotion.toFixed(2)}  walkRun=${walkRunRatio.toFixed(2)}  overlay=${overlayOn ? 'ON' : 'OFF'}  ${paused ? '[PAUSED]' : ''}`);
  lines.push('');
  lines.push('N-slot weights[] (filled by evaluateAnimationGraph):');

  let totalW = 0;
  for (let i = 0; i < slotCount; i++) {
    const w = ap.weights[i] ?? 0;
    totalW += w;
    const label = SLOT_LABELS[i] ?? `slot${i}`;
    lines.push(`  weights[${i}]=${w.toFixed(4)}  (${label})`);
  }
  lines.push(`  total sum = ${totalW.toFixed(4)}${totalW > 1.01 ? '  <- Add layer active (>1)' : ''}`);
  lines.push('');
  lines.push('[A/D] locomotion  [W/S] walkRunRatio  [O] overlay  [Space] pause');

  el.textContent = lines.join('\n');
}
