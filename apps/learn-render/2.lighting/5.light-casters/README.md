# Light Casters (LearnOpenGL §2.5)

LearnOpenGL section 2.5 (Light Casters) — demonstrates directional, point, and spot light types in a single combined scene. 10 container2-textured cubes (diffuse + specular maps, same vendor PNGs as §2.4 lighting-maps) at LO `cubePositions[]` are lit by 1 DirectionalLight + 4 PointLight (at LO `pointLightPositions[]`) + 1 camera-attached SpotLight (flashlight effect). First-person camera with WASD + mouse look + scroll-wheel FoV zoom. Combined demo covers LO 5.1 directional, 5.2 point, and 5.3/5.4 spot/spot_soft (inner=12.5° / outer=17.5° outerCone gives the soft-edge falloff of 5.4) in one scene.

## RHI-debug semantic smoke

```sh
pnpm --filter "@forgeax/app-learn-render-2-lighting-5-light-casters" smoke:rhi-debug
FALSIFY=no-directional-point-lights pnpm --filter "@forgeax/app-learn-render-2-lighting-5-light-casters" smoke:rhi-debug
FALSIFY=no-shadow pnpm --filter "@forgeax/app-learn-render-2-lighting-5-light-casters" smoke:rhi-debug
pnpm --filter "@forgeax/app-learn-render-2-lighting-5-light-casters" smoke:browser
```

The Dawn smoke retains the spot-shadow delta as its load-bearing assertion and adds a
`combined-directional-point-spot` witness at a floor site outside the fixed spot's bright patch.
The `no-directional-point-lights` falsifier omits only the producer's DirectionalLight and four
PointLights; the fixed SpotLight and shadow scene remain, so the combined-light brightness witness
must reject. `no-shadow` remains the existing shadow-specific falsifier. Browser capture uses the
real `__captureLightCasters` hook and the documented penumbra replay epsilon.
