import { createHash } from 'node:crypto';

type Call = (this: object, ...args: unknown[]) => unknown;
interface PipelineFact {
  readonly id: number;
  readonly label: string;
  readonly entryPoint: string;
  readonly moduleSha256: string | null;
  readonly moduleBytes: number;
  readonly rayQueryTokens: readonly string[];
}
interface DispatchFact {
  readonly pipeline: PipelineFact | null;
  readonly kind: 'direct' | 'indirect';
  readonly groups: readonly (number | null)[];
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;
const own = (value: unknown, key: string): unknown =>
  isObject(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

/** Public JS method observation only, adapted from the existing Native call journal. */
export function observeSceneFieldCommands(
  device: { readonly queue: object },
  source: (sha256: string, bytes: Uint8Array) => void,
) {
  const originals: { target: object; name: string; descriptor: PropertyDescriptor }[] = [];
  const hooked = new WeakMap<object, Set<string>>();
  const modules = new WeakMap<object, { sha256: string; code: string; bytes: number }>();
  const pipelines = new WeakMap<object, PipelineFact>();
  const encoders = new WeakMap<object, DispatchFact[]>();
  const passes = new WeakMap<
    object,
    { commands: DispatchFact[]; pipeline?: PipelineFact | undefined }
  >();
  const buffers = new WeakMap<object, readonly DispatchFact[]>();
  const catalog: PipelineFact[] = [];
  const submissions: {
    readonly observed: boolean;
    readonly dispatches: readonly DispatchFact[];
  }[] = [];
  const sources = new Set<string>();
  let sourceBytes = 0;
  let disposed = false;
  let failure: string | undefined;

  function hook(target: object, name: string, observe: (original: Call) => Call) {
    if (hooked.get(target)?.has(name)) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.writable)
      throw new Error(`Field observer requires a public writable JS method: ${name}`);
    const names = hooked.get(target) ?? new Set<string>();
    names.add(name);
    hooked.set(target, names);
    originals.push({ target, name, descriptor });
    Object.defineProperty(target, name, { ...descriptor, value: observe(descriptor.value) });
  }

  function registerPipeline(value: unknown, descriptor: unknown) {
    if (disposed || !isObject(value)) return;
    const label = own(descriptor, 'label');
    const compute = own(descriptor, 'compute');
    const module = own(compute, 'module');
    const facts = isObject(module) ? modules.get(module) : undefined;
    const entry = own(compute, 'entryPoint');
    const code = facts?.code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '') ?? '';
    const rayQueryTokens = [
      ...new Set(code.match(/\b(?:acceleration_structure|ray_query\w*|rayQuery\w*)\b/g) ?? []),
    ];
    const fact: PipelineFact = {
      id: catalog.length + 1,
      label: typeof label === 'string' ? label : '',
      entryPoint: typeof entry === 'string' ? entry : '',
      moduleSha256: facts?.sha256 ?? null,
      moduleBytes: facts?.bytes ?? 0,
      rayQueryTokens,
    };
    pipelines.set(value, fact);
    catalog.push(fact);
    if (fact.label.startsWith('irradiance-field.') && facts && !sources.has(facts.sha256)) {
      sourceBytes += facts.bytes;
      if (sourceBytes > 4 * 1024 * 1024) throw new Error('Field observer WGSL source cap exceeded');
      source(facts.sha256, Buffer.from(facts.code));
      sources.add(facts.sha256);
    }
  }

