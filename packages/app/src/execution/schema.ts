import { isMusicState } from '@forgeax/engine-audio';
import {
  EXECUTION_CAPABILITY_NAMES,
  EXECUTION_WORKERS,
  type ExecutionAudioReport,
  type ExecutionCapabilities,
  type ExecutionReport,
  type ExecutionSelection,
  type ExecutionWorker,
  type ExecutionWorkerDecision,
} from './types';

export const EXECUTION_REPORT_SCHEMA_VERSION = 3 as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isMeasurement(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['samples', 'p50', 'p95', 'p99', 'jitter'])) {
    return false;
  }
  return (
    Number.isInteger(value.samples) &&
    (value.samples as number) > 0 &&
    ['p50', 'p95', 'p99', 'jitter'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0,
    )
  );
}

export function isExecutionReport(value: unknown): value is ExecutionReport {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'workers',
      'capabilities',
      'engine',
      'world',
      'kernelDispatch',
      'frame',
      'performance',
      'audio',
      'fault',
      ...('render' in value ? ['render'] : []),
    ])
  ) {
    return false;
  }
  const report = value as unknown as Partial<ExecutionReport>;
  if (report.schemaVersion !== EXECUTION_REPORT_SCHEMA_VERSION) return false;
  if (!isRecord(report.workers) || !hasExactKeys(report.workers, EXECUTION_WORKERS)) return false;
  for (const worker of EXECUTION_WORKERS) {
    if (!isWorkerDecision(report.workers, worker)) return false;
  }
  if (!areCapabilityFacts(report.capabilities)) return false;
  if (report.render !== undefined && !isRenderSection(report.render, report.workers.render)) {
    return false;
  }
  return (
    isEngineSection(report.engine, report.workers.engine) &&
    isWorldSection(report.world) &&
    isKernelDispatchSection(report.kernelDispatch) &&
    isFrameSection(report.frame) &&
    isPerformanceSection(report.performance) &&
    isAudioSection(report.audio) &&
    isFaultSection(report.fault)
  );
}

function isWorkerDecisionShape(decision: ExecutionWorkerDecision): boolean {
  if (
    !isRecord(decision) ||
    !hasExactKeys(decision, ['requested', 'enabled', 'reason', 'missingCapabilities'])
  )
    return false;
  if (decision.requested !== 'auto' && typeof decision.requested !== 'boolean') return false;
  if (
    typeof decision.enabled !== 'boolean' ||
    !['enabled', 'disabled', 'engine-disabled', 'capability-unavailable'].includes(decision.reason)
  )
    return false;
  return (
    Array.isArray(decision.missingCapabilities) &&
    decision.missingCapabilities.every((name) => EXECUTION_CAPABILITY_NAMES.includes(name))
  );
}

/** Validates one worker decision; the engine decision is read only after its own validation. */
function isWorkerDecision(workers: ExecutionSelection, worker: ExecutionWorker): boolean {
  const decision = workers[worker];
  if (!isWorkerDecisionShape(decision)) return false;
  if (decision.enabled !== (decision.reason === 'enabled')) return false;
  if ((decision.requested === false) !== (decision.reason === 'disabled')) return false;
  if (decision.requested === true && !decision.enabled) return false;
  if ((decision.reason === 'capability-unavailable') !== decision.missingCapabilities.length > 0)
    return false;
  if (worker !== 'engine' && !workers.engine.enabled && decision.enabled) return false;
  return !(
    decision.reason === 'engine-disabled' &&
    (worker === 'engine' || workers.engine.enabled)
  );
}

function areCapabilityFacts(capabilities: ExecutionCapabilities | undefined): boolean {
  if (capabilities === undefined) return false;
  return EXECUTION_CAPABILITY_NAMES.every((name) => {
    const fact = capabilities[name];
    return typeof fact?.available === 'boolean' && typeof fact.reason === 'string';
  });
}

type ExecutionRenderSection = NonNullable<ExecutionReport['render']>;

