# Materials, textures and delivery mips

Part of the [`@forgeax/engine/modeling` reference](../README.md).

## Procedural materials, textures and text

**Slot naming convention.** A mesh slot name, the model material name and the Pack output key
agree: `assign(faces, 'paint')` makes the mesh slot `paint`, and the Pack emits
`'material/paint': Materials.standard({...})`. The slot name is the only join key (slot
indexes are not stable, because `finish` keeps used slots only). Texture references inside a
material are GUID strings from `AssetGuid.format(AssetGuid.derive(packageId, 'texture/<key>'))`
with the texture emitted as `'texture/<key>'`. A slot with no `material/<slot>` output keeps the
renderer's palette color; a `material/*` output with no slot is ignored, so one Pack can serve
several meshes. `highlight` and `xray` are render-owned slot names; do not use them.
`runCapture` (and so `model.render`) returns the build's own outputs in the optional report field
`materials` for `render` and `replay` captures: `{ materials: { [slotName]: MaterialAsset },
textures: { [guid]: TextureAsset } }`, taken from the same build as the captured mesh and absent when
the build has no `material/*` output.

Surfaces get their finish without image files. `proceduralMaterials` returns options for
the Engine's `Materials.standard`; every texture it needs is generated in TypeScript and
handed to a `texture(key, asset)` sink, which stores it (a Pack output, a runtime asset)
and returns its reference:

| Recipe | Look | Generated textures |
|:--|:--|:--|
| `carPaint({ color, metallic?, roughness?, flake?, clearcoatRoughness? })` | metallic base with flake normals under a clear coat | flake normal map (uv0, 5 cm tile) |
| `carbonFiber({ tow?, weave?: 'twill' \| 'plain' })` | woven tows with alternating anisotropic highlights, lacquered | albedo, normal, anisotropy direction |
| `metal({ finish: 'chrome' \| 'brushed' \| 'satin', direction? })` | mirror chrome, anisotropic brushed or satin metal | streak or grain normal map (brushed, satin) |
| `glass({ tint?, ior?, roughness?, thickness? })` | transmission with attenuation | none |
| `tire({ pattern?: 'chevron' \| 'blocks' \| 'ribs', pitch? })` | near-black rubber with a tread | tread normal map, roughness |
| `emissive({ color, intensity?, segments? })` | glowing strip, optionally LED segments | segment mask |
| `decal(base, { width, height, background, layers, texture, key })` | `base` with a decal sheet as its base color on uv1 | the sheet |

Recipes enable the Standard optional layers they use through `staticSwitches`
(clearcoat, anisotropy); a material with `staticSwitches` renders only from a cooked Pack, and
runtime `assets.create` of one fails `material-specialization-not-cooked`. `placement` puts tiling textures on a coordinate set (uv0 meters
by default) with a tile size and rotation. The texture toolkit underneath is public:
`textureFrom(width, height, texel, { colorSpace })` (sRGB encoded exactly, with a
mip chain packed mip-major by `mipChain`, below), `hash2`, `valueNoise` and `fractalNoise`
(tileable, integer-hashed), `normalTexture` and `normalFromHeight` (each mip level
renormalized), `coverage` (anti-aliased region raster), `decalTexture` (regions
composited over a background into an sRGB sheet) and `studioEnvironment` (a procedural
rgba16float studio equirect for image-based lighting, so metals and clear coats have
something to reflect).

`textStrokes(text, { height, tracking?, slant?, align? })` lays text out in a built-in
single-stroke engineering font (capitals, digits and `- . / + : #`; others are
`model-invalid-argument` with the character), and `textRegion` strokes it into filled
outlines through `region2d.stroke`. A text region becomes a decal sheet layer, or a
geometric decal through `m.surface` imprints after `region2d.transform` places it in a
patch's normalized domain.

## Delivery mips and KTX2 encoding

Every packed TextureAsset mip chain (`textureFrom`, `normalTexture`, `normalFromHeight`,
`decalTexture`, `bakeMaps`, including its 16-bit `r16unorm` height) and every block-compressed delivery comes from one filter.
`mipChain(texture, { layout, roughnessFromNormal?, alphaCutoff? })` takes an unencoded rgba8
level 0 (size divisible by 4) and returns tight RGBA8 levels with the layout's policy:

| `layout` | Channels | Filter (policy) |
|:--|:--|:--|
| `normal` | X in R, Y in G (`channels: 'rg'`; B keeps Z for previews) | mean of the level-0 unit normals, renormalized per level (`normal-rg-renorm/1`) |
| `ormh` | R occlusion, G roughness, B metalness, A height (glTF order, linear) | box (`ormh-box/1`); with `roughnessFromNormal` (same size) each level's roughness is widened by the variance its normal mean lost, Toksvig (`ormh-box-toksvig/2`) |
| `color` | RGBA in the texture's color space | box in linear light (`color-box-linear/1`) |
| `mask` | RGBA, alpha an alpha-tested cutout | box, then each level's alpha is scaled so the fraction at or above `alphaCutoff` (default 0.5) matches level 0 (`mask-coverage/1`) |

Toksvig: with alpha = r^2 and s = 2 / alpha^2 - 2, a mean normal of length `len` gives
s' = s len / (len + s (1 - len)) and r' = (2 / (s' + 2))^(1/4); level 0 never changes.

`encodeKtx2(texture, { layout, rdo?, roughnessFromNormal?, alphaCutoff?, sourceKey? })` (`./tools`, Node
only) encodes those levels as they are with Basis UASTC (pack level 2, zstd) through the
Engine's `basisEncode({ levels })`. Normal maps are UASTC luminance-alpha with an `RRRG`
DFD: Basis transcodes BC5 / EAC RG11 from R and A, so the Renderer samples them as BC5
(or EAC RG11 / RG8); the other layouts transcode to BC7 / ASTC / ETC2. The result is an
ordinary encoded TextureAsset (`encoding: 'ktx2'`, packed level count) with two DDC keys:
`keys.source`, the bake job's cache key passed as `sourceKey` (default the SHA-256 of the
source bytes), and `keys.encode` over it, the layout policy, the output color space and
extent, a `mask` layout's `alphaCutoff` (passed to `mipChain`), the Basis parameters
(including `rdo`) and the encoder WASM digest. Changing only `rdo` keeps the source key
and misses the encode key. Errors are `model-invalid-argument` (not an unencoded 2d
rgba8 texture, size not divisible by 4, `rdo` outside [0.001, 10], `roughnessFromNormal`
on another layout or size, `alphaCutoff` outside (0, 1) or on another layout) and
`model-capability-unavailable` when the encoder cannot load.

Measured gates (`ktx2-delivery.integration.test.ts`, a baked-panel normal map, BC5 decoded
with the reference block decoder in `./tools`): angular error against the rgba8 chain over
every level p95 < 1.5 deg, p99 < 6 deg. The same chain as three-channel UASTC (BC7) has a
higher p95, and delivering the normals as sRGB color exceeds p95 3 deg (falsifiers). The
UASTC 4x4 endpoint model, not BC5, limits the tail: feature rims inside one block keep a
p99 near 5 deg at any pack level, above an inferred 3 deg. Toksvig: on an alternating
+-25 deg stripe the encoded mip 4 roughness is within 0.05 of the closed form, and the
prefiltered GGX error against the supersampled reference is under half of the error
without it. A wire mesh keeps its alpha-test coverage at mip 4 within 5% (the box chain
loses it).
