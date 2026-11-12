import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';

const addonSha256 =
  process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native'
    ? createHash('sha256')
        .update(
          readFileSync(
            process.env.FORGEAX_RHI_WGPU_NATIVE_ADDON ??
              new URL(
                `../../native/forgeax-rhi-wgpu-native.${process.platform}-${process.arch}.node`,
                import.meta.url,
              ),
          ),
        )
        .digest('hex')
    : undefined;

it('initializes a fresh MSAA resolve subresource without discarding neighboring mips or layers', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('MSAA initialization regression requires a real adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const destination = device.createTexture({
    label: 'MSAA initialization destination with neighboring subresources',
    size: [4, 4, 2],
    mipLevelCount: 2,
    format: 'rgba8unorm',
    usage: 16 | 1,
  });
  const source = device.createTexture({
    label: 'MSAA initialization source',
    size: [2, 2],
    sampleCount: 4,
    format: 'rgba8unorm',
    usage: 16,
  });
  const staging = device.createBuffer({ size: 4096, usage: 1 | 8 });
  const rows: { mip: number; layer: number; rgba: number[] }[] = [];
  const view = (mip: number, layer: number) =>
    destination.createView({
      dimension: '2d',
      baseMipLevel: mip,
      mipLevelCount: 1,
      baseArrayLayer: layer,
      arrayLayerCount: 1,
    });
  try {
    const encoder = device.createCommandEncoder();
    for (let mip = 0; mip < 2; mip++) {
      for (let layer = 0; layer < 2; layer++) {
        if (mip === 1 && layer === 1) continue;
        encoder
          .beginRenderPass({
            colorAttachments: [
              {
                view: view(mip, layer),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [1, 0, 0, 1],
              },
            ],
          })
          .end();
      }
    }
    // Both first use and repeated full overwrite must preserve the other subresources.
    for (const color of [
      [0, 0, 1, 1],
      [0, 1, 0, 1],
    ]) {
      encoder
        .beginRenderPass({
          colorAttachments: [
            {
              view: source.createView(),
              resolveTarget: view(1, 1),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: color,
            },
          ],
        })
        .end();
    }
    for (let mip = 0; mip < 2; mip++) {
      for (let layer = 0; layer < 2; layer++) {
        const width = 4 >> mip;
        encoder.copyTextureToBuffer(
          { texture: destination, mipLevel: mip, origin: [0, 0, layer] },
          { buffer: staging, offset: (mip * 2 + layer) * 1024, bytesPerRow: 256 },
          [width, width],
        );
      }
    }
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    const bytes = new Uint8Array(staging.getMappedRange());
    for (let mip = 0; mip < 2; mip++) {
      for (let layer = 0; layer < 2; layer++) {
        const expected = mip === 1 && layer === 1 ? [0, 255, 0, 255] : [255, 0, 0, 255];
        const offset = (mip * 2 + layer) * 1024;
        rows.push({ mip, layer, rgba: Array.from(bytes.subarray(offset, offset + 4)) });
        for (let y = 0; y < 4 >> mip; y++) {
          for (let x = 0; x < 4 >> mip; x++) {
            const start = offset + y * 256 + x * 4;
            expect(Array.from(bytes.subarray(start, start + 4))).toEqual(expected);
          }
        }
      }
    }
    staging.unmap();
    expect(errors).toEqual([]);
  } finally {
    mkdirSync('artifacts/native-timestamps', { recursive: true });
    writeFileSync(
      'artifacts/native-timestamps/msaa-subresources-result.json',
      JSON.stringify(
        {
          backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          addonSha256,
          adapter: { vendor: adapter.info.vendor, device: adapter.info.device },
          rows,
          errors,
        },
        null,
        2,
      ),
    );
    source.destroy();
    destination.destroy();
    staging.destroy();
    device.destroy();
  }
}, 30_000);

