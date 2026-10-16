import '@forgeax/view-components/styles.css';
import './styles.css';
import '@forgeax/view-plugin-display/ui';

import { mountContentBrowserPanel } from '@forgeax/view-plugin-content-browser/ui';
import { mountInspectorPanel } from '@forgeax/view-plugin-inspector/ui';
import { mountMaterialPanel, mountMaterialPreviewPanel, mountMaterialPropertiesPanel } from '@forgeax/view-plugin-material/ui';
import { mountMeshPreviewPanel, mountMeshPropertiesPanel } from '@forgeax/view-plugin-mesh/ui';
import { mountTexturePreviewPanel, mountTexturePropertiesPanel } from '@forgeax/view-plugin-texture/ui';
import { mountAssetPropertiesPanel } from '@forgeax/view-plugin-asset/ui';
import { mountPluginsPanel } from '@forgeax/view-plugin-plugins/ui';
import { mountSceneTreePanel } from '@forgeax/view-plugin-scene-tree/ui';
import { mountHtmlUiPreviewPanel, mountHtmlUiInspectorPanel } from '@forgeax/view-plugin-html/ui';

export {
  mountContentBrowserPanel,
  mountInspectorPanel,
  mountMaterialPanel,
  mountMaterialPreviewPanel,
  mountMaterialPropertiesPanel,
  mountMeshPreviewPanel,
  mountMeshPropertiesPanel,
  mountTexturePreviewPanel,
  mountTexturePropertiesPanel,
  mountAssetPropertiesPanel,
  mountPluginsPanel,
  mountSceneTreePanel,
  mountHtmlUiPreviewPanel,
  mountHtmlUiInspectorPanel,
};
import '@forgeax/view-plugin-history/ui';
