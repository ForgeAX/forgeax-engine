# Three.js Volumetric Lighting Asset

This directory contains the byte-identical `colors.png` projector texture
used by the pinned Three.js `webgpu_volume_lighting` example.

| Field | Value |
|:--|:--|
| Upstream | https://github.com/mrdoob/three.js |
| Commit | `ad005397bbd15b0a9fcd5159c782eba56e1cba2a` |
| Source path | `examples/textures/colors.png` |
| Upstream example | `examples/webgpu_volume_lighting.html` |
| License | MIT (see `LICENSE`) |
| SHA-256 | `3992e4e4597da577cd8354a83cf62955f61c79567d8b323dc99e67473fe749e0` |

Reproduce and verify the vendor step without modifying the bytes:

```bash
curl -fsSL https://raw.githubusercontent.com/mrdoob/three.js/ad005397bbd15b0a9fcd5159c782eba56e1cba2a/examples/textures/colors.png \
  -o colors.png
shasum -a 256 colors.png
```

The Engine consumer records this source and digest in
`apps/hello/volumetric-fog/threejs-volume-lighting-parity.json`; it is an
external oracle asset, not a second runtime light or a replacement fog path.
