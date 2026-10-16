import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from './config/vitest-browser-project';
import { playwrightWithBackgroundPages } from './config/vitest-browser-provider';
import { DawnSequencer } from './config/vitest-dawn-sequencer';
import { DAWN_COMPACT_TEST_FILES } from './scripts/ci/dawn-compact-roster.mjs';
import {
  DAWN_ISOLATED_TEST_FILES,
  DIRECT_LIGHT_DAWN_TEST_FILE,
} from './scripts/ci/dawn-gate-roster.mjs';

// Every exclusion is derived from the same roster used by local, PR and nightly.
const R32FLOAT_CAPABILITY_GENERATION_TEST =
  'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
const RUNNING_DIRECT_LIGHT_PARTITION = process.env.FORGEAX_DAWN_PARTITION !== undefined;
const RUNNING_DAWN_COMPACT = process.env.FORGEAX_DAWN_COMPACT === '1';
const RUNNING_DAWN_ISOLATED = process.env.FORGEAX_DAWN_ISOLATED === '1';
const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url));

// Root vitest config - declares projects per K-3 split policy:
//
//   - unit layer (per-package + apps + scripts; each retains its own
//     defineProject config). Auto-discovered via globs `packages/*` /
//     `apps/*` / `scripts`; project names like `@forgeax/engine-math` /
//     `@forgeax/engine-runtime`. The inline `name: 'unit'` marker project below is
//     the K-3 three-command SSOT naming anchor (grep gate: vitest.config.ts
//     must contain 'unit' / 'browser' / 'dawn' literal name fields) plus
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
  root: REPOSITORY_ROOT,
  test: {
    globals: false,
    sequence: { sequencer: DawnSequencer },
    passWithNoTests: true,
    teardownTimeout: 500,
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
                  '--disable-features=WebGPU,MacAppCodeSignClone',
                  '--disable-gpu-driver-bug-workarounds',
                ],
              },
            }),
            instances: [{ browser: 'chromium' }],
            headless: !!process.env.CI,
          },
        },
      },
      // -- dawn layer: dawn.node native binding (AC-06) --
      //
      // The `**/*.dawn.test.ts` glob picks every dawn test under the repo,
      // but feat-20260511-rhi-wgpu-impl M4 (w24) also explicitly lists the
      // rhi-wgpu integration test path in the include array so the package
      // surface is grep-discoverable from this config file alone (charter
      // proposition 1 progressive disclosure: single-import / single-config
      // anchor lets AI users locate the dawn project participants without
      // walking the filesystem). feat-20260531-render-consume-global-transform-
      // hierarchy M3 (w13) likewise lists the transform-hierarchy AC-08
      // parent-moves-child-follows pixel-diff so `pnpm test:dawn` visibly
      // includes the visual-evidence path (the CI smoke step runs the
      // apps/hello/transform-hierarchy/scripts/smoke-dawn.mjs counterpart).
      {
        test: {
          name: 'dawn',
          environment: 'node',
          // Keep cold native startup within the existing allowance. A failing
          // renderer journey reports once instead of replaying its full setup
          // and teardown twice before the owning error becomes visible.
          testTimeout: 30000,
          retry: 0,
          // Native Dawn queue/device teardown can take longer than the root
          // 500 ms budget on the heavy runner after a dense carrier finishes.
          // Keep the bound tight but allow the worker to close cleanly instead
          // of turning completed assertions into a Vitest worker-exit error.
          teardownTimeout: 5000,
          // Dawn tests use a shared software Vulkan backend. Keep this project
          // to one worker: the 96-vCPU heavy runners can otherwise launch
          // multiple GPU processes and lose workers under lavapipe contention.
          maxWorkers: 1,
          include: [
            '**/*.dawn.test.ts',
            'packages/rhi-wgpu/src/__tests__/**/*.dawn.test.ts',
            'packages/runtime/src/__tests__/transform-hierarchy-pixel-diff.dawn.test.ts',
            // feat-20260707 M5 / w32: the equirect BC6H HDR-chain integration
            // test needs the dawn-node GPU env to read texture-compression-bc
            // and upload a BC6H texture; it is `.integration.test.ts`-named
            // (plan-tasks w32), so list it explicitly here and let it skipIf
            // navigator.gpu is absent under the per-package unit project.
            'packages/runtime/src/__tests__/equirect-bc6h.integration.test.ts',
            R32FLOAT_CAPABILITY_GENERATION_TEST,
          ],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/artifacts/**',
            '**/docs/reports/**',
            '**/.forgeax-harness*/**',
            '**/.worktrees/**',
            '**/.claude/worktrees/**',
            ...(RUNNING_DIRECT_LIGHT_PARTITION ? [] : [DIRECT_LIGHT_DAWN_TEST_FILE]),
            ...(RUNNING_DAWN_ISOLATED ? [] : DAWN_ISOLATED_TEST_FILES),
            ...(RUNNING_DAWN_COMPACT ? [] : DAWN_COMPACT_TEST_FILES),
          ],
          setupFiles: ['./config/vitest.setup-webgpu.ts'],
        },
      },
    ],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    coverage: {
      provider: 'v8',
      // Package projects exercise one another through workspace imports. Keep
      // those first-party sources in the aggregate instead of dropping them
      // merely because they sit outside the importing project's root.
      allowExternal: true,
      reporter: ['text', 'json-summary', 'html'],
      // Exclude test fixtures, mocks, and generated build artifacts so the
      // global threshold reflects production source coverage. `__tests__/`
      // hosts vitest test files plus shared fixtures (`_arbs.ts` /
      // `_fixtures.ts` / `__mocks__/gpu-device.ts`); `wgpu-wasm/pkg/` is the
      // merged wasm-pack output (generated JS bindings, not hand-authored
      // source — feat-20260511-naga-rhi-wgpu-merge M1 productionised the
      // archived @forgeax/engine-naga-wasm-shim into this single bundle). Keeping
      // these inside the threshold pool penalised production-source
      // contributions disproportionately (charter proposition 4 explicit
      // failure: thresholds must measure the SUT, not its scaffolding).
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.test.mjs',
        '**/*.test-d.ts',
        '**/coverage/**',
        '**/wgpu-wasm/pkg/**',
        '**/scripts/**',
        '**/build.mjs',
        '**/vitest.config.ts',
        '**/tsup.config.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
      },
    },
  },
});
