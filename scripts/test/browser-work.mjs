/** Count real main-realm native operations without changing results or promises. */
export function countBrowserWork(scope = globalThis) {
  const counts = {
    realm: 'browser-main',
    available: typeof scope.GPUAdapter?.prototype?.requestDevice === 'function',
    deviceRequests: 0,
    shaderModules: 0,
    pipelines: 0,
    readbackMaps: 0,
    submissions: 0,
  };
  const restore = [];
  const wrap = (prototype, name, counter, selected = () => true) => {
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, name);
    if (typeof descriptor?.value !== 'function') return;
    const original = descriptor.value;
    const counted = function (...args) {
      if (selected(args)) counts[counter]++;
      return Reflect.apply(original, this, args);
    };
    Object.defineProperty(prototype, name, { ...descriptor, value: counted });
    restore.push(() => {
      if (Object.getOwnPropertyDescriptor(prototype, name)?.value === counted)
        Object.defineProperty(prototype, name, descriptor);
    });
  };
  wrap(scope.GPUAdapter?.prototype, 'requestDevice', 'deviceRequests');
  wrap(scope.GPUDevice?.prototype, 'createShaderModule', 'shaderModules');
  for (const method of [
    'createRenderPipeline',
    'createRenderPipelineAsync',
    'createComputePipeline',
    'createComputePipelineAsync',
  ])
    wrap(scope.GPUDevice?.prototype, method, 'pipelines');
  wrap(scope.GPUBuffer?.prototype, 'mapAsync', 'readbackMaps', ([mode]) => (mode & 1) !== 0);
  wrap(scope.GPUQueue?.prototype, 'submit', 'submissions');
  return {
    counts,
    restore: () => {
      for (const undo of restore.reverse()) undo();
    },
  };
}

export function checkBrowserWorkBudget(file, counts, budgets, executedCases) {
  const normalized = file.replaceAll('\\', '/');
  const entry = Object.entries(budgets).find(
    ([owner]) => normalized.endsWith(`/${owner}`) || normalized === owner,
  );
  if (entry === undefined) return;
  const [owner, budget] = entry;
  if (!counts?.available) throw new Error(`Browser work counters unavailable for ${owner}`);
  if (!Number.isSafeInteger(counts.deviceRequests) || counts.deviceRequests < 0)
    throw new Error(`Incomplete Browser device counter for ${owner}`);
  if (executedCases !== undefined && executedCases < budget.minimumCases)
    throw new Error(
      `Browser case budget missing: ${owner} completed ${executedCases} cases, minimum ${budget.minimumCases}`,
    );
  if (counts.deviceRequests < (budget.minimumDeviceRequests ?? 0))
    throw new Error(
      `Browser cold-device budget missing: ${owner} requested ${counts.deviceRequests} devices, minimum ${budget.minimumDeviceRequests}`,
    );
  if (counts.deviceRequests > budget.deviceRequests)
    throw new Error(
      `Browser work budget exceeded: ${owner} requested ${counts.deviceRequests} devices, maximum ${budget.deviceRequests}; retain cases and independent oracle/replay devices, repair repeated fixture assembly`,
    );
  for (const counter of ['pipelines', 'readbackMaps', 'submissions']) {
    const maximum = budget[counter];
    if (maximum === undefined) continue;
    if (!Number.isSafeInteger(counts[counter]) || counts[counter] < 0)
      throw new Error(`Incomplete Browser ${counter} counter for ${owner}`);
    if (counts[counter] > maximum)
      throw new Error(
        `Browser work budget exceeded: ${owner} performed ${counts[counter]} ${counter}, maximum ${maximum}; retain assertions and repair repeated replay work`,
      );
  }
}