function isRenderCapabilities(capabilities: ExecutionRenderSection['capabilities']): boolean {
  return (
    isRecord(capabilities) &&
    hasExactKeys(capabilities, ['backendKind', 'compute', 'storageBuffer']) &&
    ['webgpu', 'wgpu-native', 'wgpu-webgl2', 'null'].includes(capabilities.backendKind as string) &&
    typeof capabilities.compute === 'boolean' &&
    typeof capabilities.storageBuffer === 'boolean'
  );
}

function isRenderLimits(render: ExecutionRenderSection): boolean {
  const limits = render.limits;
  const maxStorageBuffersPerShaderStage = isRecord(limits)
    ? limits.maxStorageBuffersPerShaderStage
    : undefined;
  return (
    'capabilities' in render &&
    isRecord(limits) &&
    hasExactKeys(limits, ['maxStorageBuffersPerShaderStage']) &&
    typeof maxStorageBuffersPerShaderStage === 'number' &&
    Number.isSafeInteger(maxStorageBuffersPerShaderStage) &&
    maxStorageBuffersPerShaderStage >= 0
  );
}

function isRenderSection(
  render: ExecutionRenderSection,
  renderWorker: ExecutionWorkerDecision,
): boolean {
  if (
    !isRecord(render) ||
    !hasExactKeys(render, [
      'epoch',
      'state',
      'submittedFrame',
      'completedFrame',
      ...('capabilities' in render ? ['capabilities'] : []),
      ...('limits' in render ? ['limits'] : []),
    ])
  )
    return false;
  if ('capabilities' in render && !isRenderCapabilities(render.capabilities)) return false;
  if ('limits' in render && !isRenderLimits(render)) return false;
  if (!renderWorker.enabled || !['alive', 'rebuilding', 'failed', 'stopped'].includes(render.state))
    return false;
  return !(
    !Number.isSafeInteger(render.epoch) ||
    render.epoch < 1 ||
    !Number.isSafeInteger(render.submittedFrame) ||
    !Number.isSafeInteger(render.completedFrame) ||
    render.completedFrame < 0 ||
    render.submittedFrame < render.completedFrame
  );
}

function isEngineSection(
  engine: ExecutionReport['engine'] | undefined,
  engineWorker: ExecutionWorkerDecision,
): boolean {
  if (!isRecord(engine) || !hasExactKeys(engine, ['realm', 'health'])) return false;
  if (engine.realm !== (engineWorker.enabled ? 'worker' : 'host')) return false;
  return ['idle', 'starting', 'running', 'stopped', 'faulted'].includes(engine.health as string);
}

function isWorldSection(world: ExecutionReport['world'] | undefined): boolean {
  if (
    !isRecord(world) ||
    !hasExactKeys(world, ['identity', 'health', 'partialWrite', 'retryable'])
  ) {
    return false;
  }
  if (world.identity !== null && typeof world.identity !== 'string') return false;
  if (!['healthy', 'poisoned'].includes(world.health as string)) return false;
  return typeof world.partialWrite === 'boolean' && typeof world.retryable === 'boolean';
}

function isKernelDispatchSection(dispatch: ExecutionReport['kernelDispatch'] | undefined): boolean {
  if (
    !isRecord(dispatch) ||
    !hasExactKeys(dispatch, ['eligible', 'usedShared', 'reason', 'dispatched', 'completed'])
  ) {
    return false;
  }
  if (typeof dispatch.eligible !== 'boolean' || typeof dispatch.usedShared !== 'boolean')
    return false;
  if (
    ![
      'no-eligible-kernel',
      'zero-work',
      'small-span',
      'forced-inline',
      'shared',
      'poisoned',
    ].includes(dispatch.reason as string)
  )
    return false;
  return Number.isInteger(dispatch.dispatched) && Number.isInteger(dispatch.completed);
}

