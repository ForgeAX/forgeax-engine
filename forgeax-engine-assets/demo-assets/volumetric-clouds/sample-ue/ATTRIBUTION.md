# UE Cloud Texture Inputs

Migrated unchanged from `forgeax-engine/apps/vc-ue5/assets/clouds/sample-ue/`
on 2026-11-13. `assets/texture-definitions.ts` preserves each original UE object
path, source asset SHA-256 and converted payload SHA-256. The recorded UE source
revision is `f45729c0b6f097038e72b52d366a62baeca3275b` (5.8.4).

| Texture | Runtime Shape | Format | Bytes |
|:--|:--|:--|--:|
| T_CloudPattern | 1024 x 1024 | rgba16float | 8388608 |
| T_CloudMask | 1024 x 1024 | rgba8unorm | 4194304 |
| T_Profile_08 | 256 x 256 | rgba16float | 524288 |
| VT_PerlinWorley_Balanced | 128 x 128 x 128 | rgba16float | 16777216 |

All inputs are linear and contain LOD0 only. Pattern was converted from RGBA32F
to binary16; Mask was clamped and quantized from RGBA32F to UNORM8. Profile and
volume preserve their original binary16 source pixels. These are data inputs,
not procedurally generated substitutes. No `.uasset`, original float backup,
native material graph or platform-cooked UE texture is included.

The material adapter uses the existing ForgeAX cloud density kernel and lighting.
It preserves the demo's parameter labels, defaults and texture bindings; it does
not claim to reproduce the complete UE material graph, BC6H compression, Blur1
mip chain or pixel parity. The original demo's source backups and evidence are
not runtime dependencies of this package.
