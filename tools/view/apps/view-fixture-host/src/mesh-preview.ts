import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { selectWorkspaceResourceSubject } from '@forgeax/view-workspace-core/resource-open';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import './mesh-preview.css';

export function mountMeshPreviewPanel({ mountElement, client }: { mountElement: HTMLElement; client?: ViewWorkspaceClient }) {
  const document = mountElement.ownerDocument;
  const panel = document.createElement('div');
  panel.className = 'fx-asset-viewer fx-asset-preview fx-fixture-mesh-preview fx-ui';
  panel.dataset.testid = 'panel-mesh-preview';

  const empty = document.createElement('div');
  empty.className = 'fx-empty';
  const title = document.createElement('strong');
  const description = document.createElement('p');
  empty.append(title, description);
  panel.append(empty);
  mountElement.append(panel);

  const reader = createWorkspaceStateReader(client);
  const render = () => {
    const asset = selectWorkspaceResourceSubject(reader.getSnapshot(), ['mesh']);
    title.textContent = asset?.name ?? 'Mesh preview';
    description.textContent = asset
      ? 'Fixture mesh data has no rendered preview.'
      : 'Open a mesh from the Content Browser.';
  };
  const unsubscribe = reader.subscribe(render);
  render();
  return () => {
    unsubscribe();
    reader.dispose();
    panel.remove();
  };
}