  function observePass(pass: object, commands: DispatchFact[]) {
    passes.set(pass, { commands });
    const prototype = Object.getPrototypeOf(pass);
    hook(
      prototype,
      'setPipeline',
      (original) =>
        function (...args) {
          const result = Reflect.apply(original, this, args);
          const active = passes.get(this);
          if (active) active.pipeline = isObject(args[0]) ? pipelines.get(args[0]) : undefined;
          return result;
        },
    );
    for (const [name, kind] of [
      ['dispatchWorkgroups', 'direct'],
      ['dispatchWorkgroupsIndirect', 'indirect'],
    ] as const)
      hook(
        prototype,
        name,
        (original) =>
          function (...args) {
            const result = Reflect.apply(original, this, args);
            const active = passes.get(this);
            if (active)
              active.commands.push({
                pipeline: active.pipeline ?? null,
                kind,
                groups:
                  kind === 'direct'
                    ? [
                        args[0],
                        args[1] === undefined ? 1 : args[1],
                        args[2] === undefined ? 1 : args[2],
                      ].map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : null))
                    : [],
              });
            return result;
          },
      );
  }

  function observeEncoder(encoder: object) {
    encoders.set(encoder, []);
    const prototype = Object.getPrototypeOf(encoder);
    hook(
      prototype,
      'beginComputePass',
      (original) =>
        function (...args) {
          const result = Reflect.apply(original, this, args);
          const commands = encoders.get(this);
          if (commands && isObject(result)) observePass(result, commands);
          return result;
        },
    );
    hook(
      prototype,
      'finish',
      (original) =>
        function (...args) {
          const result = Reflect.apply(original, this, args);
          const commands = encoders.get(this);
          if (commands && isObject(result)) buffers.set(result, commands.slice());
          return result;
        },
    );
  }

  const prototype = Object.getPrototypeOf(device);
  try {
    hook(
      prototype,
      'createShaderModule',
      (original) =>
        function (...args) {
          const result = Reflect.apply(original, this, args);
          if (this === device && isObject(result)) {
            const code = own(args[0], 'code');
            if (typeof code === 'string') {
              const bytes = Buffer.from(code);
              modules.set(result, {
                code,
                bytes: bytes.byteLength,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              });
            }
          }
          return result;
        },
    );
    hook(
      prototype,
      'createComputePipeline',
      (original) =>
        function (...args) {
          const result = Reflect.apply(original, this, args);
          if (this === device) registerPipeline(result, args[0]);
          return result;
        },
    );
    hook(
      prototype,
      'createComputePipelineAsync',
      (original) =>
        function (...args) {
          const result = Reflect.apply(original, this, args);
          if (this === device && result instanceof Promise)
            result.then(
              (pipeline) => {
                try {
                  registerPipeline(pipeline, args[0]);
                } catch (error) {
                  failure = String(error);
                }
              },
              () => {},
            );
          // The owner receives the exact original Promise.
          return result;
        },
    );
    hook(
      prototype,
      'createCommandEncoder',
      (original) =>
        function (...args) {
          const result = Reflect.apply(original, this, args);
          if (this === device && isObject(result)) observeEncoder(result);
          return result;
        },
    );
    hook(
      Object.getPrototypeOf(device.queue),
      'submit',
      (original) =>
        function (...args) {
          const result = Reflect.apply(original, this, args);
          if (this === device.queue) {
            // Never enumerate an arbitrary iterable a second time or replace owner arguments.
            const list = args[0];
            const known =
              Array.isArray(list) &&
              list.every((buffer) => isObject(buffer) && buffers.has(buffer));
            submissions.push({
              observed: known,
              dispatches: known ? list.flatMap((buffer) => buffers.get(buffer) ?? []) : [],
            });
          }
          return result;
        },
    );
  } catch (error) {
    for (const item of originals.reverse())
      Object.defineProperty(item.target, item.name, item.descriptor);
    throw error;
  }

  return {
    cursor: () => submissions.length,
    completed(start: number, frameId: number) {
      if (failure) throw new Error(failure);
      if (disposed || start < 0 || start >= submissions.length)
        throw new Error('Missing submitted Field observation');
      const submitted = submissions.slice(start);
      if (submitted.some((entry) => !entry.observed))
        throw new Error('Unobserved submitted command buffer');
      const dispatches = submitted.flatMap((entry) => entry.dispatches);
      for (const entry of ['traceProbes', 'updateProbes', 'deriveProbes']) {
        const hits = dispatches.filter((d) => d.pipeline?.entryPoint === entry);
        if (
          !hits.length ||
          hits.some(
            (d) =>
              d.kind !== 'direct' ||
              d.groups.some((n) => n === null || n <= 0) ||
              !d.pipeline?.label.startsWith('irradiance-field.') ||
              !d.pipeline.moduleSha256 ||
              d.pipeline.rayQueryTokens.length,
          )
        )
          throw new Error(`Missing actual positive Field dispatch: ${entry}`);
      }
      const field = dispatches.filter((d) => d.pipeline?.label.startsWith('irradiance-field.'));
      if (field.some((d) => !d.pipeline?.moduleSha256 || d.pipeline.rayQueryTokens.length))
        throw new Error('Field dispatch module is unavailable or contains Ray Query');
      return {
        frameId,
        submissionStart: start,
        submissionEnd: submissions.length,
        completedReceiptAndReadback: true,
        dispatches: field,
        unclassifiedDispatches: dispatches.filter((d) => !d.pipeline),
      };
    },
    dispose() {
      disposed = true;
      for (const item of originals.reverse())
        Object.defineProperty(item.target, item.name, item.descriptor);
      originals.length = 0;
      const fieldDispatches = submissions
        .flatMap((s) => s.dispatches)
        .filter((d) => d.pipeline?.label.startsWith('irradiance-field.'));
      return {
        pipelines: catalog,
        submissions: submissions.length,
        sourceBytes,
        failure,
        fieldDispatches,
        rayQueryFieldDispatches: fieldDispatches.filter((d) => d.pipeline?.rayQueryTokens.length),
        otherRayQueryDispatches: submissions
          .flatMap((s) => s.dispatches)
          .filter(
            (d) =>
              !d.pipeline?.label.startsWith('irradiance-field.') &&
              d.pipeline?.rayQueryTokens.length,
          ),
        unclassifiedDispatches: submissions.flatMap((s) => s.dispatches).filter((d) => !d.pipeline),
        sourceShaders: [...sources],
        scope:
          'Public JS calls plus actual completed receipt/readback; no GPU timing or backend-internal initialization claim',
      };
    },
  };
}
