const MAX_FOLLOWUP_ERRORS = 8;

export function createRuntimeCache({ pixelSourceMethod }) {
  return {
    pixelSourceMethod,
    configureUsageBefore: null,
    configureUsageAfter: null,
    rawCopyInjected: false,
    surfaceIdentity: null,
    presentationProof: null,
    lastSuccessfulLifecyclePhase: null,
    frameId: null,
    observationId: null,
    deviceGeneration: null,
    firstRendererError: null,
    rendererErrors: [],
  };
}

export function applyRuntimeEvent(cache, event) {
  if (event === null || typeof event !== 'object') return cache;
  const value = event;
  for (const key of [
    'pixelSourceMethod',
    'configureUsageBefore',
    'configureUsageAfter',
    'surfaceIdentity',
    'presentationProof',
    'frameId',
    'observationId',
    'deviceGeneration',
  ]) {
    if (value[key] === undefined) continue;
    if ((key === 'surfaceIdentity' || key === 'presentationProof') && cache[key] !== null) continue;
    cache[key] = value[key];
  }
  if (value.rawCopyInjected === true) cache.rawCopyInjected = true;
  if (value.lastSuccessfulLifecyclePhase !== undefined) {
    cache.lastSuccessfulLifecyclePhase = value.lastSuccessfulLifecyclePhase;
  }
  const rendererError = value.rendererError;
  if (rendererError === null || typeof rendererError !== 'object') return cache;
  if (cache.firstRendererError === null) {
    cache.firstRendererError = rendererError;
  } else if (cache.rendererErrors.length < MAX_FOLLOWUP_ERRORS) {
    cache.rendererErrors.push(rendererError);
  }
  return cache;
}

export function snapshotRuntimeCache(cache) {
  return {
    ...cache,
    rendererErrors: [...cache.rendererErrors],
  };
}
