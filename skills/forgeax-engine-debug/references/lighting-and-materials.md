# Lighting and material troubleshooting

Use this reference for skybox, shadow, ambient-lighting, and glTF material symptoms.

## Skybox V-flip

**Signal**: cubemap output is upside down, with reflected mountains at the zenith and ground texture below.

**Cause**: redundant fragment-stage V-flip (ndcY = -ndcY), often copied from OpenGL skybox sampling. The correct path computes view direction directly from UV without the flip.

**Check**:
```bash
# Inspect skybox.wgsl for redundant -ndcY or -1 * uv.y * 2.
grep -n "ndcY\|uv.y\" packages/shader/src/builtin/skybox.wgsl
```

**Repair**: use the current skybox.wgsl; custom WGSL cubemap sampling must not retain the old OpenGL V-flip.

---

## CSM shadows fully lit

**Signal**: standard PBR meshes have ShadowCaster passes and normal diffuse lighting, but shadowFactor is always 1.0 even beneath occluders. perFramePassNames includes shadowCascade0-3 and the light-space matrix is valid.

**Cause**: cascade selection compares negative viewZ=-clipPos.w against positive pssmSplit depths. The negative convention is intentional for cluster Z slicing. Comparing it directly in _pickCascadeLayer/cascadeBlend selects near cascade 0 for every visible fragment; distant projections leave its tile, and the NaN-safe out-of-bounds guard returns 1.0.

**Check**:
```bash
# Check whether cascade selection compares signed viewZ directly to splitPlanes.
grep -n "viewZ\|viewDepth\|splitPlanes" packages/shader/src/lighting-directional.wgsl
# Confirm the vertex shader emits -clipPos.w; preserve that convention.
grep -n "out.viewZ" packages/shader/src/default-standard-pbr*.wgsl
```
Tests must feed production's negative viewZ. An embedded test kernel using positive viewZ can duplicate the faulty assumption and remain green.

**Repair**: convert once at the consumer to viewDepth=-viewZ; use positive depth for cascade selection and blend bands while preserving the vertex/cluster convention. Shader authority: packages/shader/src/lighting-directional.wgsl; split computation: render-system-extract.ts pssmSplit.

---

## Missing directional shadows: castShadow and ShadowCaster

**Signal**: DirectionalLight castShadow is true/default, cascade passes run, but some or all meshes cast no shadow.

**Candidate causes**:

| Priority | Cause | Check | Repair |
|:--|:--|:--|:--|
| R1 | castShadow was explicitly disabled. | world.get(lightEntity, DirectionalLight).unwrap().castShadow === false | Remove the override or set true. Shadow fields live on DirectionalLight; no second component is required. |
| R2 | The entity opted out with ShadowParticipation. | world.get(entity, ShadowParticipation) reports cast === false | Set cast: true or remove the component; it is the only per-entity casting switch. |
| R3 | Material lacks ShadowCaster; depth filtering selects shadow-caster passes. Standard factories add it, but hand-authored forward/deferred-only materials do not. | No material.passes entry with passKind shadow-caster. | Add { name: 'ShadowCaster', shader: 'forgeax::default-standard-pbr' } or use Materials.standard. See the material skill. |

castShadow controls whether the light populates the atlas; material ShadowCaster controls whether that mesh enters it. Both are required. The light default is true, so missing material passes are a common hand-authoring failure.

Do not hide this by switching demo meshes to unlit; material passes are the repair authority.

**Related**:
- If the entire scene is unshadowed, check [CSM depth signs](#csm-shadows-fully-lit).
- Material factories: [`forgeax-engine-material`](../../forgeax-engine-material/SKILL.md).

---

## Ambient black until IBL loads

**Signal**: a standard scene with only DirectionalLight stays black for seconds at cold start or remains dark where float IBL textures are unavailable, such as desktop WKWebView.

**Cause**: Skylight historically required asynchronous equirect-to-cube, irradiance convolution, prefilter, and BRDF LUT generation. Before readiness its zero fallback produced ambient=0; no constant ambient term existed.

**Check**:
```bash
# Check whether PBR ambient derives exclusively from IBL.
grep -n "ambient" packages/shader/src/default-standard-pbr.wgsl
# Check whether Skylight permits a solid-color mode without equirect.
grep -n "equirect\|color\|intensity" packages/runtime/src/components/skylight.ts
```

**Repair**: the Engine supports Skylight without equirect for immediate solid ambient. Spawn it with data:{} for white or color/intensity overrides. The Engine uses a white 1x1 fallback, giving ambient=kD·albedo·color·intensity immediately; supplying equirect upgrades to full IBL. Do not add a permanent demo PointLight workaround. Owners: runtime/components/skylight.ts and runtime/ibl/skylight-bind-group.ts; see the material skill.

---

## glTF bridge mixes mesh materials

**Signal**: nodes in a multi-mesh glTF bind the union of all mesh materials instead of their own slots, causing wrong materials or black output; single-mesh files hide the issue.

**Cause**: bridge.ts B1 traversed the flattened (mesh, primitive) list without filtering by node mesh index. Verification at 42c3335e found and repaired this.

**Check**:
```bash
# Check bridge.ts B1 for meshIndex filtering.
grep -n "meshIndex" packages/gltf/src/bridge.ts
# Assigning meshIr.meshIndex without a corresponding filter is insufficient.
```

**Repair**: use a revision after 42c3335e. MeshIr.meshIndex identifies the source glTF mesh; B1 filters meshIr.meshIndex === ir.meshIndex so nodes receive only their own materials.

---
