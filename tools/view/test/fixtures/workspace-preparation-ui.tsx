import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Dialog } from '@forgeax/view-components';
import '@forgeax/view-components/styles.css';
import '../../packages/viewer/src/styles.css';
import { WorkspacePreparationStatus } from '../../packages/viewer/src/shell/WorkspacePreparationStatus';
import { setLocale } from '../../packages/viewer/src/i18n';
import type { WorkspaceState } from '../../packages/view-workspace-core/src/contract';
import type { HostConnection } from '../../packages/viewer/src/shell/HostConnectionIndicator';

setLocale('en');
let state: WorkspaceState = { revision: 1, projectStatus: {
  phase: 'preparing', sessionId: 'project-A', generation: 1,
  preparation: { generation: 1, stage: 'produce', startedAt: Date.now() - 22000,
    updatedAt: Date.now(), activeCount: 2,
    active: [
      { source: 'assets/environment/very-long-unbroken-asset-name-with-many-material-permutations-and-texture-inputs.pack.ts', phase: 'cook', startedAt: Date.now() - 5000 },
      { source: 'assets/lighting.pack.ts', phase: 'persist', startedAt: Date.now() - 1000 },
    ], recent: [{ source: 'assets/geometry.pack.ts', cacheHit: true }] },
} };
const completedStatus = () => ({ ...state.projectStatus!, phase: 'starting' as const, document: {
  sessionId: 'project-A', targetId: 'scene', url: 'http://localhost/project', browserGeneration: 0,
}, browserGeneration: 0, preparation: { ...state.projectStatus!.preparation!,
  stage: 'ready' as const, updatedAt: Date.now(), activeCount: 0, active: [] } });
if (new URLSearchParams(location.search).has('completed')) state.projectStatus = completedStatus();
const listeners = new Set<(value: WorkspaceState) => void>();
const client = {
  subscribe(listener: (value: WorkspaceState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async getState() { return state; },
};
const root = createRoot(document.getElementById('app')!);
let showChooser: () => void;
function Fixture({ phase }: { phase: HostConnection['phase'] }) {
  const [chooser, setChooser] = useState(false);
  showChooser = () => setChooser(true);
  return <>
    <button type="button" style={{ position: 'fixed', right: 16, bottom: 90 }}
      onClick={event => { event.currentTarget.textContent = 'Underlying control clicked'; }}>Underlying control</button>
    <WorkspacePreparationStatus client={client} connection={{ phase }} />
    {chooser && <Dialog open modal={false} className="fx-view-project-open" title="Open project"
      style={{ position: 'fixed', inset: 'auto 16px 32px auto', margin: 0 }}>
      <button type="button" onClick={() => setChooser(false)}>Choose project</button>
    </Dialog>}
  </>;
}
const render = (phase: HostConnection['phase'] = 'connected') => root.render(<Fixture phase={phase} />);
const publish = (projectStatus: WorkspaceState['projectStatus']) => {
  state = { ...state, revision: (state.revision ?? 0) + 1, projectStatus };
  for (const listener of listeners) listener(state);
};
render();
Object.assign(globalThis, { preparationFixture: {
  locale: setLocale,
  beforePack: () => publish({ phase: 'preparing', sessionId: 'project-A', generation: 1,
    preparation: { generation: 0, stage: 'vite', operation: 'vite-server', startedAt: Date.now() - 42000,
      updatedAt: Date.now(), activeCount: 0, active: [], recent: [] } }),
  shader: () => publish({ phase: 'preparing', sessionId: 'project-A', generation: 1,
    preparation: { generation: 0, stage: 'shader', startedAt: Date.now() - 42000, updatedAt: Date.now(), activeCount: 1,
      active: [{ source: 'engine/default-standard-pbr.wgsl', phase: 'shader', startedAt: Date.now() - 1000, progress: { completed: 12, total: 128 } }], recent: [] } }),
  offline: () => render('disconnected'),
  reconnect: () => render(),
  nextTask: () => publish({ ...state.projectStatus!, preparation: {
    generation: 2, stage: 'produce', startedAt: Date.now(), updatedAt: Date.now(), activeCount: 1,
    active: [{ source: 'assets/changed.pack.ts', phase: 'cook', startedAt: Date.now() }], recent: [],
  } }),
  switchProject: () => publish({ phase: 'preparing', sessionId: 'project-C', generation: 3 }),
  ready: () => publish(completedStatus()),
  failed: () => publish({ phase: 'failed', sessionId: 'project-A', generation: 1,
    preparation: { ...state.projectStatus!.preparation!, stage: 'failed', updatedAt: Date.now() },
    failure: { code: 'native-cook-failed', expected: 'Material inputs must be valid', hint: 'Repair assets/lighting.pack.ts' } }),
  engineConflict: () => publish({ phase: 'failed', sessionId: 'project-B', generation: 2,
    failure: { code: 'host-assembly-invalid', expected: 'the project and View Host to use the same Engine build',
      hint: "Start View from the project's own Engine installation.",
      detail: { reason: 'frontend Engine source conflict for @forgeax/engine: host=/source/engine; project=/games/meadow/node_modules/@forgeax/engine.' } } }),
  chooser: () => showChooser(),
  clear: () => publish(null),
} });
