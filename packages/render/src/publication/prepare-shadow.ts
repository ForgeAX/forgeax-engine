import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import { gpuDrivenMaterialProgramSelection } from '../gpu-driven/material-artifacts';
import { prepareGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import {
  type DispatchEntry,
  type RenderableSnapshot,
  shadowCasterCpuReason,
} from '../render-system-extract';
import type { extractFrames } from '../render-system-extract-tail';

/** Reconsider only source admission that lacked the Renderer shader owner. */
export function preparePublishedShadowPasses(
  snapshot: RenderableSnapshot,
  dispatch: ReadonlyMap<number, readonly DispatchEntry[]> | undefined,
  resolve: NonNullable<
    NonNullable<Parameters<typeof extractFrames>[5]>['getMaterialShaderArtifact']
  >,
): RenderableSnapshot['shadowCasterPasses'] {
  const passes = snapshot.shadowCasterPasses;
  // Skin admission additionally depends on palette/bounds and remains on its
  // existing lane. This owner does not manufacture missing source passes.
  if (passes === undefined || snapshot.skin !== undefined || snapshot.skinPose !== undefined)
    return passes;
  if (!passes.some((pass) => pass.cpuReason === 'unprepared' && pass.gpuDrivenEligible !== false))
    return passes;
  const draws = new Map<number, NonNullable<RenderableSnapshot['gpuDrivenDraws']>[number]>();
  snapshot.gpuDrivenDraws?.forEach((draw, compactIndex) => {
    const sourceIndex = gpuDrivenSourceDrawItemIndex(draw, compactIndex);
    if (!draws.has(sourceIndex)) draws.set(sourceIndex, draw);
  });
  return passes.map((pass) => {
    if (
      pass.cpuReason !== 'unprepared' ||
      pass.gpuDrivenEligible === false ||
      pass.materialShaderId === undefined
    )
      return pass;
    const draw = draws.get(pass.drawItemIndex);
    if (draw?.prepared === undefined) return pass;
    const material = snapshot.materials[draw.materialSlot] ?? snapshot.material;
    if ((material.materialHandle ?? -1) !== pass.materialHandle) return pass;
    const entries = dispatch?.get(pass.materialHandle);
    if (entries?.length !== 1) return pass;
    const entry = entries[0];
    if (
      entry === undefined ||
      entry.passIndex !== pass.passIndex ||
      entry.materialShaderId !== pass.materialShaderId ||
      entry.renderState !== pass.renderState ||
      entry.vertexEntry !== pass.vertexEntry ||
      entry.fragmentEntry !== pass.fragmentEntry
    )
      return pass;
    const cpuReason =
      shadowCasterCpuReason(material, draw, entries, snapshot.morph, snapshot.skin) ??
      shadowCasterCpuReason(material, draw, [pass], snapshot.morph, snapshot.skin);
    if (cpuReason !== undefined)
      return cpuReason === pass.cpuReason ? pass : { ...pass, cpuReason, gpuDrivenEligible: false };
    const selected = gpuDrivenMaterialProgramSelection(material, draw.prepared, 'shadow', pass);
    if (selected === undefined) return pass;
    const artifact = resolve(selected.materialShaderId, {
      vertexColorAvailable: draw.prepared.vertexInputs.some((input) => input.semantic === 'color'),
      deformation: 'rigid',
      pass: 'shadow',
      address: 'scene-index',
    });
    const receipt = artifact?.receipt;
    if (artifact === undefined || receipt?.sceneIndexEntry === undefined) return pass;
    if (artifact.material !== selected.materialShaderId) return pass;
    // A direct-only custom entry has no published mapping to the scene entry.
    if (
      selected.sceneIndexProgramKey === undefined &&
      pass.vertexEntry !== undefined &&
      pass.vertexEntry !== receipt.directEntry
    )
      return pass;
    if (
      receipt.materialRow.byteLength !== draw.prepared.materialRow.byteLength ||
      receipt.materialRow.fields.length !== draw.prepared.materialRow.fields.length ||
      receipt.materialRow.fields.some(
        (field, index) => field !== draw.prepared?.materialRow.fields[index],
      )
    )
      return pass;
    const admission = prepareGpuDrivenDraw({
      snapshot: { ...snapshot, material },
      artifact:
        selected.sceneIndexProgramKey === undefined
          ? artifact
          : {
              ...artifact,
              material: selected.logicalMaterialShaderId,
              specializationKey: selected.sceneIndexProgramKey,
            },
      geometry: {
        identity: draw.prepared.identity.geometry,
        vertexInputs: draw.prepared.vertexInputs,
        topology: draw.topology,
        indexed: draw.kind === 'indexed',
      },
      generation: receipt.generation,
      draw,
    });
    if (!admission.ok) return pass;
    const { cpuReason: _reason, ...accepted } = pass;
    return { ...accepted, gpuDrivenEligible: true };
  });
}
