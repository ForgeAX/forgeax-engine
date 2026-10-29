import type { RenderPipelineTopology } from '../render-pipeline';

/** Stock recorders read these parameters from the current frame, not the build closure. */
export function frameGraphTopologyIdentity(
  topology: RenderPipelineTopology,
  stockRecorder: boolean,
) {
  const camera = { ...topology.camera, bloomIntensity: undefined };
  if (!stockRecorder) return { ...topology, camera };
  return {
    ...topology,
    camera,
    ...(topology.transmissionDemand === undefined
      ? {}
      : {
          transmissionDemand: {
            ...topology.transmissionDemand,
            // The backdrop declares one copy/mip chain regardless of draw count.
            activeCount: topology.transmissionDemand.activeCount === 0 ? 0 : 1,
          },
        }),
    ...(topology.ssr === undefined || topology.ssr.status === 'admitted'
      ? {}
      : { ssr: { ...topology.ssr, viewRange: undefined } }),
  };
}

/** Bounded before/after values of the dependencies a compile changed (diagnostic only). */
export function frameGraphChangedValues(
  previousKey: string | undefined,
  nextKey: string,
  dependencies: readonly string[],
  limit = 4,
  chars = 400,
): readonly { readonly dependency: string; readonly before: string; readonly after: string }[] {
  if (previousKey === undefined) return [];
  try {
    const previous = JSON.parse(previousKey) as Record<string, Record<string, unknown>>;
    const next = JSON.parse(nextKey) as Record<string, Record<string, unknown>>;
    const read = (key: Record<string, Record<string, unknown>>, dependency: string) => {
      const value = dependency.startsWith('topology.')
        ? key.topology?.[dependency.slice('topology.'.length)]
        : (key as Record<string, unknown>)[dependency];
      return (JSON.stringify(value) ?? 'undefined').slice(0, chars);
    };
    return dependencies.slice(0, limit).map((dependency) => ({
      dependency,
      before: read(previous, dependency),
      after: read(next, dependency),
    }));
  } catch {
    return [];
  }
}

/** Compare detached canonical keys only on a miss; never inspect live authoring twice. */
export function frameGraphChangedDependencies(
  previousKey: string | undefined,
  nextKey: string,
): readonly string[] {
  if (previousKey === undefined) return ['cold'];
  let previous: Record<string, unknown>;
  let next: Record<string, unknown>;
  try {
    previous = JSON.parse(previousKey);
    next = JSON.parse(nextKey);
    if (
      previous === null ||
      next === null ||
      typeof previous !== 'object' ||
      typeof next !== 'object'
    )
      return ['invalid-key'];
  } catch {
    return ['invalid-key'];
  }
  const changed: string[] = [];
  const compare = (left: Record<string, unknown>, right: Record<string, unknown>, prefix = '') => {
    for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (JSON.stringify(left[name]) !== JSON.stringify(right[name])) changed.push(prefix + name);
    }
  };
  compare(
    (previous.topology as Record<string, unknown>) ?? {},
    (next.topology as Record<string, unknown>) ?? {},
    'topology.',
  );
  delete previous.topology;
  delete next.topology;
  compare(previous, next);
  return changed.length === 0 ? ['serialization'] : changed;
}
