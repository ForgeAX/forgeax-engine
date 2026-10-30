import { resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from './config/vitest-browser-project';
import { playwrightWithBackgroundPages } from './config/vitest-browser-provider';
import { dawnProject } from './config/vitest-dawn-project';
import { REPOSITORY_ROOT, sharedVitestConfig } from './config/vitest-shared';

// Root vitest config - declares projects per K-3 split policy:
//
//   - unit layer (per-package + apps + scripts; each retains its own
//     defineProject config). Auto-discovered via globs `packages/*` /
//     `apps/*` / `scripts`; project names like `@forgeax/engine-math` /
//     `@forgeax/engine-runtime`. The inline `name: 'unit'` marker project below is
//     the K-3 three-command SSOT naming anchor (grep gate: vitest.config.ts
//     discovers the named projects through their canonical config modules) plus
//     the explicit `--project unit` filter entry; the marker itself runs
//     passWithNoTests, producing no new test work.
//   - browser layer (AC-05): vitest browser mode + playwright provider;
//     file-naming convention `*.browser.test.ts`.
//   - dawn layer (AC-06): dawn.node native binding; setup-webgpu.ts injects
//     globalThis.navigator.gpu; file-naming convention `*.dawn.test.ts`.
//
// Command split (K-3 + AGENTS.md commands):
//   - `pnpm test`         = alias `test:unit` (fastest PR feedback path)
//   - `pnpm test:unit`    = `vitest run --project '!browser' --project '!dawn'`
//                          (per-package + marker 'unit' coverage; leaves
//                          dawn/browser untouched)
//   - `pnpm test:browser` = the entity-visibility process plus
//     `scripts/ci/run-split-vitest-browser.mjs` (fresh bounded processes)
//   - `pnpm test:dawn`    = ordinary Dawn project, the isolated renderer
//                          integration process, plus the partitioned
//                          direct-light Dawn runner (each heavy group gets a
//                          fresh native process)
//   - `pnpm test:all`     = three commands serial (K-3 warning: do NOT
//                          fold into the root `pnpm test`, otherwise a
//                          single chromium / dawn launch failure pollutes
//                          the unit feedback channel)
//
// v4 essentials (research Finding 2.1):
//   - `provider: playwrightWithBackgroundPages()` factory (not the v3 string
//     form); headed Chromium pages stay out of the foreground by default,
//     with FORGEAX_BROWSER_BACKGROUND=0 restoring normal activation
//   - `instances: [{ browser: 'chromium' }]` at minimum one entry
//     (the v3 `browser.name` string short-circuit is removed)
//   - launchOptions.headless is force-ignored -> use `test.browser.headless`
//   - test code imports from `vitest/browser`
//     (not the v3 `@vitest/browser/context`)
//
// Cross-isolation (M2.6 / R10): the dawn project runs node env + dedicated
// setup file; sharing globalThis with unit / browser is mitigated through
// `afterAll` teardown that drops the gpu reference, easing chromium issue
// 387965810 (globalThis.navigator.gpu global pollution preventing node
// process exit).
export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    projects: [
      // -- unit layer: existing per-package + apps + scripts --
      'packages/*',
      'apps/*',
      'apps/showcase/*',
      // game-default owns small pure contract tests for authored template
      // assets; browser-marked HUD tests remain owned by the browser project.
      resolve(REPOSITORY_ROOT, 'apps/game-capability-lab'),
      // feat-20260515 M4 D-6: nested learn-render workspaces register
      // through the dual-segment glob (pnpm-workspace.yaml#packages
      // mirror). The vitest config form points at each workspace's
      // vite.config.ts so vitest does not try to load `.gitkeep`
      // siblings (other section-* dirs are placeholders awaiting future
      // feats). Without this entry the 7 LearnOpenGL section-1.*
      // placeholder tests (M4 scaffold; M5-M11 fill the real e2e) are
      // skipped under `pnpm test:unit`, and the metrics:check workspace
      // set drifts from the vitest project set (architecture principle
      // #1 SSOT).
      'apps/learn-render/1.getting-started/*/vite.config.ts',
      'apps/hello/triangle',
      'apps/hello/lod-occlusion',
      {
        test: {
          name: '@forgeax/hello-boss-lightning',
          include: [
            'apps/hello/boss-lightning/src/__tests__/*.unit.test.ts',
            'apps/hello/boss-lightning/src/__tests__/*.integration.test.ts',
          ],
        },
      },
      // The nested hello workspace is not covered by the `apps/*` glob. Keep
      // the physical-material contract tests in a Node-only project so the
      // unit gate does not load its Vite/WebGPU application entrypoint.
      {
        test: {
          name: '@forgeax/hello-physical-material',
          include: ['apps/hello/physical-material/src/__tests__/*.test.ts'],
          environment: 'node',
          typecheck: { enabled: false },
        },
      },
      {
        test: {
          name: '@forgeax/hello-fxaa',
          environment: 'node',
          include: [
            'apps/hello/fxaa/src/__tests__/*.unit.test.ts',
            'apps/hello/fxaa/src/__tests__/dark-gradient-backend.test.ts',
            'apps/hello/fxaa/src/__tests__/dark-gradient-fixture.test.mjs',
          ],
          typecheck: { enabled: false },
        },
      },
      'scripts',
      // K-3 naming anchor (marker; passWithNoTests means `--project unit`
      // does not produce a failure signal, it only acts as the SSOT
      // command-entry semantic placeholder).
      {
        test: {
          name: 'unit',
          include: [],
          passWithNoTests: true,
        },
      },
      // -- ecs-perf: named performance project (D-1) --
      //
      // Sole owner of the tracked ECS performance workloads. The project name
      // deliberately sits outside the @forgeax/* wildcard
      // so wildcard scripts (test, test:unit, test:type) never select it.
      // No passWithNoTests — an empty population must fail loudly rather
      // than pass silently, so the validator can catch a missing include.
      {
        test: {
          name: 'ecs-perf',
          environment: 'node',
          // The benchmark deliberately samples 31 rounds of 50k updates.
          // Keep runner contention from turning a passing ratio into a
          // default-5s timeout red while retaining a bounded CI budget.
          testTimeout: 30000,
          include: ['packages/ecs/src/**/*.perf.test.ts'],
        },
      },
      // -- render-perf: named render performance project --
      //
      // Keep render wall-clock benchmarks out of the V8 coverage project.
      // Coverage instrumentation changes hot-loop timing, while this project
      // preserves the uninstrumented performance signal alongside ecs-perf.
      {
        test: {
          name: 'render-perf',
          environment: 'node',
          include: [
            'packages/render/src/**/*.perf.test.ts',
            'packages/render/src/**/render-perf/*.bench.test.ts',
          ],
        },
      },
      createBrowserProject(),
      // -- browser-no-webgpu layer: chromium WITHOUT WebGPU flags --
      //
      // feat-20260525-rhi-delete-webgl2-stub M4: verifies that when
      // navigator.gpu is absent (chromium launched without --enable-unsafe-webgpu),
      // createRenderer does NOT silently return a no-op renderer (old channel 4).
      // Acceptable outcomes: either channel 3 (rhi-wgpu wasm with internal
      // webgl backend) succeeds, OR createRenderer throws EngineEnvironmentError
      // (loud failure, not silent). File convention: *.browser-no-webgpu.test.ts.
      {
        plugins: [forgeaxShader()],
        test: {
          name: 'browser-no-webgpu',
          include: ['**/*.browser-no-webgpu.test.ts'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.worktrees/**',
            '**/.claude/worktrees/**',
          ],
          browser: {
            enabled: true,
            provider: playwrightWithBackgroundPages({
              launchOptions: {
                channel: 'chrome-beta',
                chromiumSandbox: true,
                args: [
                  '--disable-features=WebGPU,WebGPUService,MacAppCodeSignClone',
                  '--disable-gpu-driver-bug-workarounds',
                  // Match the explicit software WebGL2 carrier probed by CI.
                  // Local runs keep their physical GPU route.
                  ...(process.env.CI ? ['--disable-gpu', '--enable-unsafe-swiftshader'] : []),
                ],
              },
            }),
            instances: [{ browser: 'chromium' }],
            headless: !!process.env.CI,
          },
        },
      },
      dawnProject,
    ],
  },
});
