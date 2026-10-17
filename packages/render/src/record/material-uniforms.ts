import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import type { Handle } from '@forgeax/engine-types';
import { writeMeshSsboBuffer } from '../assembly/mesh-ssbo-grow';
import {
  applyMaterialTextureUvScales,
  applyParamSnapshotToUbo,
  detectNineSliceScaleTooSmall,
  residentTextureView,
  writePbrMaterialUboPayload,
} from './main-pass-material';
import {
  materialUniformComparisonRanges,
  materialUniformWordsDiffer,
} from './material-uniform-comparison';
import type { _InternalRenderPipelineContext } from './render-context';
import { MATERIAL_PER_ENTITY_STRIDE, MATERIAL_UNIFORM_BYTES } from './render-context';

type PayloadCache = NonNullable<_InternalRenderPipelineContext['materialUboPayloadCache']>;
// A view-local byte cache is valid only while it remains the physical buffer's
// last material writer. This also covers intervening captures and other views.
const materialWriters = new WeakMap<Buffer, PayloadCache>();

/** Stage the root parameter storage before any shadow or color pass consumes it. */
export function uploadMaterialUniforms(c: _InternalRenderPipelineContext): void {
  const {
    runtime,
    world,
    store,
    pipelineState,
    validatedOrdered,
    frameState,
    materialSlots,
    materialSlotOwners,
    materialSlotCount,
  } = c;
  if (materialSlotCount === 0) return;
  const counters = frameState.materialUboCounters ?? {
    packHits: 0,
    packMisses: 0,
    comparedSlots: 0,
    unchangedSlots: 0,
    uploadRanges: 0,
    uploadedLogicalBytes: 0,
    skippedUploads: 0,
  };
  frameState.materialUboCounters = counters;
  const storage = pipelineState.materialUniformBuffer;
  const buffers = storage.pages?.buffers ?? (storage.buffer === null ? [] : [storage.buffer]);
  const previous = frameState.materialUboPayloadCache;
  const previousUploaded =
    previous !== undefined &&
    buffers.length > 0 &&
    buffers.every((buffer) => materialWriters.get(buffer) === previous);
  if (
    previousUploaded &&
    previous === c.materialUboPayloadCache &&
    previous?.materialSlots === materialSlots &&
    previous.materialSlotCount === materialSlotCount
  ) {
    counters.skippedUploads++;
    return;
  }
  let compareBytes = previousUploaded;
  let changedSlots = 0;
  let packHits = 0;
  let packMisses = 0;
  let packMissNoComparison = 0;
  let packMissMutable = 0;
  let packMissRuntimeSchema = 0;
  let packMissMovedSlot = 0;
  let packMissCold = 0;
  let rebuild = frameState.materialUboRebuilds ?? 0;
  if (previousUploaded && frameState.materialUboFullChurn === true && (rebuild + 1) % 32 !== 0) {
    let recurring = false;
    for (let slot = 0; slot < Math.min(8, materialSlotCount); slot++)
      if (materialSlots[slot] === previous?.materialSlots[slot]) {
        recurring = true;
        break;
      }
    // Proven complete churn pays one bulk upload, with periodic re-admission.
    if (!recurring) compareBytes = false;
  }
  let dirtyStart = compareBytes ? materialSlotCount * MATERIAL_PER_ENTITY_STRIDE : 0;
  let dirtyEnd = compareBytes ? 0 : materialSlotCount * MATERIAL_PER_ENTITY_STRIDE;
  const cachedMaterialUboPayload = c.materialUboPayloadCache;
  let materialUboPayload: Uint8Array;
  if (
    frameState.materialUboPayloadCache === cachedMaterialUboPayload &&
    cachedMaterialUboPayload?.materialSlots === materialSlots &&
    cachedMaterialUboPayload.materialSlotCount === materialSlotCount
  ) {
    materialUboPayload = cachedMaterialUboPayload.payload;
  } else {
    // Compare current slots against the last successful physical writer. A new
    // context or reordered visibility need not upload unchanged byte content.
    rebuild++;
    frameState.materialUboRebuilds = rebuild;
    // Revoke the old proof before mutating shared CPU bytes; failed packing must retry.
    for (const buffer of buffers) materialWriters.delete(buffer);
    const payloadBytes = materialSlotCount * MATERIAL_PER_ENTITY_STRIDE;
    let storage = frameState.materialUboPayloadCache?.payload;
    if (storage === undefined || storage.byteLength < payloadBytes) {
      storage = new Uint8Array(Math.max(payloadBytes, (storage?.byteLength ?? 0) * 2));
    }
    materialUboPayload = storage;
    if (!compareBytes) materialUboPayload.fill(0, 0, payloadBytes);
    const previousWords =
      previous === undefined
        ? undefined
        : new Uint32Array(
            previous.payload.buffer,
            previous.payload.byteOffset,
            previous.payload.byteLength / 4,
          );
    if (compareBytes && previous !== undefined && storage !== previous.payload)
      materialUboPayload.set(
        previous.payload.subarray(0, Math.min(previous.payload.byteLength, payloadBytes)),
      );
    const basePayloads = frameState.materialUboBasePayloads ?? new WeakMap();
    frameState.materialUboBasePayloads = basePayloads;
    const layouts: (ReturnType<typeof import('@forgeax/engine-types').derive> | undefined)[] = [];
    const slotPayload = new Uint8Array(MATERIAL_UNIFORM_BYTES);
    const slotPayloadF32 = new Float32Array(
      slotPayload.buffer,
      slotPayload.byteOffset,
      slotPayload.byteLength / 4,
    );
    const slotPayloadView = new DataView(
      slotPayload.buffer,
      slotPayload.byteOffset,
      slotPayload.byteLength,
    );
    const slotWords = new Uint32Array(
      slotPayload.buffer,
      slotPayload.byteOffset,
      slotPayload.byteLength / 4,
    );
    for (let materialSlot = 0; materialSlot < materialSlotCount; materialSlot += 1) {
      let layout: ReturnType<typeof import('@forgeax/engine-types').derive> | undefined;
      const mat = materialSlots[materialSlot];
      const entry = materialSlotOwners[materialSlot];
      if (mat === undefined || entry === undefined) slotPayload.fill(0);
      else {
        // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13 (D-2):
        // single unified Material UBO write path. Sprite materials now flow
        // through the same `buildPbrMaterialUboPayload` baseline +
        // `applyParamSnapshotToUbo` generic std140 overlay every other
        // paramSchema-driven material uses. Extract folds the sprite-specific
        // user inputs into the UBO-aligned paramSnapshot vec4 entries
        // (colorTint / region / pivotAndSize / slicesAndMode); the writer
        // walks `derive(paramSchema).uboLayout.entries` and writes each at
        // its std140 offset. The legacy sprite-specific UBO builder + the
        // sprite-vs-PBR branch are gone (AC-03).
        const materialShaderId = mat.materialShaderId;
        const schema =
          mat.materialParamSchema ??
          (materialShaderId !== undefined ? runtime.getParamSchema?.(materialShaderId) : undefined);
        let basePayload: ReturnType<typeof basePayloads.get>;
        if (!compareBytes) packMissNoComparison++;
        else if (mat.immutableValues !== true) packMissMutable++;
        else if (mat.materialParamSchema === undefined) packMissRuntimeSchema++;
        else if (previous?.materialSlots[materialSlot] !== mat) packMissMovedSlot++;
        else {
          basePayload = basePayloads.get(mat);
          if (basePayload === undefined) packMissCold++;
        }
        if (basePayload !== undefined) {
          packHits++;
          slotPayload.set(basePayload.payload);
          layout = basePayload.layout;
        } else {
          packMisses++;
          layout = writePbrMaterialUboPayload(slotPayloadF32, mat, slotPayloadView);
        }
        // Schema-driven paramSnapshot overlay generalised in feat-20260625
        // M1 / w3: the writer walks `derive(paramSchema).uboLayout.entries`
        // and writes each numeric field at its std140 offset (plan-strategy
        // section 2 D-2). The engine's stock PBR material ships
        // `paramSnapshot: undefined`, so this is a no-op on the default
        // PBR path -- the explicit field writes in buildPbrMaterialUboPayload
        // already cover every byte. User shaders carrying a paramSnapshot
        // (including the post-ablation sprite path) get their fields
        // written at the derive-computed offsets; R-H gate keeps the
        // helper snapshot-only, no asset get.
        // The baseline writer already applies every value in its explicit ABI.
        // Only a runtime-only custom ABI needs the supplemental overlay.
        if (mat.materialParamSchema === undefined)
          applyParamSnapshotToUbo(slotPayloadF32, schema, mat.paramSnapshot, slotPayloadView);
        if (
          compareBytes &&
          basePayload === undefined &&
          mat.immutableValues === true &&
          mat.materialParamSchema !== undefined &&
          previous?.materialSlots[materialSlot] === mat
        )
          // Admit a byte cache only after a snapshot recurs; one-off publications
          // do not allocate a retained payload before they can save packing.
          basePayloads.set(mat, { payload: slotPayload.slice(), layout });
        const processValue = (
          globalThis as {
            process?: { env?: Record<string, string | undefined> };
          }
        ).process;
        if (
          processValue?.env?.FORGEAX_MATERIAL_PIPELINE_DIAGNOSTICS === '1' &&
          (materialShaderId === 'forgeax::default-standard-pbr' ||
            materialShaderId === 'forgeax::pbr-skin')
        ) {
          console.error(
            `[render-material] UBO receipt: ${JSON.stringify({
              entityIndex: entry.renderableIndex,
              materialHandle: mat.materialHandle,
              materialShaderId,
              clearcoat: slotPayloadF32[32],
              clearcoatRoughness: slotPayloadF32[33],
              clearcoatNormalScale: slotPayloadF32[34],
              paramSnapshot: mat.paramSnapshot,
            })}`,
          );
        }
        applyMaterialTextureUvScales(slotPayloadF32, mat, world);
        // Missing-texture detection: structural debug-pink fallback overrides
        // the baseColor/colorTint slot when a bound baseColorTexture handle
        // resolves to no GPU view. Runs for every textured material path
        // (sprite / sprite-lit / standard-pbr / pbr-skin / unlit) — the bound
        // texture would otherwise silently fall back to the 1x1 white view in
        // the per-submesh BG (main-pass-material.ts), rendering flat with no
        // warn / RhiError. Mirroring the telemetry here makes a missing/failed
        // GLB texture immediately diagnosable instead of a silent flat render
        // (feat-future-pbr-missing-texture-fallback-explicit; feedback
        // 2026-07-04-glb-pbr-textures-not-applied-flat-render).
        //
        // Reads only `mat.baseColorTexture` + the GPU view registry (plan R-H
        // gate: no asset.get<MaterialAsset> reach-back). The debug-pink write
        // lands on f32[0..2], which is baseColor.rgb for the PBR/skin UBO and
        // colorTint.rgb for the sprite UBO — same offset, so one override
        // covers both.
        {
          const matHandleRaw = mat.baseColorTexture as Handle<'TextureAsset', 'shared'> | undefined;
          if (matHandleRaw !== undefined) {
            const view = residentTextureView(entry.world ?? world, store, runtime, matHandleRaw);
            if (view === undefined) {
              const rawId: number = matHandleRaw;
              if (!frameState.warnedMissingBaseColorTextureHandles.has(rawId)) {
                frameState.warnedMissingBaseColorTextureHandles.add(rawId);
                console.warn(
                  `[forgeax] baseColor texture ${rawId} missing GPU view, rendering debug pink (shader=${materialShaderId ?? '<none>'} entityIndex=${entry.renderableIndex})`,
                );
              }
              runtime.errorRegistry.fire(
                new RhiError({
                  code: 'asset-not-registered',
                  expected: 'material baseColor TextureAsset uploaded to GPU',
                  hint: 'register + uploadTexture the baseColor texture before draw([world], { cameraOwner: 0, resourceOwner: 0 }); rendering falls back to debug pink until then',
                  detail: { assetHandle: rawId },
                }),
              );
              // Debug pink override on slot 0 baseColor/colorTint.rgb (alpha preserved).
              slotPayloadF32[0] = 1.0;
              slotPayloadF32[1] = 0.4;
              slotPayloadF32[2] = 0.7;
            }
          }
        }
      }
      // Runtime-only overlays are not described by the base writer's ABI.
      if (mat?.materialParamSchema === undefined || mat.materialParamSchema.length === 0)
        layout = undefined;
      layouts.push(layout);
      const offset = materialSlot * MATERIAL_PER_ENTITY_STRIDE;
      if (!compareBytes) {
        materialUboPayload.set(slotPayload, offset);
        continue;
      }
      let changed =
        layout === undefined ||
        layout !== previous?.layouts?.[materialSlot] ||
        materialSlot >= (previous?.materialSlotCount ?? 0);
      if (!changed && previousWords !== undefined && layout !== undefined) {
        counters.comparedSlots++;
        const oldMaterial = previous?.materialSlots[materialSlot];
        const ranges = materialUniformComparisonRanges(layout);
        const immutable = mat?.immutableValues === true && mat === oldMaterial;
        changed = materialUniformWordsDiffer(
          slotWords,
          previousWords,
          offset / 4,
          immutable ? ranges.dynamic : ranges.values,
        );
      }
      if (!changed) counters.unchangedSlots++;
      if (changed) changedSlots++;
      if (changed) {
        dirtyStart = Math.min(dirtyStart, offset);
        dirtyEnd = Math.max(dirtyEnd, offset + MATERIAL_PER_ENTITY_STRIDE);
        materialUboPayload.fill(0, offset, offset + MATERIAL_PER_ENTITY_STRIDE);
        materialUboPayload.set(slotPayload, offset);
      }
    }

    // Material UBO slots can share one snapshot identity, but nine-slice
    // validity depends on each entity's transform. Preserve diagnostics per
    // renderable instead of inheriting the first owner of a shared slot.
    for (const entry of validatedOrdered) {
      const mat = entry.source.material;
      const materialShaderId = mat.materialShaderId;
      if (materialShaderId !== 'forgeax::sprite' && materialShaderId !== 'forgeax::sprite-lit')
        continue;
      const slicesAndMode = mat.paramSnapshot?.slicesAndMode as readonly number[] | undefined;
      if (slicesAndMode === undefined || slicesAndMode.length < 4) continue;
      const slicesArr: readonly [number, number, number, number] = [
        slicesAndMode[0] ?? 0,
        slicesAndMode[1] ?? 0,
        slicesAndMode[2] ?? 0,
        slicesAndMode[3] ?? 0,
      ];
      if (slicesArr[0] === 0 && slicesArr[1] === 0 && slicesArr[2] === 0 && slicesArr[3] === 0)
        continue;
      detectNineSliceScaleTooSmall(
        entry.source.transform.world,
        slicesArr,
        entry.renderableIndex,
        frameState.warnedNineSliceScaleEntities,
        runtime.metrics,
      );
    }
    counters.packHits += packHits;
    counters.packMisses += packMisses;
    counters.packMissNoComparison = (counters.packMissNoComparison ?? 0) + packMissNoComparison;
    counters.packMissMutable = (counters.packMissMutable ?? 0) + packMissMutable;
    counters.packMissRuntimeSchema = (counters.packMissRuntimeSchema ?? 0) + packMissRuntimeSchema;
    counters.packMissMovedSlot = (counters.packMissMovedSlot ?? 0) + packMissMovedSlot;
    counters.packMissCold = (counters.packMissCold ?? 0) + packMissCold;
    frameState.materialUboFullChurn =
      previousUploaded && (!compareBytes || changedSlots === materialSlotCount);
    // Another capture context can overwrite the same storage. Retain its
    // actual writer identity so an earlier context repopulates before reuse.
    c.materialUboPayloadCache = frameState.materialUboPayloadCache = {
      materialSlots,
      materialSlotCount,
      payload: materialUboPayload,
      layouts,
    };
  }

  const cache = frameState.materialUboPayloadCache;
  if (cache === undefined) return;
  // Another writer or a new allocation invalidates the upload proof. Sparse
  // writes retain the existing paged owner's overlapping-tail semantics.
  if (frameState.materialUboPayloadCache === cachedMaterialUboPayload && previousUploaded) {
    counters.skippedUploads++;
    return;
  }
  for (const buffer of buffers) materialWriters.delete(buffer);
  if (dirtyEnd > dirtyStart) {
    writeMeshSsboBuffer(
      runtime.device.queue,
      storage,
      dirtyStart,
      materialUboPayload,
      dirtyStart,
      dirtyEnd - dirtyStart,
    );
    counters.uploadRanges++;
    counters.uploadedLogicalBytes += dirtyEnd - dirtyStart;
  } else counters.skippedUploads++;
  for (const buffer of buffers) materialWriters.set(buffer, cache);
  const target = storage.pages?.buffers ?? storage.buffer;
  if (target !== null) cache.uploadedBuffer = target;
}