it('writes fresh ordered timestamps for drawn, clear-only and empty passes', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('timestamp regression requires a real adapter');
  expect(adapter.features.has('timestamp-query')).toBe(true);
  const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const query = device.createQuerySet({ type: 'timestamp', count: 2 });
  const resolved = device.createBuffer({ size: 256, usage: 512 | 4 });
  const staging = device.createBuffer({ size: 256, usage: 1 | 8 });
  const target = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 16 });
  const indirect = device.createBuffer({ size: 12, usage: 256 | 8 });
  const module = device.createShaderModule({
    code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }
@compute @workgroup_size(1) fn cs() {}
`,
  });
  const raster = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
  });
  const compute = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'cs' },
  });
  const cases = [
    'draw',
    'clear',
    'clear',
    'zero-draw',
    'load-only',
    'dispatch',
    'zero-dispatch',
    'empty-indirect',
    'empty-compute',
    'draw',
    'clear',
  ];
  const rows: { kind: string; begin: string; end: string }[] = [];
  try {
    let previous: bigint | undefined;
    for (const kind of cases) {
      const encoder = device.createCommandEncoder();
      const timestampWrites = {
        querySet: query,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      };
      if (['dispatch', 'zero-dispatch', 'empty-indirect', 'empty-compute'].includes(kind)) {
        const pass = encoder.beginComputePass({ timestampWrites });
        if (kind !== 'empty-compute') {
          pass.setPipeline(compute);
          if (kind === 'empty-indirect') pass.dispatchWorkgroupsIndirect(indirect, 0);
          else pass.dispatchWorkgroups(kind === 'dispatch' ? 1 : 0);
        }
        pass.end();
      } else {
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: target.createView(),
              loadOp: kind === 'load-only' ? 'load' : 'clear',
              storeOp: 'store',
              clearValue: [0, 0, 0, 1],
            },
          ],
          timestampWrites,
        });
        if (kind === 'draw' || kind === 'zero-draw') {
          pass.setPipeline(raster);
          pass.draw(kind === 'draw' ? 3 : 0);
        }
        pass.end();
      }
      encoder.resolveQuerySet(query, 0, 2, resolved, 0);
      encoder.copyBufferToBuffer(resolved, 0, staging, 0, 256);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(1);
      const ticks = new BigUint64Array(staging.getMappedRange().slice(0));
      staging.unmap();
      const begin = ticks[0];
      const end = ticks[1];
      if (begin === undefined || end === undefined) throw new Error('missing query bytes');
      rows.push({ kind, begin: String(begin), end: String(end) });
      expect(begin, `${kind} beginning query`).toBeGreaterThan(0n);
      expect(end, `${kind} ordered end query`).toBeGreaterThanOrEqual(begin);
      if (previous !== undefined) {
        expect(begin, `${kind} beginning must not retain an earlier pass`).toBeGreaterThanOrEqual(
          previous,
        );
        expect(end, `${kind} query must not retain the preceding pass`).toBeGreaterThan(previous);
      }
      previous = end;
    }
    expect(errors).toEqual([]);
  } finally {
    mkdirSync('artifacts/native-timestamps', { recursive: true });
    writeFileSync(
      'artifacts/native-timestamps/result.json',
      JSON.stringify(
        {
          backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          addonSha256,
          adapter: { vendor: adapter.info.vendor, device: adapter.info.device },
          rows,
          errors,
        },
        null,
        2,
      ),
    );
    query.destroy();
    resolved.destroy();
    staging.destroy();
    target.destroy();
    indirect.destroy();
    device.destroy();
  }
}, 30_000);

it('preserves one-row texel copies with omitted stride and nonzero buffer offsets', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('texel-copy regression requires a real adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const source = device.createBuffer({ size: 512, usage: 4 | 8 });
  const staging = device.createBuffer({ size: 512, usage: 1 | 8 });
  const texture = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 1 | 2 });
  const color = Uint8Array.of(85, 170, 255, 255);
  const rows: { direction: string; offset: number; actual: number[] }[] = [];
  try {
    for (const direction of ['upload', 'download']) {
      for (const offset of [4, 16, 256, 272]) {
        const initial = new Uint8Array(512).fill(0xaa);
        device.queue.writeBuffer(staging, 0, initial);
        const encoder = device.createCommandEncoder();
        if (direction === 'upload') {
          const bytes = initial.slice();
          bytes.set(color, offset);
          device.queue.writeBuffer(source, 0, bytes);
          encoder.copyBufferToTexture({ buffer: source, offset }, { texture }, [1, 1]);
        } else device.queue.writeTexture({ texture }, color, { bytesPerRow: 4 }, [1, 1]);
        const destination = direction === 'upload' ? 256 : offset;
        encoder.copyTextureToBuffer(
          { texture },
          {
            buffer: staging,
            offset: destination,
            ...(direction === 'upload' ? { bytesPerRow: 256 } : {}),
          },
          [1, 1],
        );
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(1);
        const actual = new Uint8Array(staging.getMappedRange()).slice();
        staging.unmap();
        rows.push({ direction, offset, actual: Array.from(actual) });
        const expected = initial.slice();
        expected.set(color, destination);
        expect(
          equalBytes(actual, expected),
          `${direction} offset ${offset}, preserved surrounding bytes`,
        ).toBe(true);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    mkdirSync('artifacts/native-timestamps', { recursive: true });
    writeFileSync(
      'artifacts/native-timestamps/texel-copy-result.json',
      JSON.stringify(
        {
          backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          addonSha256,
          adapter: { vendor: adapter.info.vendor, device: adapter.info.device },
          rows,
          errors,
        },
        null,
        2,
      ),
    );
    source.destroy();
    staging.destroy();
    texture.destroy();
    device.destroy();
  }
}, 30_000);

it('preserves copies between multiple resolves and command buffers in one submission', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('resolve ordering requires a real adapter');
  const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const query = device.createQuerySet({ type: 'timestamp', count: 2 });
  const resolved = device.createBuffer({ size: 256, usage: 512 | 4 });
  const staging = device.createBuffer({ size: 1024, usage: 1 | 8 });
  const target = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 16 | 1 });
  const rows: { iteration: number; ticks: string[]; colors: number[][] }[] = [];
  try {
    let previousEnd = 0n;
    for (let iteration = 0; iteration < 4; iteration++) {
      const commands: GPUCommandBuffer[] = [];
      for (let command = 0; command < 2; command++) {
        const encoder = device.createCommandEncoder();
        encoder.pushDebugGroup('outer resolve sequence');
        for (let part = 0; part < 2; part++) {
          const index = command * 2 + part;
          encoder.pushDebugGroup(`sample ${index}`);
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: target.createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [index / 3, 0, 0, 1],
              },
            ],
            timestampWrites: {
              querySet: query,
              beginningOfPassWriteIndex: 0,
              endOfPassWriteIndex: 1,
            },
          });
          pass.end();
          encoder.resolveQuerySet(query, 0, 2, resolved, 0);
          encoder.copyBufferToBuffer(resolved, 0, staging, index * 256, 16);
          encoder.copyTextureToBuffer(
            { texture: target },
            { buffer: staging, offset: index * 256 + 16 },
            [1, 1],
          );
          encoder.popDebugGroup();
        }
        encoder.popDebugGroup();
        commands.push(encoder.finish());
      }
      device.queue.submit(commands);
      await staging.mapAsync(1);
      const bytes = new Uint8Array(staging.getMappedRange()).slice();
      staging.unmap();
      const ticks: string[] = [];
      const colors: number[][] = [];
      rows.push({ iteration, ticks, colors });
      for (let index = 0; index < 4; index++) {
        const pair = new BigUint64Array(bytes.buffer, index * 256, 2);
        const begin = pair[0] ?? 0n;
        const end = pair[1] ?? 0n;
        ticks.push(String(begin), String(end));
        const color = Array.from(bytes.subarray(index * 256 + 16, index * 256 + 20));
        colors.push(color);
        expect(begin, `resolve ${index} fresh beginning`).toBeGreaterThan(previousEnd);
        expect(end, `resolve ${index} ordered end`).toBeGreaterThanOrEqual(begin);
        expect(color, `copy after resolve ${index}`).toEqual([index * 85, 0, 0, 255]);
        previousEnd = end;
      }
    }
    expect(errors).toEqual([]);
  } finally {
    mkdirSync('artifacts/native-timestamps', { recursive: true });
    writeFileSync(
      'artifacts/native-timestamps/multiple-resolve-result.json',
      JSON.stringify(
        {
          backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          addonSha256,
          adapter: { vendor: adapter.info.vendor, device: adapter.info.device },
          rows,
          errors,
        },
        null,
        2,
      ),
    );
    query.destroy();
    resolved.destroy();
    staging.destroy();
    target.destroy();
    device.destroy();
  }
}, 30_000);

it('preserves color, integer MRT, view formats, MSAA, depth and stencil when timed', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('attachment preservation requires a real adapter');
  const stencil = adapter.features.has('depth32float-stencil8');
  const device = await adapter.requestDevice({
    requiredFeatures: ['timestamp-query', ...(stencil ? ['depth32float-stencil8' as const] : [])],
  });
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const query = device.createQuerySet({ type: 'timestamp', count: 2 });
  const resolved = device.createBuffer({ size: 256, usage: 512 | 4 });
  const staging = device.createBuffer({ size: 4096, usage: 1 | 8 });
  const queryStaging = device.createBuffer({ size: 256, usage: 1 | 8 });
  const depthFormat: GPUTextureFormat = stencil ? 'depth32float-stencil8' : 'depth32float';
  const module = device.createShaderModule({
    code: `
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],.25,1);
}
@fragment fn color()->@location(0) vec4f { return vec4f(.2,.4,.6,1); }
struct Mrt { @location(0) color:vec4f, @location(1) integer:u32 }
@fragment fn mrt()->Mrt { return Mrt(vec4f(.2,.4,.6,1),123456789u); }
`,
  });
  const rows: { kind: string; equal: boolean; ticks: string[]; attachments: number[][] }[] = [];
  const textures: GPUTexture[] = [];
  const texture = (descriptor: GPUTextureDescriptor) => {
    const value = device.createTexture(descriptor);
    textures.push(value);
    return value;
  };
  try {
    for (const kind of [
      'clear',
      'color-depth-stencil',
      'integer-mrt',
      'srgb-view',
      'msaa',
      'depth-only',
      'readonly-depth-stencil',
    ]) {
      const onlyDepth = kind === 'depth-only';
      const readonlyDepth = kind === 'readonly-depth-stencil';
      const samples = kind === 'msaa' ? 4 : 1;
      const format: GPUTextureFormat = kind === 'srgb-view' ? 'rgba8unorm-srgb' : 'rgba8unorm';
      const color = texture({
        size: [4, 4],
        format: 'rgba8unorm',
        sampleCount: samples,
        usage: 16 | (samples === 1 ? 1 : 0),
        viewFormats: kind === 'srgb-view' ? ['rgba8unorm-srgb'] : [],
      });
      const colorView = color.createView({ format });
      const destination =
        samples === 1 ? color : texture({ size: [4, 4], format: 'rgba8unorm', usage: 16 | 1 });
      const integer =
        kind === 'integer-mrt'
          ? texture({ size: [4, 4], format: 'r32uint', usage: 16 | 1 })
          : undefined;
      const depth =
        samples === 1 ? texture({ size: [4, 4], format: depthFormat, usage: 16 | 1 }) : undefined;
      if (readonlyDepth && depth) {
        const encoder = device.createCommandEncoder();
        encoder
          .beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
              view: depth.createView(),
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
              depthClearValue: 0.75,
              ...(stencil
                ? {
                    stencilLoadOp: 'clear' as const,
                    stencilStoreOp: 'store' as const,
                    stencilClearValue: 7,
                  }
                : {}),
            },
          })
          .end();
        device.queue.submit([encoder.finish()]);
      }
      const targets: (GPUColorTargetState | null)[] = onlyDepth
        ? []
        : [{ format }, ...(integer ? [{ format: 'r32uint' as const }, null] : [])];
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        ...(onlyDepth
          ? {}
          : { fragment: { module, entryPoint: integer ? 'mrt' : 'color', targets } }),
        ...(depth
          ? {
              depthStencil: {
                format: depthFormat,
                depthWriteEnabled: !readonlyDepth,
                depthCompare: 'always' as const,
                ...(stencil
                  ? {
                      stencilFront: {
                        compare: 'always' as const,
                        passOp: readonlyDepth ? ('keep' as const) : ('replace' as const),
                      },
                      stencilBack: {
                        compare: 'always' as const,
                        passOp: readonlyDepth ? ('keep' as const) : ('replace' as const),
                      },
                      stencilWriteMask: readonlyDepth ? 0 : 255,
                    }
                  : {}),
              },
            }
          : {}),
        multisample: { count: samples },
      });
      const images: Uint8Array[] = [];
      const ticks: string[] = [];
      for (const timed of [false, true]) {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: onlyDepth
            ? []
            : [
                {
                  view: colorView,
                  loadOp: 'clear',
                  storeOp: 'store',
                  clearValue: [0.25, 0.5, 0.75, 1],
                  ...(samples === 4 ? { resolveTarget: destination.createView() } : {}),
                },
                ...(integer
                  ? [
                      {
                        view: integer.createView(),
                        loadOp: 'clear' as const,
                        storeOp: 'store' as const,
                        clearValue: [987, 0, 0, 0],
                      },
                      null,
                    ]
                  : []),
              ],
          ...(depth
            ? {
                depthStencilAttachment: {
                  view: depth.createView(),
                  ...(readonlyDepth
                    ? { depthReadOnly: true, ...(stencil ? { stencilReadOnly: true } : {}) }
                    : {
                        depthLoadOp: 'clear' as const,
                        depthStoreOp: 'store' as const,
                        depthClearValue: 0.75,
                        ...(stencil
                          ? {
                              stencilLoadOp: 'clear' as const,
                              stencilStoreOp: 'store' as const,
                              stencilClearValue: 7,
                            }
                          : {}),
                      }),
                },
              }
            : {}),
          ...(timed
            ? {
                timestampWrites: {
                  querySet: query,
                  beginningOfPassWriteIndex: 0,
                  endOfPassWriteIndex: 1,
                },
              }
            : {}),
        });
        if (kind !== 'clear') {
          pass.setPipeline(pipeline);
          pass.setScissorRect(1, 1, 2, 2);
          pass.setViewport(0, 0, 4, 4, 0, 1);
          if (stencil) pass.setStencilReference(19);
          pass.draw(3);
        }
        pass.end();
        if (!onlyDepth)
          encoder.copyTextureToBuffer(
            { texture: destination },
            { buffer: staging, offset: 0, bytesPerRow: 256 },
            [4, 4],
          );
        if (depth)
          encoder.copyTextureToBuffer(
            { texture: depth, aspect: 'depth-only' },
            { buffer: staging, offset: 1024, bytesPerRow: 256 },
            [4, 4],
          );
        if (depth && stencil)
          encoder.copyTextureToBuffer(
            { texture: depth, aspect: 'stencil-only' },
            { buffer: staging, offset: 2048, bytesPerRow: 256 },
            [4, 4],
          );
        if (integer)
          encoder.copyTextureToBuffer(
            { texture: integer },
            { buffer: staging, offset: 3072, bytesPerRow: 256 },
            [4, 4],
          );
        if (timed) {
          encoder.resolveQuerySet(query, 0, 2, resolved, 0);
          encoder.copyBufferToBuffer(resolved, 0, queryStaging, 0, 16);
        }
        device.queue.submit([encoder.finish()]);
        if (timed) {
          await queryStaging.mapAsync(1);
          const raw = new BigUint64Array(queryStaging.getMappedRange().slice(0), 0, 2);
          queryStaging.unmap();
          ticks.push(...Array.from(raw, String));
          expect(raw[0]).toBeGreaterThan(0n);
          expect(raw[1]).toBeGreaterThanOrEqual(raw[0] ?? 0n);
        }
        await staging.mapAsync(1);
        const bytes = new Uint8Array(staging.getMappedRange()).slice();
        staging.unmap();
        const actual: number[] = [];
        for (const [offset, texelBytes, present] of [
          [0, 4, !onlyDepth],
          [1024, 4, !!depth],
          [2048, 1, !!depth && stencil],
          [3072, 4, !!integer],
        ] as const)
          if (present)
            for (let y = 0; y < 4; y++)
              actual.push(...bytes.subarray(offset + y * 256, offset + y * 256 + 4 * texelBytes));
        images.push(Uint8Array.from(actual));
      }
      const equal = images[0]?.every((value, index) => value === images[1]?.[index]) ?? false;
      rows.push({ kind, equal, ticks, attachments: images.map((value) => Array.from(value)) });
      expect(equal, `${kind} attachment bytes`).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally {
    mkdirSync('artifacts/native-timestamps', { recursive: true });
    writeFileSync(
      'artifacts/native-timestamps/attachment-result.json',
      JSON.stringify(
        {
          backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          addonSha256,
          adapter: { vendor: adapter.info.vendor, device: adapter.info.device },
          stencil,
          rows,
          errors,
        },
        null,
        2,
      ),
    );
    textures.forEach((value) => {
      value.destroy();
    });
    query.destroy();
    resolved.destroy();
    staging.destroy();
    queryStaging.destroy();
    device.destroy();
  }
}, 30_000);
