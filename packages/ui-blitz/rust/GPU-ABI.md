# UI raster preparation ABI

Version 1 is the Engine binding of Vello GPU 0.3's existing sparse-strip scheduler.
The Rust owner prepares data; the Renderer owns every GPU object, command encoder,
submission, retained output, device generation and retirement. No Rust pointers,
WebGL contexts, native device handles or arbitrary GPU commands cross this ABI.

The source is `vendor/vello_gpu` and its matching `vendor/vello_gpu_shaders`.
Both original crates.io checksums are recorded in `vendor/UPSTREAM.json`.
The portable feature enables neither wgpu nor webgl. The prepared shaders are the
same version's WGSL, with the explicitly documented color-matrix filter addition.

`paintGpu(timeMs, width, height)` returns `null` for unchanged output, otherwise a
frame with the fields below. Width/height are physical pixels. All integer arrays
and instance bytes use little-endian encoding. Every byte field is an owned
`Uint8Array`; the producer may reuse its WASM memory immediately after return.

```ts
type UiGpuDataTexture = { width: number; height: number; data: Uint8Array };
type UiGpuImage = { id: number; width: number; height: number; data: Uint8Array };
type UiGpuPass =
  | { kind: 'strip'; target: number; child: number | null; image: number | null;
      instances: Uint8Array }
  | { kind: 'clear'; target: number; instances: Uint8Array }
  | { kind: 'blend'; even: number; odd: number; instances: Uint8Array }
  | { kind: 'copy'; target: number; source: number; instances: Uint8Array }
  | { kind: 'filter'; target: number; source: number; instances: Uint8Array };
type UiGpuFrame = {
  version: 1; width: number; height: number;
  layerWidth: number; layerHeight: number; layerPages: [number, number];
  scratch: boolean;
  alphas: UiGpuDataTexture; paints: UiGpuDataTexture;
  gradients: UiGpuDataTexture; filterData: UiGpuDataTexture;
  images: UiGpuImage[];
  passes: UiGpuPass[];
};
```

Targets are derived from Vello's scheduler: `0` is the transparent UI output,
`1` is scratch, `2 + 2*page` is an even layer, `3 + 2*page` is an odd layer.
The Renderer clears output and all allocated layer pages to transparent at each
changed frame, then executes the passes in order. Scratch is fully overwritten
before each read. The initial implementation disables opaque depth optimization
in the upstream planner; source-over painter order is preserved without depth.

All output/image/gradient/layer textures are premultiplied sRGB RGBA8 in
`rgba8unorm`. Alpha, paint and filter parameter textures use `rgba32uint`, sampled
with `textureLoad`, never storage textures. Widths of the alpha and paint textures
are powers of two. No MSAA or compute capability is required.

The fixed pipeline contracts come from `vendor/vello_gpu/src/render/wgpu/mod.rs`:

| Pass | Instance stride | Vertex attributes | Bind groups |
| --- | ---: | --- | --- |
| strip | 24 | locations 0..5: uint32 | 0: alpha texture, 32-byte Config uniform, child texture; 1: image texture; 2: paint texture; 3: gradient texture |
| clear | 28 | 0:uint32x2, 1:uint32x2, 2:uint32x2, 3:uint32 | none |
| blend | 32 | locations 0..7: uint32 | 0: even layer, odd layer, alpha texture |
| copy | 16 | locations 0..3: uint32 | 0: source texture |
| filter | 36 | locations 0..8: uint32 | 0: filter texture; 1: source texture and linear sampler; 2: original scratch texture |

All draws are triangle-strip, 4 vertices, instance count = byte length / stride.
Vertex buffer offsets select each pass; firstInstance is always zero, including
WebGL2. Only strip uses premultiplied alpha blending; other passes overwrite.
Blend always writes scratch and is followed by the scheduler's copy into its
parent. Filter passes are already expanded into ordered blur/offset/shadow steps,
including any copy preserving original pixels. Missing child/image bindings use
one transparent 1x1 RGBA8 texture.

The strip Config is eight 32-bit fields in order:
`[targetWidth, targetHeight, 4, log2(alphaWidth), log2(paintWidth), 0, 0, 0]`.
The last three fields are signed strip offsets (zero) and `negate_ndc=0`; Engine's
wgpu/WebGPU coordinate conversion owns the target orientation.

Images in a frame are its complete live image roster. IDs are stable while the
source image is live, and pixel bytes are retained on the JS side so recovery can
reupload. The Renderer may reuse an existing texture for the same ID and extent;
retire absent images only after the previous submission completes. Unchanged UI
frames transfer no image, strip or full-frame RGBA data. A recovered device
replays the last accepted frame through this same preparation/submission owner.

The native admitted profile retains alpha masks via Blitz's isolated DestIn
layers, group opacity, transformed clips, glyphs, image sampling, rounded box
shadows, one blur/drop-shadow/color-matrix filter. The AnyRender adapter must
reject unsupported custom resources and unsupported filter graphs explicitly;
it must not inherit upstream's transparent-paint or ignored-filter fallbacks.
