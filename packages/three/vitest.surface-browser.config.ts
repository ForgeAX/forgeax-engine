import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine/vite-plugin-shader';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../../config/vitest-browser-project';

// These surface fixtures use directional shadows only. Preserve the maintained
// Browser provider/sandbox and complete BASE profile without compiling unused
// point-shadow programs. Fixture assertions and completed-frame budgets are unchanged.
const project = createBrowserProject();
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    projects: [
      {
        ...project,
        plugins: project.plugins.map((plugin) =>
          plugin !== null &&
          typeof plugin === 'object' &&
          'name' in plugin &&
          plugin.name === 'forgeax:shader'
            ? forgeaxShader({
                engineEntries: { pointShadows: false, hdrpSsao: true },
                materialPackages: [],
              })
            : plugin,
        ),
      },
    ],
  },
});
