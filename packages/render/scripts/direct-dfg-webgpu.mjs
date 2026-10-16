/** Isolated WebGPU DFG raster comparison; no Engine loop, UI, WASM or GL hooks. */
export async function runDirectDfgWebgpu(input) {
  const report = { kind: 'direct-dfg-webgpu-comparison', ok: false, startedAtUtcMs: Date.now(),
    source: input.source, extent: input.extent, lightEvaluationsPerPixel: 4,
    timingFormat: 'rgba16float', correctnessFormat: 'rgba32float', phases: [], errors: [] };
  let device, query, queryResolve, queryRead;
  const resources = [];
  const started = performance.now(), deadline = started + 60000;
  const bounded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('operation-deadline')), Math.min(10000, Math.max(1, deadline - performance.now())));
    })]); } finally { clearTimeout(timer); }
  };
  const quantiles = values => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted.length ? { samples: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) } : null;
  };
  try {
    if (!navigator.gpu) throw Error('webgpu-unavailable');
    const adapter = await bounded(navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }));
    if (!adapter) throw Error('webgpu-adapter-unavailable');
    const info = adapter.info;
    report.adapter = { vendor: info?.vendor, architecture: info?.architecture, device: info?.device, description: info?.description, isFallbackAdapter: info?.isFallbackAdapter };
    const timestamps = adapter.features.has('timestamp-query');
    device = await bounded(adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] }));
    report.timestampQuery = timestamps ? 'available' : 'unavailable';
    device.addEventListener('uncapturederror', event => { if (report.errors.length < 8) report.errors.push(String(event.error?.message ?? event.error)); });
    const own = resource => { resources.push(resource); return resource; };
    const params = own(device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const lut = own(device.createTexture({ size: [16, 16], format: 'rg16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
    device.queue.writeTexture({ texture: lut }, new Uint8Array(input.lutBytes), { bytesPerRow: 64, rowsPerImage: 16 }, [16, 16]);
    const referenceLut = own(device.createTexture({ size: [16, 16], format: 'rg16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
    device.queue.writeTexture({ texture: referenceLut }, new Uint8Array(input.referenceBytes), { bytesPerRow: 64, rowsPerImage: 16 }, [16, 16]);
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const pipelines = {}, groups = {}, modes = ['private-array', 'fit', 'texture'];
    const checkModes = [...modes, 'native-reference'];
    for (const mode of checkModes) {
      const module = device.createShaderModule({ code: input.shaders[mode], label: 'dfg-' + mode });
      const compilation = await bounded(module.getCompilationInfo());
      const failures = compilation.messages.filter(message => message.type === 'error');
      if (failures.length) throw Error(mode + ': ' + failures.map(message => message.message).join('; '));
      pipelines[mode] = {};
      groups[mode] = {};
      for (const format of mode === 'native-reference' ? ['rgba32float'] : ['rgba16float', 'rgba32float']) {
        const pipeline = await bounded(device.createRenderPipelineAsync({ layout: 'auto',
          vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        }));
        pipelines[mode][format] = pipeline;
        groups[mode][format] = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: params } },
          ...(mode === 'texture' || mode === 'native-reference' ? [{ binding: 1, resource: (mode === 'texture' ? lut : referenceLut).createView() }, { binding: 2, resource: sampler }] : []),
        ] });
      }
    }
    const render = (mode, target, format, queryIndex) => {
      if (performance.now() > deadline) throw Error('benchmark-deadline');
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ label: 'dfg-' + mode,
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        ...(queryIndex === undefined ? {} : { timestampWrites: { querySet: query, beginningOfPassWriteIndex: queryIndex, endOfPassWriteIndex: queryIndex + 1 } }),
      });
      pass.setPipeline(pipelines[mode][format]); pass.setBindGroup(0, groups[mode][format]); pass.draw(3); pass.end();
      device.queue.submit([encoder.finish()]);
    };
    // Numeric pixel comparisons are outside all performance windows. The binary
    // grid exercises bilinear interpolation and clamp-edge coverage.
    const checkWidth = 128, checkHeight = 64, checkBytes = checkWidth * checkHeight * 16;
    const checkTarget = own(device.createTexture({ size: [checkWidth, checkHeight], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
    const checkRead = own(device.createBuffer({ size: checkBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    device.queue.writeBuffer(params, 0, new Float32Array([checkWidth, checkHeight, 0, 0]));
    const values = {};
    for (const mode of checkModes) {
      render(mode, checkTarget, 'rgba32float');
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: checkTarget }, { buffer: checkRead, bytesPerRow: checkWidth * 16 }, [checkWidth, checkHeight]);
      device.queue.submit([encoder.finish()]);
      await bounded(checkRead.mapAsync(GPUMapMode.READ));
      values[mode] = new Float32Array(checkRead.getMappedRange().slice(0)); checkRead.unmap();
    }
    const compare = (a, b) => {
      let maximum = 0, squared = 0, nonFinite = 0;
      for (let i = 0; i < a.length; i++) {
        if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) { nonFinite++; continue; }
        const delta = Math.abs(a[i] - b[i]); maximum = Math.max(maximum, delta); squared += delta * delta;
      }
      return { samples: a.length, finite: nonFinite === 0, nonFinite, maxAbs: maximum, rmse: Math.sqrt(squared / (a.length - nonFinite)) };
    };
    const privateArrayVsTexture = compare(values['private-array'], values.texture);
    const textureVsNativeReference = compare(values.texture, values['native-reference']);
    report.correctness = { extent: [checkWidth, checkHeight], privateArrayVsTexture,
      formerHighPrecisionEquivalence: { tolerance: 0.00001, pass: privateArrayVsTexture.finite && privateArrayVsTexture.maxAbs <= 0.00001, gatesTiming: false },
      textureVsNativeReference: { ...textureVsNativeReference, tolerance: 0.000002, pass: textureVsNativeReference.finite && textureVsNativeReference.maxAbs < 0.000002 },
      fitVsTexture: compare(values.fit, values.texture),
      interpretation: 'Original table bytes are equal. Native half filtering can round differently from private-array high-precision interpolation; their original strict comparison is retained, not claimed as equivalent or relaxed. Texture is checked against the historical combination using an independently uploaded source table and the same native filtering. Fit changes the approximation; all differences remain separate from timing.' };
    if (!privateArrayVsTexture.finite || !report.correctness.textureVsNativeReference.pass || !report.correctness.fitVsTexture.finite) throw Error('DFG native-reference or finite-value correctness comparison failed');
    const [width, height] = input.extent;
    const target = own(device.createTexture({ size: [width, height], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT }));
    device.queue.writeBuffer(params, 0, new Float32Array([width, height, 0, 0]));
    const samples = 12, warmup = 4;
    if (timestamps) {
      query = device.createQuerySet({ type: 'timestamp', count: samples * 2 });
      queryResolve = own(device.createBuffer({ size: samples * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }));
      queryRead = own(device.createBuffer({ size: samples * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    }
    // Repeated orders expose drift without separate applications or
    // asset builds. Every sample completes before the next is submitted.
    const orders = [modes, [...modes].reverse(), [modes[1], modes[0], modes[2]]];
    for (let round = 0; round < orders.length; round++) for (const mode of orders[round]) {
      for (let i = 0; i < warmup; i++) { render(mode, target, 'rgba16float'); await bounded(device.queue.onSubmittedWorkDone()); }
      const phase = { round, mode, startedAtUtcMs: Date.now(), warmup, samples, submitToCompletionMs: [], gpuMs: [] };
      for (let i = 0; i < samples; i++) {
        const begin = performance.now(); render(mode, target, 'rgba16float', timestamps ? i * 2 : undefined);
        await bounded(device.queue.onSubmittedWorkDone()); phase.submitToCompletionMs.push(performance.now() - begin);
      }
      phase.endedAtUtcMs = Date.now();
      if (timestamps) {
        const encoder = device.createCommandEncoder(); encoder.resolveQuerySet(query, 0, samples * 2, queryResolve, 0);
        encoder.copyBufferToBuffer(queryResolve, 0, queryRead, 0, samples * 16); device.queue.submit([encoder.finish()]);
        await bounded(queryRead.mapAsync(GPUMapMode.READ));
        const data = new BigUint64Array(queryRead.getMappedRange());
        for (let i = 0; i < samples; i++) {
          if (data[i * 2 + 1] < data[i * 2]) throw Error('non-monotonic GPU timestamps');
          phase.gpuMs.push(Number(data[i * 2 + 1] - data[i * 2]) / 1e6);
        }
        queryRead.unmap();
      }
      report.phases.push(phase);
    }
    report.summary = Object.fromEntries(modes.map(mode => {
      const phases = report.phases.filter(phase => phase.mode === mode);
      return [mode, { gpuMs: quantiles(phases.flatMap(phase => phase.gpuMs)), submitToCompletionMs: quantiles(phases.flatMap(phase => phase.submitToCompletionMs)) }];
    }));
    report.scope = 'Isolated four-light direct multiscattering fragment workload. Measures this WebGPU adapter; no game FPS, UI cost, simulator result or phone claim. GPU query and completion wall time remain separate.';
    report.ok = report.errors.length === 0;
  } catch (error) { report.errors.push(String(error?.message ?? error)); }
  finally {
    for (const resource of resources.reverse()) { try { resource.destroy(); } catch {} }
    try { query?.destroy(); device?.destroy(); } catch {}
    report.endedAtUtcMs = Date.now(); report.durationMs = performance.now() - started;
  }
  return report;
}
