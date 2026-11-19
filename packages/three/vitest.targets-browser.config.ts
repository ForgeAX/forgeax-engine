import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine/vite-plugin-shader';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../../config/vitest-browser-project';

// This owner has no point-shadow workload. Keep the maintained Browser provider,
// sandbox, source aliases, lifecycle guards and pixel/frame deadlines; request
// the complete native base profile rather than preparing an unused point roster.
const project = createBrowserProject();
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    projects: [{
      ...project,
      plugins: project.plugins.map((plugin) =>
        plugin !== null && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'forgeax:shader'
          ? forgeaxShader({ engineEntries: { pointShadows: false, hdrpSsao: true }, materialPackages: [] })
          : plugin,
      ),
    }],
  },
});