function isFrameSection(frame: ExecutionReport['frame'] | undefined): boolean {
  if (
    !isRecord(frame) ||
    !hasExactKeys(frame, ['submitted', 'completed', 'inFlight', 'highWater', 'throttledTicks'])
  )
    return false;
  if (
    !['submitted', 'completed', 'inFlight', 'highWater', 'throttledTicks'].every(
      (key) => Number.isInteger(frame[key]) && (frame[key] as number) >= 0,
    )
  )
    return false;
  return !(
    frame.completed > frame.submitted ||
    frame.inFlight !== frame.submitted - frame.completed ||
    frame.highWater < frame.inFlight
  );
}

function isPerformanceSection(performance: ExecutionReport['performance'] | undefined): boolean {
  if (
    !isRecord(performance) ||
    !hasExactKeys(performance, ['hostFrameMs', 'engineUpdateMs', 'kernelWaitMs', 'hostAudioMs'])
  )
    return false;
  for (const key of ['hostFrameMs', 'engineUpdateMs', 'kernelWaitMs', 'hostAudioMs'] as const) {
    const measurement = performance[key];
    if (measurement !== null && !isMeasurement(measurement)) return false;
  }
  return true;
}

function isAudioSection(audio: ExecutionAudioReport | undefined): boolean {
  if (
    !isRecord(audio) ||
    !hasExactKeys(audio, [
      'owner',
      'contextState',
      'activeSourceCount',
      'lastError',
      ...('streaming' in audio ? ['streaming'] : []),
      ...('music' in audio ? ['music'] : []),
      ...('cache' in audio ? ['cache'] : []),
    ])
  )
    return false;
  if (audio.owner !== 'host') return false;
  if (!['running', 'suspended', 'closed'].includes(audio.contextState as string)) return false;
  if (!Number.isInteger(audio.activeSourceCount) || (audio.activeSourceCount as number) < 0)
    return false;
  if ('streaming' in audio && !isAudioStreaming(audio.streaming)) return false;
  if ('music' in audio && !isMusicState(audio.music)) return false;
  if ('cache' in audio && !isAudioCache(audio.cache)) return false;
  return audio.lastError === null || isAudioLastError(audio.lastError);
}

function isAudioStreaming(streaming: ExecutionAudioReport['streaming']): boolean {
  const counters = [
    'encodedBytes',
    'pcmBytes',
    'pendingBytes',
    'pendingReads',
    'underruns',
  ] as const;
  if (!isRecord(streaming) || !hasExactKeys(streaming, counters)) return false;
  for (const key of counters) {
    if (!Number.isInteger(streaming[key]) || (streaming[key] as number) < 0) return false;
  }
  return true;
}

function isAudioCache(cache: ExecutionAudioReport['cache']): boolean {
  const counters = [
    'sources',
    'encodedBytes',
    'decodedBytes',
    'bytesHighWater',
    'pendingPlays',
  ] as const;
  if (!isRecord(cache) || !hasExactKeys(cache, counters)) return false;
  for (const key of counters)
    if (!Number.isSafeInteger(cache[key]) || (cache[key] as number) < 0) return false;
  return true;
}

function isAudioLastError(lastError: NonNullable<ExecutionAudioReport['lastError']>): boolean {
  if (!isRecord(lastError)) return false;
  if (!hasExactKeys(lastError, ['code', 'expected', 'hint', 'detail'])) return false;
  return (
    typeof lastError.code === 'string' &&
    typeof lastError.expected === 'string' &&
    typeof lastError.hint === 'string'
  );
}

function isFaultSection(fault: ExecutionReport['fault'] | undefined): boolean {
  if (fault === null) return true;
  if (!isRecord(fault)) return false;
  if (
    !hasExactKeys(fault, [
      'source',
      'code',
      'expected',
      'hint',
      'detail',
      'partialWrite',
      'retryable',
    ])
  )
    return false;
  if (
    !['bootstrap', 'handshake', 'runtime', 'kernel', 'world', 'rebuild'].includes(
      fault.source as string,
    )
  )
    return false;
  if (
    typeof fault.code !== 'string' ||
    typeof fault.expected !== 'string' ||
    typeof fault.hint !== 'string'
  )
    return false;
  return typeof fault.partialWrite === 'boolean' && typeof fault.retryable === 'boolean';
}
