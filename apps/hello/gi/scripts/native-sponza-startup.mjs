import {
  beginLoadSession,
  beginLoadWork,
  describeLoadProgress,
  endLoadSession,
  readLoadProgress,
  resolveLoadProgressLabels,
} from '@forgeax/engine-app';

const stages = [
  { id: 'catalog', label: 'Read asset catalog', weight: 5 },
  { id: 'renderer', label: 'Initialize graphics and UI', weight: 10 },
  { id: 'scene-assets', label: 'Load Sponza assets', weight: 15 },
  { id: 'scene-setup', label: 'Set up the scene', weight: 5 },
  { id: 'scene-frame', label: 'Present first scene frame', weight: 15 },
  { id: 'field', label: 'Prepare Irradiance Field', weight: 25 },
  { id: 'screen-probe', label: 'Prepare Screen Probe', weight: 20 },
  { id: 'gi-frame', label: 'Complete first GI frame', weight: 5 },
];

export function createNativeSponzaStartup(mode, startedAt, now = () => performance.now()) {
  const selected = stages.filter(({ id }) =>
    mode === 'off' ? !['field', 'screen-probe', 'gi-frame'].includes(id) :
      mode !== 'screen-probe' ? id !== 'screen-probe' : true);
  const labels = resolveLoadProgressLabels({
    phases: Object.fromEntries(selected.map(({ id, label }) => [id, label])),
  });
  const timing = new Map();
  let outcome = 'loading';
  let finishedAt;
  beginLoadSession('startup', selected.map(({ id, weight }) => ({ id, weight, bounded: true })), { startedAt });

  function begin(id, at = now()) {
    if (timing.has(id) || !selected.some((stage) => stage.id === id)) return;
    timing.set(id, { start: at, complete: beginLoadWork(id), end: undefined });
  }

  function finish(id, at = now()) {
    const stage = timing.get(id);
    if (!stage || stage.end !== undefined) return;
    stage.end = at;
    stage.complete();
  }

  function snapshot() {
    const at = finishedAt ?? now();
    const elapsedMs = at - startedAt;
    return {
      outcome,
      elapsedMs,
      progress: describeLoadProgress({ ...readLoadProgress(), elapsedMs }, labels),
      stages: selected.map(({ id, label }) => {
        const stage = timing.get(id);
        return {
          id,
          label,
          state: stage === undefined ? 'pending' : stage.end !== undefined ? 'done' :
            outcome === 'loading' ? 'active' : 'interrupted',
          elapsedMs: stage === undefined ? undefined : (stage.end ?? at) - stage.start,
        };
      }),
    };
  }

  return {
    begin,
    finish,
    snapshot,
    get loading() { return outcome === 'loading'; },
    beginSceneFrames() {
      begin('scene-frame');
      begin('field');
      begin('screen-probe');
    },
    observeFrame({ presentationReady, qualified, diffuseGi }, drawStarted, at) {
      if (outcome !== 'loading') return;
      if (presentationReady) finish('scene-frame', at);
      if (diffuseGi.fieldState === 'ready') finish('field', at);
      if (diffuseGi.state === 'ready') finish('screen-probe', at);
      if (!qualified) return;
      // The accepted GI receipt proves both producers were available for this frame.
      finish('field', at);
      finish('screen-probe', at);
      begin('gi-frame', drawStarted);
      finish('gi-frame', at);
      outcome = 'ready';
      finishedAt = at;
      endLoadSession('startup');
    },
    stop(reason) {
      if (outcome !== 'loading') return;
      outcome = reason;
      finishedAt = now();
    },
    dispose() {
      endLoadSession('startup');
    },
  };
}
