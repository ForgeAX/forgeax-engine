/** Observe indexed work when executed, including cached native render bundles. */
export function observeIndexedDraws(device, consume) {
  const bundles = new WeakMap();
  const createBundle = device.createRenderBundleEncoder.bind(device);
  device.createRenderBundleEncoder = (descriptor) => {
    const encoder = createBundle(descriptor);
    const instances = [];
    const draw = encoder.drawIndexed.bind(encoder);
    encoder.drawIndexed = (count, copies = 1, first = 0, base = 0, instance = 0) => {
      const result = draw(count, copies, first, base, instance);
      instances.push(copies);
      return result;
    };
    const finish = encoder.finish.bind(encoder);
    encoder.finish = (descriptor) => {
      const bundle = finish(descriptor);
      bundles.set(bundle, Object.freeze(instances.slice()));
      return bundle;
    };
    return encoder;
  };
  const create = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = (descriptor) => {
    const encoder = create(descriptor);
    const begin = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = (descriptor) => {
      const pass = begin(descriptor);
      const draw = pass.drawIndexed.bind(pass);
      pass.drawIndexed = (count, copies = 1, first = 0, base = 0, instance = 0) => {
        const result = draw(count, copies, first, base, instance);
        consume(copies);
        return result;
      };
      const execute = pass.executeBundles.bind(pass);
      pass.executeBundles = (input) => {
        const handles = Array.from(input);
        for (const bundle of handles)
          if (!bundles.has(bundle)) throw new Error('Cannot count an unobserved render bundle');
        const result = execute(handles);
        for (const bundle of handles)
          for (const copies of bundles.get(bundle)) consume(copies);
        return result;
      };
      return pass;
    };
    return encoder;
  };
}
