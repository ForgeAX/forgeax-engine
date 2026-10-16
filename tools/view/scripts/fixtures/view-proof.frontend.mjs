// Browser qualification only: expose owned native Fibers to the probe.
import root from 'forgeax-view/viewer/root/frontend';
import scene from 'forgeax-view/plugins/scene/frontend';
import display from 'forgeax-view/plugins/display/frontend';
import viewport from 'forgeax-view/plugins/viewport/frontend';
import content from 'forgeax-view/plugins/content-browser/frontend';
import inspector from 'forgeax-view/plugins/inspector/frontend';
import tree from 'forgeax-view/plugins/scene-tree/frontend';
import plugins from 'forgeax-view/plugins/plugins/frontend';
import material from 'forgeax-view/plugins/material/frontend';
import mesh from 'forgeax-view/plugins/mesh/frontend';
import texture from 'forgeax-view/plugins/texture/frontend';
import asset from 'forgeax-view/plugins/asset/frontend';
import { startNativePlugin, inspectPluginFiber } from '@forgeax/engine/plugin';

const implementations = [scene, display, viewport, content, inspector, tree, plugins, material, mesh, texture, asset];
export default {
  ...root,
  apply(ctx, config) {
    root.apply(ctx, config);
    const owned = fiber => {
      for (let cursor = fiber; cursor !== cursor.parent.fiber; cursor = cursor.parent.fiber) {
        if (cursor === ctx.fiber) return true;
      }
      return false;
    };
    const proof = {
      async remove(names) {
        for (const runtime of ctx.registry.values()) for (const fiber of [...runtime.fibers]) {
          if (names.includes(runtime.name) && owned(fiber)) await fiber.dispose();
        }
      },
      async restore(names) {
        for (const name of names) {
          const plugin = implementations.find(plugin => plugin.name === name);
          if (!plugin) throw new Error(`Unknown fixture plugin ${name}`);
          const result = await startNativePlugin(ctx, plugin, config);
          if (!result.ok) throw new Error(JSON.stringify(result.error));
        }
      },
      inspect() {
        return [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].filter(owned).map(inspectPluginFiber));
      },
    };
    globalThis.__forgeaxViewTest = proof;
    ctx.effect(() => () => { if (globalThis.__forgeaxViewTest === proof) delete globalThis.__forgeaxViewTest; });
  },
};
