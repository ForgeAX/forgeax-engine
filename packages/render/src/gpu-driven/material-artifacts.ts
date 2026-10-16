import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import { captureDispatchOverlays, type DispatchOverlays } from '../record/dispatch-overlays';
import type { RenderSystemInternals } from '../record/render-context';
import type { DispatchEntry, MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import {
  capturedPreparedMaterialArtifactKey,
  hasGpuDrivenVertexColor,
  hasRequiredVertexInputs,
  type PreparedGpuDrivenDraw,
} from './prepared-draw';

type ArtifactRow = { readonly source: RenderableSnapshot; readonly renderableIndex: number };
type MaterialPrograms = {
  readonly materialHandle: number;
  forward?: DispatchEntry;
  shadow?: DispatchEntry;
};
type MaterialProgramRow = {
  first?: MaterialPrograms;
  overflow?: Map<number, MaterialPrograms>;
};
type SelectedArtifact = {
  readonly selection: readonly unknown[];
  readonly artifact: MaterialShaderArtifact | undefined;
  variants?: Map<string, SelectedArtifact>;
};

function materialProgramsFor(row: MaterialProgramRow, handle: number) {
  const first = row.first;
  // Preserve Map's numeric key equality, including NaN and signed zero.
  if (
    first !== undefined &&
    (first.materialHandle === handle || Object.is(first.materialHandle, handle))
  )
    return first;
  return row.overflow?.get(handle);
}

interface MaterialProgramSelection {
  logicalMaterialShaderId: string;
  sceneIndexProgramKey: string | undefined;
  materialShaderId: string;
}

/** Select the direct/scene program pair published for this concrete pass. */
export function gpuDrivenMaterialProgramSelection(
  material: MaterialSnapshot,
  prepared: PreparedGpuDrivenDraw,
  pass: 'forward' | 'shadow',
  shadowEntry: { readonly materialShaderId?: string | undefined } | undefined,
  out?: MaterialProgramSelection,
) {
  const logicalMaterialShaderId = material.materialShaderId ?? prepared.identity.material;
  const sceneIndexProgramKeys = material.materialSceneIndexProgramKeys;
  const shadowMaterialShaderId = pass === 'shadow' ? shadowEntry?.materialShaderId : undefined;
  const directMaterialShaderId =
    pass === 'shadow' ? shadowMaterialShaderId : logicalMaterialShaderId;
  let sceneIndexProgramKey: string | undefined;
  for (const passName in sceneIndexProgramKeys) {
    const program = sceneIndexProgramKeys[passName];
    if (
      program?.pass === pass &&
      directMaterialShaderId !== undefined &&
      material.materialProgramKeys?.[passName] === directMaterialShaderId
    ) {
      sceneIndexProgramKey = program.specializationKey;
      break;
    }
  }
  if (sceneIndexProgramKeys !== undefined && sceneIndexProgramKey === undefined) return undefined;
  const materialShaderId =
    pass === 'shadow'
      ? (sceneIndexProgramKey ?? shadowEntry?.materialShaderId ?? logicalMaterialShaderId)
      : (sceneIndexProgramKey ?? logicalMaterialShaderId);
  if (out !== undefined) {
    out.logicalMaterialShaderId = logicalMaterialShaderId;
    out.sceneIndexProgramKey = sceneIndexProgramKey;
    out.materialShaderId = materialShaderId;
    return out;
  }
  return { logicalMaterialShaderId, sceneIndexProgramKey, materialShaderId };
}

export interface GpuDrivenMaterialProgramIndex {
  readonly dispatch: readonly DispatchEntry[];
  readonly rows: readonly (MaterialProgramRow | undefined)[];
  readonly overlays: DispatchOverlays;
}

function indexMaterialPrograms(
  dispatch: readonly DispatchEntry[],
  shadowViews: boolean,
): readonly (MaterialProgramRow | undefined)[] {
  const programEntries: (MaterialProgramRow | undefined)[] = [];
  for (const entry of dispatch) {
    const mode = entry.tags.LightMode;
    if (
      entry.materialShaderId === undefined ||
      (mode !== 'Forward' && (mode !== 'ShadowCaster' || !shadowViews))
    )
      continue;
    let materials = programEntries[entry.renderableIndex];
    if (materials === undefined) {
      materials = {};
      programEntries[entry.renderableIndex] = materials;
    }
    let programs = materialProgramsFor(materials, entry.materialHandle);
    if (programs === undefined) {
      // Keep the separate insertion read: borrowed getters can fail or return
      // another key after lookup. A receiver usually needs only this first slot.
      programs = { materialHandle: entry.materialHandle };
      const first = materials.first;
      if (
        first === undefined ||
        first.materialHandle === programs.materialHandle ||
        Object.is(first.materialHandle, programs.materialHandle)
      )
        materials.first = programs;
      else {
        materials.overflow ??= new Map();
        materials.overflow.set(programs.materialHandle, programs);
      }
    }
    if (mode === 'Forward') programs.forward ??= entry;
    else programs.shadow = entry;
  }
  return programEntries;
}

/** Retain the program index only at the immutable persistent dispatch owner. */
export class GpuDrivenMaterialProgramProjection {
  private current: GpuDrivenMaterialProgramIndex | undefined;
  project(dispatch: readonly DispatchEntry[]): GpuDrivenMaterialProgramIndex {
    if (this.current?.dispatch === dispatch) return this.current;
    let overlays: DispatchOverlays | undefined;
    this.current = {
      dispatch,
      rows: indexMaterialPrograms(dispatch, true),
      get overlays() {
        overlays ??= captureDispatchOverlays(dispatch);
        return overlays;
      },
    };
    return this.current;
  }
  clear(): void {
    this.current = undefined;
  }
}

/** Resolve programs from one retained, pre-cull row/dispatch index domain. */
export function collectGpuDrivenMaterialArtifacts({
  rows,
  dispatch,
  resolve,
  clustered,
  reflectionFallback,
  shadowViews,
  programs,
}: {
  readonly rows: readonly ArtifactRow[];
  readonly dispatch: readonly DispatchEntry[];
  readonly resolve: RenderSystemInternals['getMaterialShaderArtifact'];
  readonly clustered: boolean;
  readonly reflectionFallback: boolean;
  readonly shadowViews: boolean;
  readonly programs?: GpuDrivenMaterialProgramIndex | undefined;
}) {
  // The material key is shared by receivers with and without a local probe.
  // Select one probe-capable program for the frame; sentinel rows yield Sky.
  const probeBlend = rows.some((row) => row.source.probeBlendRecord !== undefined);
  // A receiver roster may repeat one publication thousands of times and may
  // serve both main and shadow views. Resolve each selected request once
  // within this collection. The next frame/recovery observes the producer anew.
  const materialArtifacts = new Map<string, MaterialShaderArtifact>();
  const shadowMaterialArtifacts = new Map<string, MaterialShaderArtifact>();
  // These indices address the retained pre-cull row domain. Validation may
  // leave holes, but neither pass needs to hash that domain again.
  const programEntries =
    programs?.dispatch === dispatch ? programs.rows : indexMaterialPrograms(dispatch, shadowViews);
  const collectArtifacts = (
    rows: readonly ArtifactRow[],
    pass: 'forward' | 'shadow',
    target: Map<string, MaterialShaderArtifact>,
  ): void => {
    if (resolve === undefined) return;
    const selectedArtifacts = new Map<string, SelectedArtifact>();
    const programSelection: MaterialProgramSelection = {
      logicalMaterialShaderId: '',
      sceneIndexProgramKey: undefined,
      materialShaderId: '',
    };
    let previousSelection: readonly unknown[] | undefined;
    let selectedIdentityArtifact: MaterialShaderArtifact | undefined;
    let previousPrepared: PreparedGpuDrivenDraw | undefined;
    let previousTargetArtifact: MaterialShaderArtifact | undefined;
    for (const row of rows) {
      const rowPrograms = programEntries[row.renderableIndex];
      for (const draw of row.source.gpuDrivenDraws ?? []) {
        const prepared = draw.prepared;
        if (prepared === undefined) continue;
        const material = row.source.materials[draw.materialSlot] ?? row.source.material;
        // Keep program identity and entry points on the same selected dispatch.
        // Looking this up per draw must not scan the scene's dispatch roster.
        const programs =
          rowPrograms === undefined
            ? undefined
            : materialProgramsFor(rowPrograms, material.materialHandle ?? -1);
        // Explicit hidden requests have no display/shadow dispatch membership.
        // Their preparation roster still owns the identical authored program.
        const preparationPasses =
          row.source.authorVisible === false ? row.source.pipelinePreparation : undefined;
        const shadowProgramEntry =
          programs?.shadow ??
          preparationPasses?.find(
            (entry) =>
              entry.materialHandle === (material.materialHandle ?? -1) &&
              entry.tags.LightMode === 'ShadowCaster',
          );
        // A modern publication may expose a scene-index pair for its
        // forward Pass but omit ShadowCaster. Keep that material on its
        // explicit CPU shadow lane; do not reinterpret its direct WGSL
        // as a scene-index source and fail later at pipeline creation.
        const selectedProgram = gpuDrivenMaterialProgramSelection(
          material,
          prepared,
          pass,
          shadowProgramEntry,
          programSelection,
        );
        if (selectedProgram === undefined) continue;
        const { logicalMaterialShaderId, sceneIndexProgramKey, materialShaderId } = selectedProgram;
        const sceneIndex = sceneIndexProgramKey !== undefined;
        const programEntry =
          pass === 'shadow'
            ? shadowProgramEntry
            : (programs?.forward ??
              preparationPasses?.find(
                (entry) =>
                  entry.materialHandle === (material.materialHandle ?? -1) &&
                  entry.tags.LightMode === 'Forward',
              ));
        const deformation = prepared.identity.deformation;
        const vertexEntry = programEntry?.vertexEntry;
        const fragmentEntry = programEntry?.fragmentEntry;
        // The accepted target already derived color from this immutable input
        // table. Still read the current program and entries before reusing it.
        if (
          previousTargetArtifact !== undefined &&
          previousTargetArtifact === selectedIdentityArtifact &&
          previousPrepared?.vertexInputs === prepared.vertexInputs &&
          previousSelection !== undefined &&
          previousSelection[4] === materialShaderId &&
          previousSelection[0] === deformation &&
          previousSelection[2] === vertexEntry &&
          previousSelection[3] === fragmentEntry &&
          previousSelection[5] === logicalMaterialShaderId &&
          previousSelection[6] === sceneIndex &&
          previousPrepared?.identity.material === prepared.identity.material &&
          previousPrepared.identity.deformation === deformation &&
          previousPrepared.receiptIdentity === prepared.receiptIdentity &&
          previousPrepared.receiptGeneration === prepared.receiptGeneration
        ) {
          continue;
        }
        const vertexColorAvailable = hasGpuDrivenVertexColor(prepared.vertexInputs);
        // Repeated receivers retain the full request; alternating programs
        // still use the exact-key lookup. Admission checks each distinct input table.
        if (
          previousSelection === undefined ||
          previousSelection[0] !== deformation ||
          previousSelection[1] !== vertexColorAvailable ||
          previousSelection[2] !== vertexEntry ||
          previousSelection[3] !== fragmentEntry ||
          previousSelection[4] !== materialShaderId ||
          previousSelection[5] !== logicalMaterialShaderId ||
          previousSelection[6] !== sceneIndex ||
          previousSelection[7] !== pass
        ) {
          const first = selectedArtifacts.get(materialShaderId);
          let selected = first;
          if (
            first === undefined ||
            first.selection[0] !== deformation ||
            first.selection[1] !== vertexColorAvailable ||
            first.selection[2] !== vertexEntry ||
            first.selection[3] !== fragmentEntry ||
            first.selection[5] !== logicalMaterialShaderId ||
            first.selection[6] !== sceneIndex
          ) {
            const selection = [
              deformation,
              vertexColorAvailable,
              vertexEntry,
              fragmentEntry,
              materialShaderId,
              logicalMaterialShaderId,
              // A scene-index key is already materialShaderId; only its presence
              // distinguishes the logical-identity overlay from a direct fallback.
              sceneIndex,
              pass,
            ];
            // One shader normally has one request per pass. Keep that request
            // directly; only distinct entry/ABI variants need composite keys.
            const selectionKey = first === undefined ? undefined : JSON.stringify(selection);
            selected = selectionKey === undefined ? undefined : first?.variants?.get(selectionKey);
            if (selected === undefined) {
              const artifact = resolve(materialShaderId, {
                vertexColorAvailable,
                deformation: prepared.identity.deformation,
                pass,
                address: 'scene-index',
                ...(pass === 'forward'
                  ? {
                      clustered: clustered,
                      probeBlend,
                      reflectionFallback: reflectionFallback,
                    }
                  : {}),
              });
              const selectedArtifact =
                artifact === undefined
                  ? undefined
                  : programEntry === undefined
                    ? artifact
                    : {
                        ...artifact,
                        ...(programEntry.vertexEntry === undefined
                          ? {}
                          : { vertexEntry: programEntry.vertexEntry }),
                        ...(programEntry.fragmentEntry === undefined
                          ? {}
                          : { fragmentEntry: programEntry.fragmentEntry }),
                      };
              // A scene-index program has a distinct registry key but the
              // prepared draw keeps the logical material identity for batching
              // and admission. Carry both facts: `material` remains the logical
              // identity, while `specializationKey` tells the raster owner which
              // published WGSL key must be used for pipeline construction.
              const selectedIdentityArtifact =
                selectedArtifact === undefined || sceneIndexProgramKey === undefined
                  ? selectedArtifact
                  : {
                      ...selectedArtifact,
                      material: logicalMaterialShaderId,
                      specializationKey: sceneIndexProgramKey,
                    };
              selected = { selection, artifact: selectedIdentityArtifact };
              if (first === undefined) selectedArtifacts.set(materialShaderId, selected);
              else if (selectionKey !== undefined) {
                first.variants ??= new Map();
                first.variants.set(selectionKey, selected);
              }
            }
          }
          selectedIdentityArtifact = selected?.artifact;
          previousSelection = selected?.selection;
        }
        const sameTarget =
          previousTargetArtifact === selectedIdentityArtifact &&
          previousPrepared?.identity.material === prepared.identity.material &&
          previousPrepared.identity.deformation === prepared.identity.deformation &&
          previousPrepared.receiptIdentity === prepared.receiptIdentity &&
          previousPrepared.receiptGeneration === prepared.receiptGeneration;
        // The last accepted target already checked this immutable input table.
        // Changed tables and program/receipt identities still enter admission.
        if (sameTarget && previousPrepared?.vertexInputs === prepared.vertexInputs) {
          continue;
        }
        const receipt = selectedIdentityArtifact?.receipt;
        const shadowVertexInputsMatch =
          pass !== 'shadow' ||
          (receipt !== undefined &&
            hasRequiredVertexInputs(receipt.vertexInputs, prepared.vertexInputs));
        if (
          selectedIdentityArtifact === undefined ||
          receipt === undefined ||
          !shadowVertexInputsMatch ||
          (pass !== 'shadow' &&
            (receipt.receiptIdentity !== prepared.receiptIdentity ||
              receipt.generation !== prepared.receiptGeneration))
        ) {
          continue;
        }
        // Only accepted receivers can replace the last published key/value.
        if (sameTarget) continue;
        target.set(
          capturedPreparedMaterialArtifactKey(prepared) ??
            gpuDrivenMaterialArtifactKey({
              material: prepared.identity.material,
              deformation: prepared.identity.deformation,
              receiptIdentity: prepared.receiptIdentity,
              receiptGeneration: prepared.receiptGeneration,
            }),
          selectedIdentityArtifact,
        );
        previousPrepared = prepared;
        previousTargetArtifact = selectedIdentityArtifact;
      }
    }
  };
  collectArtifacts(rows, 'forward', materialArtifacts);
  if (shadowViews) collectArtifacts(rows, 'shadow', shadowMaterialArtifacts);
  const firstArtifact = materialArtifacts.values().next().value as
    | MaterialShaderArtifact
    | undefined;
  const firstSkinArtifact = [...materialArtifacts.values()].find(
    (artifact) => artifact.receipt?.skinPaletteAddress !== undefined,
  );
  return { materialArtifacts, shadowMaterialArtifacts, firstArtifact, firstSkinArtifact };
}
