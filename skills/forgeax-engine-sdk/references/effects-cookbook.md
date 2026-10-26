# Effects cookbook index (`empty` project)

Open ONLY the topic file you need; each is a self-contained recipe with compile-checked code.
Do not read the others. Game design is out of scope. Pack and `play.ts` wiring:
[content-pack.md](content-pack.md); character, input and cameras: [gameplay-tools.md](gameplay-tools.md).

| Request | Open (`references/effects/`) | Solves |
|:--|:--|:--|
| Sky, sun/moon, daylight/dusk/night/overcast, desk lamp, shadows | `lighting.md` | `spawnLighting` presets, `GradientSky`, spot shadow |
| Lamp, torch, window, neon; emissive on/off | `runtime-light-emissive.md` | Runtime point light, emissive swap, glow budget |
| Hit sparks, impact burst (GPU) | `vfx-burst.md` | Cooked one-shot VFX burst |
| Fog beam, lighthouse, god ray, light pillar | `beam-pillar.md` | Rotating spot + additive beam, tapered pillars |
| Sea, lake, river | stock `model: 'single-layer-medium'` (`three-equivalents.md`) | Sun glint, sky reflection, fog |
| Custom animated surface, per-frame uniform | `water-shader.md` | Surface WGSL with `frameTime` |
| Enemy fade, hit flash, tint, opacity | `entity-tint.md` | Per-entity tint and opacity |
| Rain, snow | `particles-rain-snow.md` | CPU point/line fields (needs `particles-core.md`) |
| Sparks, embers, glow halo | `particles-sparks.md` | Glow sprites, brightness budget (needs core) |
| Fire, smoke, brazier | `particles-fire-smoke.md` | Additive fire plus haze smoke (needs core) |
| Magic motes, bubbles, dust, sandstorm | `particles-magic-dust.md` | Spiral, rising, drifting fields (needs core) |
| Particle engine (`emit`, streams) | `particles-core.md` | Shared by all `particles-*` files |
| Vases, gears, tubes, lathe/extrude/sweep | `procedural-props.md` | Pack-time procedural meshes |
| Growing stem, debris, deforming mesh | `generated-meshes.md` | Meshes created and rewritten during play |

Each `install*` function registers its systems and returns or yields its inverse; the plugin's
`ctx.effect` generator runs those on disposal and hot reload. The `file=` blocks compile against
`templates/empty` in `pnpm test:sdk:contracts`; use the same `@forgeax/engine/<dir>` imports.
