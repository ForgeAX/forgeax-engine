LearnOpenGL section 2.4 (Lighting Maps) — demonstrates diffuse and specular texture maps applied to a StandardMaterialAsset cube with a single PointLight (co-located on a small unlit lamp cube at LO's canonical `lightPos = (1.2, 1.0, 2.0)`) and first-person camera. LO 4.x's fragment shader uses `normalize(light.position - FragPos)` per fragment, which is point-light behavior; forgeax mirrors that with `PointLight` whose world-space position comes from the lamp's companion `Transform`. Maps LO `material.diffuse` texture slot to `baseColorTexture` and LO `material.specular` to `metallicRoughnessTexture` (physically-based reinterpretation of the Blinn-Phong specular map as a roughness/metallic channel). Note: forgeax's PBR point light always applies 1/d^2 attenuation while LO 4.x does not, so the cube renders darker than the LO reference at the same lamp distance — physically correct, not a rendering bug.

## RHI-debug semantic smoke

```sh
pnpm --filter "@forgeax/app-learn-render-2-lighting-4-lighting-maps" smoke:rhi-debug
FALSIFY_NO_LIGHT=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-4-lighting-maps" smoke:rhi-debug
FALSIFY_NO_SPECULAR_MAP=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-4-lighting-maps" smoke:rhi-debug
pnpm --filter "@forgeax/app-learn-render-2-lighting-4-lighting-maps" smoke:browser
FALSIFY_NO_SPECULAR_MAP=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-4-lighting-maps" smoke:browser
FALSIFY_NO_LIGHT=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-4-lighting-maps" smoke:browser
```

The Dawn oracle uses the same Standard PBR material and diffuse/specular texture handles as the
producer scene, then requires warm non-clear cube samples with a brighter lit-cube interior. The
`FALSIFY_NO_LIGHT=1` control keeps the lamp mesh and texture inputs but removes only its PointLight;
the standard material must render black and reject the same witness. Browser smoke captures the
real `__captureLightingMaps` frame, replays it on a fresh device, and compares pixel output.
The `FALSIFY_NO_SPECULAR_MAP=1` control keeps the diffuse map and point light but removes only the
`metallicRoughnessTexture` specular-map slot; the Dawn response must rise to the no-map profile and
reject the specular-map response witness.
The same environment flag on Browser navigation adds `?rhi-debug-no-specular-map=1`; the captured
material group must retain the diffuse binding while no longer carrying the specular view at binding 4.
`FALSIFY_NO_LIGHT=1` adds `?rhi-debug-no-light=1`, keeps the lamp mesh and texture bindings, omits
only the production PointLight, and requires the live lit-cube center to be dark while the captured
Standard PBR draw still replays successfully.
