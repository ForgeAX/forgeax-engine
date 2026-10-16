# Asset, project, and CI troubleshooting

Use the symptom table in `../SKILL.md` to select one recipe. Verify the signal before changing the owning package.

## White textures

**Signal**: a textured demo renders a uniform white square without detail or lighting gradients; material registration succeeds.

**Cause**: raw pack paramValues contain GUID strings in baseColorTexture/metallicRoughnessTexture. Extraction binds only resolved numeric Handles; strings select the white placeholder.

**Check**: inspect the extraction type guard.
```bash
grep -n "typeof pv.baseColorTexture === 'number'" packages/runtime/src/render-system-extract.ts
```

**Repair**: replace texture GUIDs with loadByGuid<TextureAsset> result handles. On load failure, omit the slot so normal fallback applies rather than passing a string.

```ts
for (const [k, v] of Object.entries(paramValuesIn)) {
  if (k === 'baseColorTexture') {
    if (!diffuseRes.ok) continue;       // drop slot -> 1x1 placeholder
    filteredValues[k] = diffuseRes.value; // resolved numeric Handle
    continue;
  }
  // Apply the same resolution to metallicRoughnessTexture.
  filteredValues[k] = v;
}
```

> [!CAUTION]
> Handle<T> is a branded number (packages/types/src/handle.ts). Pack JSON stores GUID strings, requiring loadByGuid resolution before runtime use. Extraction does not resolve strings.

---

## Misspelled spawn data fields

**Signal**: world.spawn(...).unwrap() or commands.spawn throws spawn-data-unknown-field. Before bug-20260615, the same typo was silently dropped, leaving invisible/gray entities.

**Cause**: fillComponentDefaults iterated schema keys rather than checking raw input keys. A stale singular MeshRenderer.material field was ignored after migration to materials arrays, leaving extraction to use the gray defaultMaterialSnapshot.

**Check**: compare data fields against error.detail.knownFields.
```bash
# Inspect schema fields.
grep -n "defineComponent('<ComponentName>'" packages/runtime/src/components/*.ts
```

**Repair**: use schema names and migrate all spawn sites together after renames. Commands.spawn throws from the system body, identifying the call site in its stack.

Applies to World spawn/addComponent, SceneAsset.instantiate including Pack scene components, and Commands spawn/addComponent. The pure fillComponentDefaults helper does not validate; spawn boundaries do.

---

## Stale shader identifiers

**Signal**: material registration reports asset-invalid-value because a pass references an unregistered shader; fallback can appear black/white.

**Cause**: a built-in shader rename, such as default-pbr-forward to default-standard-pbr, left hand-authored passes[].shader constants in demo packs. Demos hardcoding the correct identifier may hide stale packs.

**Check**: compare references with registered identifiers.
```bash
# Locate material shader registration.
grep -rn "reservedIdentifier:" packages/vite-plugin-shader/src/index.ts
# Locate remaining references to an old identifier.
rg -l 'forgeax::<old-name>' apps/ packages/ -g '!node_modules/**' -g '!dist/**'
```

**Repair**: migrate all pack.json identifiers, including currently unused ones, then verify no stale references remain.

---

## Passing assertions with exit 1

**Signal**: CI fails although Test Files/Tests all pass; the tail reports Vitest unhandled errors/rejections.

**Cause**: an uncaught teardown Promise rejection. One example was createShaderModule awaiting getCompilationInfo while the GPU device was destroyed, producing OperationError: Instance dropped on headless SwiftShader.

> [!IMPORTANT]
> Check exit status, not only passing-test counts. Local Chrome Beta may not reproduce the headless teardown race; local assertion success alone is insufficient.

**Check**:
```bash
CI=1 pnpm test:browser; echo "EXIT: $?"          # Inspect the actual exit status.
grep -aE "Unhandled|Instance dropped|OperationError" <log>  # Locate the escaped rejection.
```

**Repair**: catch teardown-sensitive awaits at the Engine owner and follow the existing graceful-degradation path. Add a regression that forces the Promise rejection and checks the outer operation resolves; confirm it fails without the fix before finalizing.

```ts
let info: GPUCompilationInfo;
try {
  info = await handleWithInfo.getCompilationInfo();
} catch {
  return ok(handle as unknown as ShaderModule); // instance dropped mid-await
}
```

---

## Fresh-worktree environment failures

**Signal**: a new worktree fails while the primary checkout works:
- ENOENT for a forgeax-engine-assets fixture.
- Failed package entry resolution for an unbuilt package.

**Cause**: a clean worktree lacks initialized submodules or generated dist outputs.

**Check and repair**:
```bash
git submodule status forgeax-engine-assets   # Leading '-' means uninitialized.
git submodule update --init forgeax-engine-assets
pnpm install && pnpm build                    # Generate .mjs and declarations.
```

> [!TIP]
> Compare failing ownership with git diff --name-only main...HEAD. Missing changes to that package suggest environment/build/cache causes; repair those before assigning blame.

---

## skin browser producer positive probe

**Signal**: hello-skin Dawn smoke passes but browser development reports
asset-not-imported or fails to receive the scene Pack.

**Check**: run pnpm -F @forgeax/hello-skin smoke:browser; require
importProbeHits >= 3 and scene in kindUnion. This probes whether the configured
pluginPack producer actually prepares the scene GUID. Clearing roots or removing
the sidecar must fail. Dawn directly calls
gltfDocToSceneAsset -> register(handle), bypassing development producer/package fetch,
so it cannot replace this browser gate.

---

## vite-plugin-pack DDC hot reload

**Signal**: browser refresh after pnpm dev loses textures, or untracked .bin files appear beside sources.

**Historical causes**:

| Issue | Commit | Effect |
|:--|:--|:--|
| sourcePath overwritten | 5b032fd0 | Cooked rows used .bin paths, losing original texture paths on warm refresh. |
| .bin written beside sources | 48ba705b | DDC wrote sourcePath.GUID.bin into the asset submodule, roughly 70 files/317 MB per dev run. |
| Inconsistent naming | e42b1541 | Renamed bin cache to DDC and centralized node_modules/.cache/forgeax-ddc/. |

**Check**:
```bash
# Sources should not have co-located .bin files.
find packages/ apps/ -name "*.bin" -not -path "*/node_modules/*" -not -path "*/dist/*"
# DDC belongs under node_modules/.cache/forgeax-ddc/.
ls node_modules/.cache/forgeax-ddc/
```

**Repair**: use the current producer, which preserves original sourcePath on warm refresh. Inspect and clear stale DDC artifacts before restarting pnpm dev.

---

## Windows compatibility

**Signal**: Windows-only value/path/grep failures while macOS/Linux pass.

**Causes**:
- CRLF conversion through core.autocrlf caused full-file formatter diffs; 449515d6 enforced * text=auto eol=lf.
- Unix-oriented path matching mishandled Windows separators; 3da96cbb repaired tests and grep/glob/path handling.
- Some scripts assumed no spaces or consistent drive-letter casing.

**Check**:
```bash
# Verify LF policy after clone.
git config core.autocrlf          # Expected false or unset.
file <source.ts>                   # ASCII/UTF-8 without CRLF.
# Reproduce tests on Windows.
pnpm test:unit 2>&1 | grep -E "FAIL|≠|no such file"
```

**Repair**:
1. Ensure .gitattributes declares * text=auto eol=lf.
2. In a fresh Windows worktree, set git config core.autocrlf false before restoring tracked files; preserve local edits first.
3. Use a revision containing 3da96cbb for known path fixes.

---
