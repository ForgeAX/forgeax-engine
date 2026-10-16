import { meshSsboBufferBinding } from '../assembly/mesh-ssbo-grow';
import type { RenderResourceScope } from '../publication/resource-scope';
import { clusteredMeshSlotBindGroup, meshSlotBindGroup } from './frame-lighting';
import { resolveSpriteInstancesBuffer, uploadSpriteInstanceBuffer } from './sprite-instance-buffer';
// @forgeax/engine-runtime - RenderSystem record stage: main-pass sprite draws.
// feat-20260704 M5/w31: further-split from main-pass.ts (AC-05 <=1500 lines/file).
// recordSpritePass + sprite entity/transparent/instance-buffer helpers, moved verbatim.

import {
  type BindGroup,
  type Buffer,
  type RenderPipeline,
  RhiError,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import type { MaterialRenderState } from '@forgeax/engine-types';
import type { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '../materials';
import { SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET } from '../pbr-pipeline';
import { buildBeginRenderPassDescriptor, standardTopologyVariantSet } from '../pipeline-spec';
import type { DispatchEntry, MaterialSnapshot } from '../render-system-extract';
import { createFoldedDrawRecorder, resolveFoldInstanceBuffer } from './fold-instance-buffer';
import { recordGeometryDraws, resolveGeometryInstancesBindGroup } from './main-pass-geometry';
import {
  MAX_UNIFORM_INSTANCES,
  MESH_PER_ENTITY_STRIDE,
  packInstanceStorageBuffer,
} from './mesh-ssbo';
import type { _InternalRenderPipelineContext } from './render-context';
import { MATERIAL_PER_ENTITY_STRIDE } from './render-context';

/**
 * Decide whether the LDR record needs the transparent sprite sub-pass. This
 * remains beside the sprite record owner so the frame stage and draw stage
 * share the same transparent-material rule.
 */
export function computeSplitLdrSprite(
  validatedOrdered: readonly (
    | {
        readonly source: {
          readonly material: MaterialSnapshot;
          readonly materials?: readonly MaterialSnapshot[];
        };
      }
    | undefined
  )[],
  tonemapActive: boolean,
  dispatch?: readonly DispatchEntry[],
): boolean {
  if (tonemapActive) return false;
  if (dispatch !== undefined && dispatch.length > 0) {
    return dispatch.some(
      (pass) => pass.tags.LightMode === 'Forward' && pass.renderState?.blend !== undefined,
    );
  }
  for (const entry of validatedOrdered) {
    if (entry === undefined) continue;
    const materials = entry.source.materials;
    if (materials !== undefined) {
      if (materials.some((material) => material.transparent === true)) return true;
    } else if (entry.source.material.transparent === true) {
      return true;
    }
  }
  return false;
}

/**
 * feat-20260704 M3/w19: LDR sprite split sub-pass, extracted verbatim from
 * recordMainPass. Runs after the geometry pass when there are sprite / LDR
 * transparent entities and the split path is active (splitLdrSprite && a raw
 * unorm swap-chain view exists). Ends the geometry `pass`, opens a `spritePass`
 * on the resolved transparent-pass view (loadOp=load), draws the sprite / sprite-lit
 * entities (fold-instanced where possible) then the generic per-submesh
 * transparent PBR submeshes, and ends the sprite pass. Returns the updated
 * `geometryPassEnded` flag so the caller skips the unconditional pass.end().
 *
 * @internal
 */
export function recordSpritePass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  matchedIndices: Set<number> | null,
  materialSlotIndices: readonly (readonly number[])[],
  sampleCount: number,
  resolveMaterialBindGroup: (
    materialSlot: number,
    submeshMaterial: MaterialSnapshot,
    entityKey: number,
    materialWorld: RenderResourceScope,
    materialShaderId?: string,
  ) => BindGroup,
  graphPass?: RhiRenderPassEncoder,
  selectedDispatch?: readonly DispatchEntry[],
): boolean {
  const {
    runtime,
    pipelineState,
    encoder,
    msaaActive,
    ldrSpritePassView,
    ldrSpriteColorView,
    geometryDepthView,
    viewBindGroup,
    meshBindGroup,
    hdrpClusterBindGroup,
    viewBindGroupDynamicOffset = 0,
    splitLdrSprite,
  } = c;
  const clusteredLighting = c.standardLighting?.kind === 'clustered';
  const meshGroup2 = clusteredLighting ? hdrpClusterBindGroup : meshBindGroup;
  // The split pass is also used by the no-tone linear-LDR route. That route
  // keeps transparent draws in the graph-owned rgba16float attachment, so
  // sprite shaders must use their linear/HDR fragment entry point even though
  // the camera itself has no tone map enabled.
  const spriteIsHdr =
    c.tonemapActive || transparentPassColorFormat(c, pipelineState) === 'rgba16float';
  let geometryPassEnded = false;
  if (splitLdrSprite && (graphPass !== undefined || ldrSpritePassView !== null)) {
    if (graphPass === undefined) {
      pass.end();
      geometryPassEnded = true;
    }

    // feat-20260604 M2 / w9 (F-1): under MSAA the sprite sub-pass writes the
    // count=4 transparent-pass view of the SAME multisample texture the
    // geometry pass wrote (loadOp=load preserves geometry under sprites) and
    // resolves the combined result to the single-sample transparent-pass
    // view at this (last) pass end. Depth reuses the shared count=4
    // multisample depth (depthLoadOp=load preserves sprite-vs-mesh occlusion).
    // The single-
    // sample path is byte-for-byte unchanged (writes the swap-chain view).
    const spriteColorView = msaaActive ? ldrSpriteColorView : ldrSpritePassView;
    // sprite-split sub-pass: forward shape with both color and depth loaded
    // (preserves prior content from the main forward pass under the sprites).
    // Stencil ops auto-emitted by the helper because depthFormat carries
    // stencil8.
    const spritePass: RhiRenderPassEncoder =
      graphPass ??
      encoder.beginRenderPass(
        buildBeginRenderPassDescriptor(
          {
            // SSOT for the sprite-pass color format is the resolved transparent
            // attachment. Native linear-LDR frames use graph-owned `ldrColor`
            // (possibly rgba16float); swap-chain fallback frames use their raw
            // storage format. WebGPU requires the attachment format and PSO
            // target to match, so both are resolved by the same helper.
            colorFormats: [transparentPassColorFormat(c) as GPUTextureFormat],
            depthFormat: 'depth32float-stencil8',
            sampleCount: msaaActive ? 4 : 1,
          },
          {
            colorViews: [spriteColorView],
            depthView: geometryDepthView,
            ...(msaaActive ? { resolveTargets: [ldrSpritePassView] } : {}),
          },
          'forward',
          { colorLoadOp: 'load', depthLoadOp: 'load' },
        ) as never,
      );

    spritePass.setBindGroup(0, viewBindGroup as BindGroup, [viewBindGroupDynamicOffset, 0]);

    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w14 (D-7):
    // sprite PSO resolution migrated from the dedicated boot-time PSO
    // fields (deleted) to the generic per-MaterialShader pipeline cache.
    // feat-20260626-collapse M2 / M2-T2: blend factor pair literal moved
    // to the public `SPRITE_PREMULTIPLIED_ALPHA_BLEND` named constant
    // (re-exported from `@forgeax/engine-runtime`) so each AI user
    // building a transparent material declares the same blend by
    // reference; the previous implicit blend-state factory helper is
    // gone. Cache miss still surfaces as a structured
    // `shader-compile-failed` RhiError mirroring the pre-w14 behaviour.
    //
    // feat-20260608-tilemap-object-layer-rendering M2 / m2-t6 (D-8): sprite
    // pipeline cullMode='none'. H/V flip via negative scale x/y (tilemap
    // per-cell entity TRS form) inverts the triangle winding; cullMode='back'
    // would throw the flipped quad away. The sprite pass runs in the
    // alpha-blend transparent bucket back-to-front already, so cullMode='none'
    // adds no overdraw cost. Pre-feat-20260625 the dedicated spritePipeline
    // hard-coded 'none' (deleted in w14); the generic path must replicate
    // it here or the cullmode-flip dawn smoke goes black on negative-scale.
    const spritePremulBlend: MaterialRenderState = {
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
      cullMode: 'none',
      blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND,
    };
    // bug-20260629: PR #526 added PER_INSTANCE_REGION as a second variant
    // axis on sprite.wgsl. Build BOTH variants here; the per-entity loop
    // picks the right one based on whether the entity carries a
    // SpriteInstances snapshot:
    //   - spritePH (PER_INSTANCE_REGION=false): regular per-entity sprites
    //     + fold-bucket instanced draws (64-byte mat4 only instance buf);
    //     UV region comes from the material UBO `region` slot.
    //   - spritePH_withRegion (PER_INSTANCE_REGION=true): SpriteInstances
    //     entities with 80-byte interleaved (mat4 64B + region 16B) per
    //     instance; UV region comes from `instances[idx].region`.
    //
    // Without spritePH_withRegion the SpriteInstances data was uploaded
    // but the shader read bytes 64-79 as region=0 → black quads.
    //
    // feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t7:
    // sprite-lit walks the same LDR transparent split pass with mirror
    // PSO request shape (only materialShaderId string differs). The
    // sprite-lit PSO is fetched lazily per-entity below since the pass
    // mixes sprite + sprite-lit transparent entities. PSO cache strings
    // are isolated by `materialShaderId` (D-11), no slot collision.
    const spritePH =
      runtime.getMaterialShaderPipeline?.(
        'forgeax::sprite',
        spriteIsHdr,
        spritePremulBlend,
        'triangle-list',
        undefined,
        undefined,
        'forward',
        undefined,
        msaaActive ? 4 : 1,
        // feat-20260625-refactor-sprite-as-transparent-mesh R2 fix-up:
        // the split sub-pass PSO must use the same attachment format as the
        // encoder. Native linear-LDR frames resolve graph-owned `ldrColor`
        // (possibly rgba16float); swap-chain fallback frames resolve their raw
        // storage format. `transparentPassColorFormat` is the single owner for
        // this format so lazy PSO construction cannot fall back to the geometry
        // sRGB view.
        transparentPassColorFormat(c, pipelineState) as GPUTextureFormat,
      ) ?? null;
    const spritePH_withRegion =
      runtime.getMaterialShaderPipeline?.(
        'forgeax::sprite',
        spriteIsHdr,
        spritePremulBlend,
        'triangle-list',
        undefined,
        SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET,
        'forward',
        undefined,
        msaaActive ? 4 : 1,
        transparentPassColorFormat(c) as GPUTextureFormat,
      ) ?? null;

    // bug-20260629: spritePH===null check moved OUTSIDE the entity loop so the
    // sprite pass is properly ended before returning. Inside the loop the early
    // `return` left spritePass open → render-pass-not-ended error every frame
    // where the pipeline is still being compiled (frame 0 on first load).
    //
    // feat-city-glb Bug 5: a missing sprite PSO must NOT abort the whole
    // sub-pass — the generic per-submesh PBR transparent loop below does not
    // depend on the sprite shader. Only skip the sprite ENTITIES when spritePH
    // is null (fire the diagnostic once, iff a sprite entity is actually
    // present), then fall through to the PBR loop. A PBR-only transparent
    // scene (e.g. a glTF BLEND decal, no sprites) renders regardless of
    // whether sprite.wgsl is in the manifest.
    let spriteUnavailableReported = false;
    const reportSpriteUnavailable = (): void => {
      if (spriteUnavailableReported) return;
      spriteUnavailableReported = true;
      runtime.errorRegistry.fire(
        new RhiError({
          code: 'shader-compile-failed',
          expected:
            'manifest entries include sprite.wgsl + the engine triple (pbr + unlit + tonemap)',
          hint: 'verify @forgeax/engine-vite-plugin-shader emits manifest.json with the 4 engine entries (sprite.wgsl is required when spawning sprite materials); check vite plugin engineEntries option',
        }),
      );
    };

    // feat-20260624 M1' / t7: parallel sprite-lit PSO request — same
    // arg shape, only materialShaderId differs.
    const spriteLitPH =
      runtime.getMaterialShaderPipeline?.(
        'forgeax::sprite-lit',
        spriteIsHdr,
        spritePremulBlend,
        'triangle-list',
        undefined,
        // sprite-lit declares the same Standard capability axes as PBR. The
        // boot artifact is intentionally the direct compatibility variant,
        // so a clustered frame must request its explicit Cluster artifact;
        // otherwise the host binds the unified group(2) while the shader
        // still reads the now-cleared direct-light headers.
        standardTopologyVariantSet(c.standardLighting, runtime.device.caps.storageBuffer, false),
        'forward',
        undefined,
        msaaActive ? 4 : 1,
        transparentPassColorFormat(c) as GPUTextureFormat,
      ) ?? null;
    recordSpriteEntityDraws(
      c,
      spritePass,
      matchedIndices,
      resolveMaterialBindGroup,
      spritePH,
      spritePH_withRegion,
      spriteLitPH,
      reportSpriteUnavailable,
    );

    // Keep program, geometry, bindings and dynamic offsets on the common draw path.
    recordSpriteTransparentPbrDraws(
      c,
      spritePass,
      matchedIndices,
      materialSlotIndices,
      sampleCount,
      resolveMaterialBindGroup,
      meshGroup2,
      selectedDispatch,
    );

    if (graphPass === undefined) spritePass.end();
  }
  return geometryPassEnded;
}

/** Non-sprite transparent Passes use the same geometry and binding owner as opaque draws. */
function recordSpriteTransparentPbrDraws(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  matchedIndices: Set<number> | null,
  materialSlotIndices: readonly (readonly number[])[],
  sampleCount: number,
  resolveMaterialBindGroup: (
    slot: number,
    material: MaterialSnapshot,
    entityKey: number,
    world: RenderResourceScope,
    shader?: string,
  ) => BindGroup,
  meshGroup2: BindGroup | null,
  selectedDispatch?: readonly DispatchEntry[],
): void {
  const isSprite = (shader: string | undefined) =>
    shader === 'forgeax::sprite' || shader === 'forgeax::sprite-lit';
  const passes = selectedDispatch?.filter(
    (entry) =>
      entry.renderState?.blend !== undefined &&
      !isSprite(entry.materialShaderId) &&
      (matchedIndices === null || matchedIndices.has(entry.renderableIndex)),
  );
  const matched = new Map<number, Set<number>>();
  const add = (index: number, handle: number) => {
    let handles = matched.get(index);
    if (handles === undefined) {
      handles = new Set();
      matched.set(index, handles);
    }
    handles.add(handle);
  };
  if (passes !== undefined) {
    for (const entry of passes) add(entry.renderableIndex, entry.materialHandle);
  } else {
    for (const entry of c.validatedOrdered) {
      if (matchedIndices !== null && !matchedIndices.has(entry.renderableIndex)) continue;
      if (isSprite(entry.source.material.materialShaderId)) continue;
      for (const material of entry.source.materials) {
        if (material.transparent === true) add(entry.renderableIndex, material.materialHandle ?? 0);
      }
    }
  }
  recordGeometryDraws(
    {
      ...c,
      splitLdrSprite: false,
      transparentColorFormat: transparentPassColorFormat(c) as GPUTextureFormat,
    },
    pass,
    matched,
    materialSlotIndices,
    sampleCount,
    meshGroup2,
    c.meshBindGroup,
    resolveMaterialBindGroup,
    'forward',
    passes,
  );
}

/**
 * feat-20260704 M3/w19: per-entity sprite / sprite-lit draw loop for the LDR
 * blend sub-pass, extracted verbatim from the sprite split pass. Selects the
 * sprite vs sprite-lit PSO per entity, resolves the per-entity / fold-bucket
 * instance buffer (fold-instanced drawIndexed where a fold bucket applies and
 * the entity has no explicit Instances), uploads the per-entity sprite material
 * UBO slice, binds view / material / mesh / instances groups, and issues the
 * draw. Non-sprite transparent submeshes are drawn separately
 * (recordSpriteTransparentPbrDraws). The loop-invariant sprite PSO handles + the
 * once-per-frame sprite-unavailable diagnostic are threaded in.
 *
 * @internal
 */
function recordSpriteEntityDraws(
  c: _InternalRenderPipelineContext,
  spritePass: RhiRenderPassEncoder,
  matchedIndices: Set<number> | null,
  resolveMaterialBindGroup: (
    materialSlot: number,
    material: MaterialSnapshot,
    entityKey: number,
    materialWorld: RenderResourceScope,
  ) => BindGroup,
  spritePH: RenderPipeline | null,
  spritePH_withRegion: RenderPipeline | null,
  spriteLitPH: RenderPipeline | null,
  reportSpriteUnavailable: () => void,
): void {
  const {
    runtime,
    world,
    pipelineState,
    validatedOrdered,
    meshBindGroup,
    foldDispatchPlan,
    materialSlotIndices,
  } = c;
  const recordPresented = createFoldedDrawRecorder(c);
  let lastSpritePipelineHandle: RenderPipeline | null = null;
  let lastSpriteVertexBuffer: GpuBuffer | null = null;
  let lastSpriteIndexBuffer: GpuBuffer | null = null;
  for (let i = 0; i < validatedOrdered.length; i++) {
    const spriteEntry = validatedOrdered[i];
    // feat-20260625 M3 / w13: sub-pass entity filter migrated from
    // `shadingModel === 'sprite'` to `transparent === true` — the
    // shadingModel arm is gone post-feat (plan-strategy D-3).
    if (spriteEntry === undefined || spriteEntry.source.material.transparent !== true) continue;
    // feat-city-glb Bug 5 (per-submesh transparency): this loop is the
    // SPRITE path (whole-mesh sprite / sprite-lit PSO). Non-sprite
    // transparent materials (built-in PBR, incl. glTF alphaMode=BLEND) are
    // drawn per-submesh with their real shader in the dedicated PBR loop
    // below — so skip them here. Previously the 4.3-blending window (a PBR
    // material) was drawn through here with the sprite shader; it now flows
    // through the PBR loop, which is both correct and multi-submesh-capable.
    const entityShaderId = spriteEntry.source.material.materialShaderId;
    if (entityShaderId !== 'forgeax::sprite' && entityShaderId !== 'forgeax::sprite-lit') continue;
    const isSpriteLit = entityShaderId === 'forgeax::sprite-lit';
    // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4-record-swap
    // (D-1): fold-bucket non-head member — skip; the bucket head emits one
    // instanced drawIndexed covering all members.
    if (foldDispatchPlan?.skipIndices.has(i) === true) {
      continue;
    }
    const foldHeadBucket = foldDispatchPlan?.headBuckets.get(i);

    // feat-20260609 M2: skip entities that don't match the pass selector.
    if (matchedIndices !== null && !matchedIndices.has(spriteEntry.renderableIndex)) {
      continue;
    }

    // feat-20260624 M1' / t7: select sprite vs sprite-lit PSO per
    // entity. Both paths share the LDR sub-pass + the same UBO
    // layout; only the shader module + fragment math differ. PSO
    // cache strings are isolated by materialShaderId (D-11) so
    // routing here keeps the cache slots disjoint.
    //
    // bug-20260629: SpriteInstances entities additionally need the
    // PER_INSTANCE_REGION=true variant so the shader reads UV region
    // from the 80B-per-instance interleaved buffer rather than from
    // the material UBO. Only the base sprite path has the per-instance
    // region variant compiled; sprite-lit + non-instances entities
    // keep the PER_INSTANCE_REGION=false variant.
    const activeSpritePH = isSpriteLit
      ? spriteLitPH
      : spriteEntry.source.spriteInstances !== undefined
        ? spritePH_withRegion
        : spritePH;
    if (activeSpritePH === null) {
      // Variant not yet compiled — for PER_INSTANCE_REGION=true the
      // variant cache fill is async on first use (mirrors the
      // spritePH===null guard above); falling back to the non-region
      // variant would render black quads (region read returns 0).
      // For sprite-lit the manifest may lack sprite-lit.wgsl; either
      // way fail-safe-skip is the closest the renderer can get to
      // "show nothing visibly wrong" without ending the sprite pass
      // (which would drop remaining sprite entities for the frame).
      if (!isSpriteLit) {
        reportSpriteUnavailable();
      } else {
        runtime.errorRegistry.fire(
          new RhiError({
            code: 'shader-compile-failed',
            expected:
              'manifest entries include sprite.wgsl + sprite-lit.wgsl (when sprite-lit materials are used) + the engine triple (pbr + unlit + tonemap)',
            hint: 'verify @forgeax/engine-vite-plugin-shader emits manifest.json with sprite.wgsl AND sprite-lit.wgsl entries; check vite plugin engineEntries option',
          }),
        );
      }
      continue;
    }
    if (lastSpritePipelineHandle !== activeSpritePH) {
      spritePass.setPipeline(activeSpritePH);
      lastSpritePipelineHandle = activeSpritePH;
    }

    if (spriteEntry.mesh.vertexBuffer !== lastSpriteVertexBuffer) {
      spritePass.setVertexBuffer(0, spriteEntry.mesh.vertexBuffer.handle);
      lastSpriteVertexBuffer = spriteEntry.mesh.vertexBuffer;
    }
    const indexBuffer = spriteEntry.mesh.indexBuffer;
    if (indexBuffer !== null && indexBuffer !== lastSpriteIndexBuffer) {
      spritePass.setIndexBuffer(indexBuffer.handle, spriteEntry.mesh.indexFormat);
      lastSpriteIndexBuffer = indexBuffer;
    }

    // Instance buffer resolution: sprites with Instances (e.g.
    // hello-sprite-atlas 100-instance walk-cycle) require a per-entity
    // buffer upload through the same sprite-path owner as SpriteInstances
    // (uploadSpriteInstanceBuffer: cap-gate → cache-lookup → createBuffer →
    // writeBuffer).
    //
    // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4-record-swap
    // (D-1): when `foldHeadBucket !== undefined` AND the sprite entity has
    // no explicit Instances component, assemble the bucket transforms into
    // a transient instance buffer + override `spriteInstanceCount =
    // bucket.bucketSize`. The mesh slot at `i*MESH_PER_ENTITY_STRIDE` was
    // already overwritten to identity in the mesh SSBO upload loop above,
    // so the shader computes `world = identity * bucket.transforms[idx] *
    // pos`, per-instance correct. Entities with explicit Instances bypass
    // fold (their per-entity Instances semantic wins); bucket key forces
    // such an entity to be a singleton bucket in practice because its
    // material is distinct or unfolded, but defensively check here as a
    // belt-and-suspenders guard.
    let spriteInstanceBuffer: Buffer = pipelineState.identityInstanceBuffer;
    let spriteInstanceCount = 1;
    const spriteInst = spriteEntry.source.instances;
    if (foldHeadBucket !== undefined && spriteInst === undefined) {
      const buffer = resolveFoldInstanceBuffer(c, foldHeadBucket, i);
      if (buffer === null) continue;
      spriteInstanceBuffer = buffer;
      spriteInstanceCount = foldHeadBucket.bucketSize;
    } else if (spriteInst !== undefined) {
      const uniformFallback = runtime.device.caps.storageBuffer === false;
      let spriteBufUsage = GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST;

      if (uniformFallback) {
        if (spriteInst.instanceCount > MAX_UNIFORM_INSTANCES) {
          runtime.errorRegistry.fire(
            new RhiError({
              code: 'limit-exceeded',
              expected: `instance count <= ${MAX_UNIFORM_INSTANCES} (uniform fallback cap)`,
              hint: `reduce instance count to ${MAX_UNIFORM_INSTANCES} or use a WebGPU-capable backend`,
              detail: {
                maxStorageBufferBindingSize: MAX_UNIFORM_INSTANCES * 64,
                requestedBytes: spriteInst.instanceCount * 64,
              },
            }),
          );
          spriteInstanceCount = spriteInst.instanceCount;
          spriteInstanceBuffer = pipelineState.identityInstanceBuffer;
          // Sprite shaders do not declare the Standard PBR Probe ABI. A
          // retained scene record must therefore not change their group(3)
          // bind-group shape.
          const spriteInstBg = resolveGeometryInstancesBindGroup(
            c,
            spriteInstanceBuffer,
            undefined,
          );
          spritePass.setBindGroup(3, spriteInstBg);
          spritePass.drawIndexed(spriteEntry.mesh.indexCount, spriteInstanceCount, 0, 0, 0);
          c.onRenderableDraw?.(spriteEntry, 0);
          continue;
        }
        spriteBufUsage = GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST;
      }

      const instancePayload = uniformFallback
        ? spriteInst.transforms
        : packInstanceStorageBuffer(
            spriteInst.transforms,
            spriteEntry.source.temporal?.previousInstances?.transforms,
            spriteInst.generations,
            spriteEntry.source.temporal?.previousInstances?.generations,
          );
      const uploaded = uploadSpriteInstanceBuffer(
        c,
        spriteEntry.source.worldId,
        spriteInst,
        instancePayload,
        spriteBufUsage,
        'reduce the sprite batch to fit within device.limits.maxStorageBufferBindingSize or use a storage-capable backend',
      );
      if (uploaded !== null) {
        spriteInstanceBuffer = uploaded;
        spriteInstanceCount = Math.max(1, spriteInst.instanceCount);
      }
    }

    // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch
    // M3 / w11: SpriteInstances 80B-per-instance interleaved upload path.
    // SSOT for the per-entity 2D mat4 + per-instance UV region buffer
    // (plan-strategy D-1 interleaved single buffer + single binding slot;
    // D-9 cacheKey = entity packed u32). The extract-stage validator
    // (M3 / w10) enforces the XOR contract `Instances XOR SpriteInstances`
    // (sprite-instances-mutually-exclusive-with-instances), so the
    // legacy `spriteInst` block above and this block are never both
    // active for the same entity.
    const _si = resolveSpriteInstancesBuffer(
      c,
      spriteEntry,
      spriteInstanceBuffer,
      spriteInstanceCount,
    );
    spriteInstanceBuffer = _si.buffer;
    spriteInstanceCount = _si.count;

    // sprite-lit's clustered variant declares the unified Standard group(2)
    // contract, while the regular sprite variants keep the direct mesh
    // contract. Select the resource from the same capability axis used to
    // request the pipeline; binding the ordinary mesh group to the clustered
    // sprite-lit pipeline is rejected by WebGPU before the draw is recorded.
    const spriteGroup2 =
      isSpriteLit && c.standardLighting?.kind === 'clustered'
        ? clusteredMeshSlotBindGroup(c, i * MESH_PER_ENTITY_STRIDE)
        : pipelineState.meshStorageBuffer.pages === undefined
          ? meshBindGroup
          : meshSlotBindGroup(
              runtime.device,
              c.frameState,
              pipelineState,
              c.bindGroupCounts,
              i * MESH_PER_ENTITY_STRIDE,
            );

    // M3 / w12: LDR sprite split pass per-entity instances BG cache. Sprite
    // shaders do not declare the Standard PBR Probe ABI, so retained probe
    // records stay out of this bind-group path.
    const spriteInstancesBg = resolveGeometryInstancesBindGroup(c, spriteInstanceBuffer, undefined);

    spritePass.setBindGroup(2, spriteGroup2 as BindGroup, [
      meshSsboBufferBinding(pipelineState.meshStorageBuffer, i * MESH_PER_ENTITY_STRIDE).byteOffset,
    ]);

    const materialSlot = materialSlotIndices[i]?.[0] ?? 0;

    // The same material owner serves HDR and linear-LDR draws. Do not
    // replace authored samplers, texture sources or cooked layouts here.
    const spritePassBg = resolveMaterialBindGroup(
      materialSlot,
      spriteEntry.source.material,
      spriteEntry.source.entityKey,
      spriteEntry.world ?? world,
    );

    spritePass.setBindGroup(1, spritePassBg, [
      meshSsboBufferBinding(
        pipelineState.materialUniformBuffer,
        materialSlot * MATERIAL_PER_ENTITY_STRIDE,
      ).byteOffset,
    ]);
    spritePass.setBindGroup(3, spriteInstancesBg);
    spritePass.drawIndexed(spriteEntry.mesh.indexCount, spriteInstanceCount, 0, 0, 0);
    recordPresented(
      spriteEntry,
      0,
      undefined,
      spriteInst === undefined ? foldHeadBucket : undefined,
    );
  }
}

function transparentPassColorFormat(
  c: _InternalRenderPipelineContext,
  pipelineState: _InternalRenderPipelineContext['pipelineState'] = c.pipelineState,
): string {
  if (c.transparentColorFormat !== undefined) return c.transparentColorFormat;
  if (!c.runtime.device.caps.storageBuffer) return pipelineState.colorAttachmentFormat;
  return pipelineState.format;
}
