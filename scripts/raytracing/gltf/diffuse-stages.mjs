const requireFact = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Read production reconstruction resources through their captured work bindings. */
export async function inspectDiffuseReconstruction(model, replay, save) {
  const find = (entry) =>
    model.works.find((work) => work.pipeline.shaders.some((shader) => shader.entryPoint === entry));
  const temporal = find('reconstructDiffuse');
  if (!temporal) return { mode: 'raw', stages: [] };
  const spatial = find('spatialDiffuse');
  const depthBinding = temporal.bindings.find(
    (item) => item.groupIndex === 0 && item.binding === 5,
  );
  requireFact(depthBinding?.resourceId, 'Missing reconstruction depth binding');
  const depth = (
    await replay.readResourceAtWork(depthBinding.resourceId, temporal.workIndex)
  ).unwrap();
  const stages = [];
  const read = async (name, binding, at) => {
    const source = temporal.bindings.find(
      (item) => item.groupIndex === 0 && item.binding === binding,
    );
    requireFact(source?.resourceId, `Missing reconstruction binding ${binding}`);
    const value = (await replay.readResourceAtWork(source.resourceId, at.workIndex)).unwrap();
    await save(`${name}.bin`, value.bytes);
    stages.push({
      name,
      binding,
      resourceId: source.resourceId,
      workIndex: at.workIndex,
      bytes: value.bytes.length,
    });
    return value.bytes;
  };
  const raw = await read('reconstruction-raw', 0, temporal);
  await read('reconstruction-motion', 8, temporal);
  const config = await read('reconstruction-config', 10, temporal);
  await read('reconstruction-records', 1, temporal);
  const history = await read('reconstruction-history', 2, temporal);
  const filtered = await read('reconstruction-temporal', 3, temporal);
  const signal = await read('reconstruction-signal', 4, spatial ?? temporal);
  const diagnostics = await read('reconstruction-diagnostics', 11, spatial ?? temporal);
  const pixels = raw.length / 80;
  requireFact(
    Number.isInteger(pixels) && pixels > 0 && pixels === depth.width * depth.height,
    'Malformed raw diffuse rows',
  );
  requireFact(
    history.length === pixels * 96 &&
      filtered.length === pixels * 96 &&
      signal.length === pixels * 16 &&
      diagnostics.length === pixels * 16,
    'Mismatched reconstruction extents',
  );
  const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rv = view(raw),
    pv = view(history),
    hv = view(filtered),
    sv = view(signal),
    dv = view(diagnostics);
  const images = Object.fromEntries(
    ['raw', 'previous', 'temporal', 'display', 'weight', 'rejection', 'support', 'deviation'].map(
      (name) => [name, new Uint8Array(pixels * 4)],
    ),
  );
  const statistics = {
    pixels,
    valid: 0,
    background: 0,
    invalid: 0,
    historySupported: 0,
    maxEffectiveWeight: 0,
    maxAge: 0,
    maxSpatialSupport: 0,
    rawSamples: 0,
    transportErrors: 0,
    rejectionBits: {},
    radiance: Object.fromEntries(
      ['raw', 'previous', 'temporal', 'display'].map((name) => [
        name,
        { validPixels: 0, sumRgb: [0, 0, 0], meanLuminance: null },
      ]),
    ),
  };
  for (let i = 0; i < pixels; i++) {
    const state = hv.getUint32(i * 96 + 72, true);
    requireFact(state <= 2, 'Unknown diffuse validity');
    statistics[['background', 'valid', 'invalid'][state]]++;
    const weight = hv.getFloat32(i * 96 + 12, true);
    const age = hv.getFloat32(i * 96 + 28, true);
    const mask = dv.getUint32(i * 16 + 4, true);
    const reject = dv.getUint32(i * 16, true);
    const support = dv.getUint32(i * 16 + 12, true);
    requireFact(Number.isFinite(weight) && weight >= 0 && weight <= 64, 'Unbounded history weight');
    requireFact(Number.isFinite(age) && age >= 0 && age <= 65535, 'Invalid history age');
    statistics.historySupported += Number(mask !== 0);
    statistics.maxEffectiveWeight = Math.max(statistics.maxEffectiveWeight, weight);
    statistics.maxAge = Math.max(statistics.maxAge, age);
    statistics.maxSpatialSupport = Math.max(statistics.maxSpatialSupport, support);
    statistics.rawSamples += rv.getUint32(i * 80 + 12, true);
    statistics.transportErrors += rv.getUint32(i * 80 + 28, true);
    for (const bit of [1, 2, 4, 8, 16, 32, 64, 128])
      statistics.rejectionBits[bit] =
        (statistics.rejectionBits[bit] ?? 0) + Number((reject & bit) !== 0);
    for (let channel = 0; channel < 3; channel++) {
      for (const [name, data, stride] of [
        ['raw', rv, 80],
        ['previous', pv, 96],
        ['temporal', hv, 96],
        ['display', sv, 16],
      ]) {
        const d = data.getFloat32(i * stride + channel * 4, true);
        requireFact(Number.isFinite(d) && d >= 0, `Invalid ${name} D`);
        const valid = name === 'previous' ? pv.getUint32(i * 96 + 72, true) === 1 : state === 1;
        if (valid) {
          statistics.radiance[name].sumRgb[channel] += d;
          if (channel === 0) statistics.radiance[name].validPixels++;
        }
        images[name][i * 4 + channel] = Math.round((d / (1 + d)) ** (1 / 2.2) * 255);
      }
      images.weight[i * 4 + channel] = Math.round(Math.min(1, weight / 16) * 255);
      images.support[i * 4 + channel] = Math.round(Math.min(1, support / 25) * 255);
      const m1 = hv.getFloat32(i * 96 + 16, true),
        m2 = hv.getFloat32(i * 96 + 20, true);
      requireFact(Number.isFinite(m1) && Number.isFinite(m2), 'Invalid luminance moments');
      const deviation = Math.sqrt(Math.max(0, m2 - m1 * m1));
      images.deviation[i * 4 + channel] = Math.round(
        (deviation / (1 + deviation)) ** (1 / 2.2) * 255,
      );
    }
    // Red: rejected with no support; green: some historical support; blue: invalid current.
    images.rejection.set(
      [mask === 0 && state === 1 ? 255 : 0, mask !== 0 ? 255 : 0, state === 2 ? 255 : 0, 255],
      i * 4,
    );
    for (const image of Object.values(images)) image[i * 4 + 3] = 255;
  }
  for (const [name, image] of Object.entries(images))
    await save(`reconstruction-${name}.rgba`, image);
  for (const row of Object.values(statistics.radiance))
    if (row.validPixels > 0)
      row.meanLuminance =
        row.sumRgb.reduce(
          (sum, value, channel) => sum + value * [0.2126, 0.7152, 0.0722][channel],
          0,
        ) / row.validPixels;
  return {
    mode: spatial ? (view(config).getUint32(8, true) === 0 ? 'spatial' : 'combined') : 'temporal',
    width: depth.width,
    height: depth.height,
    stages,
    statistics,
    display: {
      radiance: 'D / (1 + D), gamma 2.2',
      weightWhite: 16,
      supportWhite: 25,
      rejection: 'red=no history support, green=history support, blue=invalid current',
    },
  };
}
