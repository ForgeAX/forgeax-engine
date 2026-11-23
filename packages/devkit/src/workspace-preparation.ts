import type {
  EngineWorkspaceProjectHandle,
  EngineWorkspaceProjectPreparation,
} from '@forgeax/engine-app';
import type {
  PluginPackProgress,
  PluginPackSourceProgress,
} from '@forgeax/engine-vite-plugin-pack';
import type { ShaderPreparationProgress } from '@forgeax/engine-vite-plugin-shader';

export function runningWorkspaceTarget(project: EngineWorkspaceProjectHandle | undefined) {
  const status = project?.status;
  return status?.phase === 'running' ? status.target : undefined;
}

/** Bounded presentation projection, not a producer queue or readiness authority. */
export function createWorkspacePreparation(changed: () => void) {
  let snapshot: EngineWorkspaceProjectPreparation | undefined;
  const active = new Map<string, EngineWorkspaceProjectPreparation['active'][number]>();
  const cacheHits = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!closed) {
      try {
        changed();
      } catch {
        // A delayed presentation notification cannot crash the producer host.
      }
    }
  };
  const initialize = (generation: number): EngineWorkspaceProjectPreparation => ({
    generation,
    stage: 'project',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    activeCount: 0,
    active: [],
    recent: [],
  });
  const settled = () =>
    snapshot !== undefined && ['ready', 'failed', 'cancelled'].includes(snapshot.stage);
  const acceptsProgress = (event: PluginPackProgress): boolean => {
    if (closed || (snapshot !== undefined && event.generation < snapshot.generation)) return false;
    return !(
      snapshot?.generation === event.generation &&
      event.kind === 'source' &&
      event.source.phase === 'ready' &&
      settled()
    );
  };
  const startNextTask = () => {
    if (snapshot === undefined || !settled()) return;
    active.clear();
    cacheHits.clear();
    snapshot = initialize(snapshot.generation);
  };
  const visibleActive = (): EngineWorkspaceProjectPreparation['active'] => {
    const tasks: EngineWorkspaceProjectPreparation['active'][number][] = [];
    for (const task of active.values()) {
      tasks.push(task);
      if (tasks.length === 8) break;
    }
    return tasks;
  };
  const observeSource = (
    { sourcePath, phase, cache }: PluginPackSourceProgress,
    now: number,
    recent: EngineWorkspaceProjectPreparation['recent'],
  ): EngineWorkspaceProjectPreparation['recent'] => {
    if (cache === 'hit') cacheHits.add(sourcePath);
    if (phase === 'ready') {
      active.delete(sourcePath);
      return [
        { source: sourcePath, cacheHit: cacheHits.delete(sourcePath) },
        ...recent.filter((task) => task.source !== sourcePath),
      ].slice(0, 5);
    }
    active.set(sourcePath, {
      source: sourcePath,
      phase,
      startedAt: active.get(sourcePath)?.startedAt ?? now,
    });
    return recent;
  };
  const project = (
    stage: EngineWorkspaceProjectPreparation['stage'],
    operation?: EngineWorkspaceProjectPreparation['operation'],
  ) => {
    if (closed) return;
    const prior = snapshot ?? initialize(0);
    snapshot = {
      generation: prior.generation,
      stage,
      startedAt: prior.startedAt,
      updatedAt: Date.now(),
      activeCount: active.size,
      active: visibleActive(),
      recent: prior.recent,
      ...(operation === undefined ? {} : { operation }),
    };
  };
  return {
    read: () => snapshot,
    host(operation: NonNullable<EngineWorkspaceProjectPreparation['operation']>) {
      if (closed) return;
      if (
        operation === 'scene-connection' &&
        (active.size > 0 ||
          (snapshot !== undefined && snapshot.generation > 0 && snapshot.stage !== 'ready'))
      )
        return;
      if (operation !== 'scene-connection') startNextTask();
      project(
        operation === 'scene-connection'
          ? 'ready'
          : operation === 'shader-inputs'
            ? 'shader'
            : operation === 'vite-server'
              ? 'vite'
              : 'project',
        operation,
      );
      if (!closed) flush();
    },
    shader(event: ShaderPreparationProgress) {
      if (closed) return;
      if (event.phase === 'ready' && settled()) return;
      if (event.phase !== 'ready') startNextTask();
      if (event.phase === 'inputs') {
        project('shader', 'shader-inputs');
        flush();
        return;
      }
      const { sourcePath, completed, total } = event;
      snapshot ??= initialize(0);
      if (event.phase === 'ready') {
        active.delete(sourcePath);
        snapshot = {
          ...snapshot,
          recent: [
            { source: sourcePath, cacheHit: false },
            ...snapshot.recent.filter((task) => task.source !== sourcePath),
          ].slice(0, 5),
        };
      } else
        active.set(sourcePath, {
          source: sourcePath,
          phase: 'shader',
          startedAt: active.get(sourcePath)?.startedAt ?? Date.now(),
          progress: { completed, total },
        });
      project('shader');
      timer ??= setTimeout(flush, 200);
    },
    observe(event: PluginPackProgress) {
      if (!acceptsProgress(event)) return;
      const now = Date.now();
      if (
        (event.kind === 'source' && event.source.phase !== 'ready') ||
        (event.kind === 'stage' && (event.stage === 'inventory' || event.stage === 'publish'))
      )
        startNextTask();
      if (snapshot === undefined || event.generation > snapshot.generation) {
        active.clear();
        cacheHits.clear();
        snapshot = {
          generation: event.generation,
          stage: 'inventory',
          startedAt: snapshot?.generation === 0 ? snapshot.startedAt : now,
          updatedAt: now,
          activeCount: 0,
          active: [],
          recent: [],
        };
      }
      let stage = snapshot.stage;
      let recent = snapshot.recent;
      if (event.kind === 'stage') {
        stage = event.stage;
        if (stage === 'ready' || stage === 'cancelled') active.clear();
      } else {
        stage = 'produce';
        recent = observeSource(event.source, now, recent);
      }
      snapshot = {
        ...snapshot,
        stage,
        updatedAt: now,
        activeCount: active.size,
        active: visibleActive(),
        recent,
      };
      if (event.kind === 'stage') flush();
      else timer ??= setTimeout(flush, 200);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      active.clear();
      cacheHits.clear();
    },
  };
}
