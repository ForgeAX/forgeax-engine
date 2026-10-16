import { isMusicState } from '@forgeax/engine-audio';
import { EXECUTION_CAPABILITY_NAMES, EXECUTION_WORKERS, type ExecutionReport } from './types';

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
    const decision = report.workers[worker];
    if (
      !isRecord(decision) ||
      !hasExactKeys(decision, ['requested', 'enabled', 'reason', 'missingCapabilities'])
    )
      return false;
    if (decision.requested !== 'auto' && typeof decision.requested !== 'boolean') return false;
    if (
      typeof decision.enabled !== 'boolean' ||
      !['enabled', 'disabled', 'engine-disabled', 'capability-unavailable'].includes(
        decision.reason,
      )
    )
      return false;
    if (
      !Array.isArray(decision.missingCapabilities) ||
      !decision.missingCapabilities.every((name) => EXECUTION_CAPABILITY_NAMES.includes(name))
    )
      return false;
    if (decision.enabled !== (decision.reason === 'enabled')) return false;
    if ((decision.requested === false) !== (decision.reason === 'disabled')) return false;
    if (decision.requested === true && !decision.enabled) return false;
    if ((decision.reason === 'capability-unavailable') !== decision.missingCapabilities.length > 0)
      return false;
    if (worker !== 'engine' && !report.workers.engine.enabled && decision.enabled) return false;
    if (
      decision.reason === 'engine-disabled' &&
      (worker === 'engine' || report.workers.engine.enabled)
    )
      return false;
  }
  if (report.capabilities === undefined) return false;
  if (
    !EXECUTION_CAPABILITY_NAMES.every((name) => {
      const fact = report.capabilities?.[name];
      return typeof fact?.available === 'boolean' && typeof fact.reason === 'string';
    })
  )
    return false;
  if (report.render !== undefined) {
    const render = report.render;
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
    if ('capabilities' in render) {
      const capabilities = render.capabilities;
      if (
        !isRecord(capabilities) ||
        !hasExactKeys(capabilities, ['backendKind', 'compute', 'storageBuffer']) ||
        !['webgpu', 'wgpu-native', 'wgpu-webgl2', 'null'].includes(
          capabilities.backendKind as string,
        ) ||
        typeof capabilities.compute !== 'boolean' ||
        typeof capabilities.storageBuffer !== 'boolean'
      )
        return false;
    }
    if ('limits' in render) {
      const limits = render.limits;
      const maxStorageBuffersPerShaderStage = isRecord(limits)
        ? limits.maxStorageBuffersPerShaderStage
        : undefined;
      if (
        !('capabilities' in render) ||
        !isRecord(limits) ||
        !hasExactKeys(limits, ['maxStorageBuffersPerShaderStage']) ||
        typeof maxStorageBuffersPerShaderStage !== 'number' ||
        !Number.isSafeInteger(maxStorageBuffersPerShaderStage) ||
        maxStorageBuffersPerShaderStage < 0
      )
        return false;
    }
    if (
      !report.workers.render.enabled ||
      !['alive', 'rebuilding', 'failed', 'stopped'].includes(render.state)
    )
      return false;
    if (
      !Number.isSafeInteger(render.epoch) ||
      render.epoch < 1 ||
      !Number.isSafeInteger(render.submittedFrame) ||
      !Number.isSafeInteger(render.completedFrame) ||
      render.completedFrame < 0 ||
      render.submittedFrame < render.completedFrame
    )
      return false;
  }
  const engine = report.engine;
  const world = report.world;
  const dispatch = report.kernelDispatch;
  const frame = report.frame;
  const performance = report.performance;
  const audio = report.audio;
  if (!isRecord(engine) || !hasExactKeys(engine, ['realm', 'health'])) return false;
  if (engine.realm !== (report.workers.engine.enabled ? 'worker' : 'host')) return false;
  if (!['idle', 'starting', 'running', 'stopped', 'faulted'].includes(engine.health as string)) {
    return false;
  }
  if (
    !isRecord(world) ||
    !hasExactKeys(world, ['identity', 'health', 'partialWrite', 'retryable'])
  ) {
    return false;
  }
  if (world.identity !== null && typeof world.identity !== 'string') return false;
  if (!['healthy', 'poisoned'].includes(world.health as string)) return false;
  if (typeof world.partialWrite !== 'boolean' || typeof world.retryable !== 'boolean') return false;
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
  if (!Number.isInteger(dispatch.dispatched) || !Number.isInteger(dispatch.completed)) return false;
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
  if (
    frame.completed > frame.submitted ||
    frame.inFlight !== frame.submitted - frame.completed ||
    frame.highWater < frame.inFlight
  )
    return false;
  if (
    !isRecord(performance) ||
    !hasExactKeys(performance, ['hostFrameMs', 'engineUpdateMs', 'kernelWaitMs', 'hostAudioMs'])
  )
    return false;
  for (const key of ['hostFrameMs', 'engineUpdateMs', 'kernelWaitMs', 'hostAudioMs'] as const) {
    const measurement = performance[key];
    if (measurement !== null && !isMeasurement(measurement)) return false;
  }
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
  if ('streaming' in audio) {
    const counters = [
      'encodedBytes',
      'pcmBytes',
      'pendingBytes',
      'pendingReads',
      'underruns',
    ] as const;
    if (!isRecord(audio.streaming) || !hasExactKeys(audio.streaming, counters)) return false;
    for (const key of counters) {
      if (!Number.isInteger(audio.streaming[key]) || (audio.streaming[key] as number) < 0)
        return false;
    }
  }
  if ('music' in audio && !isMusicState(audio.music)) return false;
  if ('cache' in audio) {
    const counters = [
      'sources',
      'encodedBytes',
      'decodedBytes',
      'bytesHighWater',
      'pendingPlays',
    ] as const;
    if (!isRecord(audio.cache) || !hasExactKeys(audio.cache, counters)) return false;
    for (const key of counters)
      if (!Number.isSafeInteger(audio.cache[key]) || (audio.cache[key] as number) < 0) return false;
  }
  if (audio.lastError !== null) {
    if (!isRecord(audio.lastError)) return false;
    if (!hasExactKeys(audio.lastError, ['code', 'expected', 'hint', 'detail'])) return false;
    if (
      typeof audio.lastError.code !== 'string' ||
      typeof audio.lastError.expected !== 'string' ||
      typeof audio.lastError.hint !== 'string'
    )
      return false;
  }
  if (report.fault !== null) {
    if (!isRecord(report.fault)) return false;
    if (
      !hasExactKeys(report.fault, [
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
        report.fault.source as string,
      )
    )
      return false;
    if (
      typeof report.fault.code !== 'string' ||
      typeof report.fault.expected !== 'string' ||
      typeof report.fault.hint !== 'string'
    )
      return false;
    if (
      typeof report.fault.partialWrite !== 'boolean' ||
      typeof report.fault.retryable !== 'boolean'
    )
      return false;
  }
  return true;
}
