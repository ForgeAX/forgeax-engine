import { ok, type RhiDevice, type RhiRenderCommands } from '@forgeax/engine-rhi';
import { acquireCanvasContext, createShaderModule, RhiNullAdapter } from '@forgeax/engine-rhi-null';

/** Extend legacy raw-device doubles so their existing pass spies observe executed
 * bundle commands, including reuse after the spies are cleared between frames.
 */
export function mockRenderBundles<T extends object>(device: T): T {
  const bundles = new WeakMap<object, { method: string; args: unknown[] }[]>();
  return new Proxy(device, {
    get(target, key, receiver) {
      if (key === 'createRenderBundleEncoder') {
        return () => {
          const commands: { method: string; args: unknown[] }[] = [];
          return new Proxy(
            {},
            {
              get(_encoder, method: string) {
                if (method === 'finish')
                  return () => {
                    const bundle = {};
                    bundles.set(bundle, commands);
                    return bundle;
                  };
                return (...args: unknown[]) => {
                  commands.push({ method, args });
                };
              },
            },
          );
        };
      }
      const value = Reflect.get(target, key, receiver);
      if (key !== 'createCommandEncoder' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        // These are partial test doubles, not native GPU objects.
        const encoder = Reflect.apply(value, target, args);
        const begin = Reflect.get(encoder, 'beginRenderPass');
        Reflect.set(encoder, 'beginRenderPass', (...passArgs: unknown[]) => {
          const pass = Reflect.apply(begin, encoder, passArgs);
          if (typeof pass !== 'object' || pass === null)
            throw new Error('mock render pass must be an object');
          Reflect.set(pass, 'executeBundles', (executed: Iterable<object>) => {
            for (const bundle of executed) {
              const commands = bundles.get(bundle);
              if (commands === undefined) throw new Error('unknown mock render bundle');
              for (const command of commands) {
                Reflect.apply(Reflect.get(pass, command.method), pass, command.args);
              }
            }
          });
          return pass;
        });
        return encoder;
      };
    },
  });
}

/** Keep dispatch assertions attached to execution for both direct and bundled draws. */
export function makeExplicitNullRhi(
  spies: Pick<RhiRenderCommands, 'draw' | 'drawIndexed' | 'setIndexBuffer' | 'setVertexBuffer'>,
): unknown {
  const adapter = new RhiNullAdapter();
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async () => {
    const result = await requestDevice();
    if (!result.ok) return result;
    const device: RhiDevice = result.value;
    const bundleCalls = new WeakMap<object, (() => void)[]>();
    const observe = <T extends RhiRenderCommands>(target: T, emit: (call: () => void) => void): T =>
      new Proxy(target, {
        get(object, key, receiver) {
          const value = Reflect.get(object, key, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (Object.hasOwn(spies, key)) {
              emit(() => Reflect.apply(Reflect.get(spies, key), spies, args));
            }
            return Reflect.apply(value, object, args);
          };
        },
      });
    const createBundle = device.createRenderBundleEncoder.bind(device);
    device.createRenderBundleEncoder = (desc) => {
      const result = createBundle(desc);
      if (!result.ok) return result;
      const calls: (() => void)[] = [];
      const encoder = result.value;
      const finish = encoder.finish.bind(encoder);
      encoder.finish = (desc) => {
        const finished = finish(desc);
        if (finished.ok) bundleCalls.set(finished.value, calls);
        return finished;
      };
      return ok(observe(encoder, (call) => calls.push(call)));
    };
    const createCommandEncoder = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = (desc) => {
      const result = createCommandEncoder(desc);
      if (!result.ok) return result;
      const encoder = result.value;
      const begin = encoder.beginRenderPass.bind(encoder);
      encoder.beginRenderPass = (desc) => {
        const pass = begin(desc);
        const execute = pass.executeBundles.bind(pass);
        pass.executeBundles = (bundles) => {
          const selected = Array.from(bundles);
          const result = execute(selected);
          if (result.ok)
            for (const bundle of selected) {
              const calls = bundleCalls.get(bundle);
              if (calls === undefined) throw new Error('unobserved render bundle');
              for (const call of calls) call();
            }
          return result;
        };
        return observe(pass, (call) => call());
      };
      return result;
    };
    return result;
  };
  return {
    requestAdapter: async () => ok(adapter),
    acquireCanvasContext,
    createShaderModule,
  };
}
