import type { App, CreateAppOptions } from '@forgeax/engine/app';
import type { World } from '@forgeax/engine/ecs';

/**
 * - `visual`: renders a scene and must show an obvious on/off difference through `toggle`.
 * - `probe`: needs the live App (renderer, input, assets) but proves behavior through `checks`.
 * - `headless`: pure logic with no GPU or DOM; runs in the browser panel and in Node (`pnpm test`).
 */
export type FeatureKind = 'visual' | 'probe' | 'headless';

/** Catalog form labels (SDK feature catalog reading conventions), derived per row in `catalog.ts`. */
export type FeatureForm =
  | 'built-in'
  | 'opt-in'
  | 'build-time'
  | 'host-side'
  | 'development'
  | 'test-experimental';

export interface FeatureCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface FeatureHud {
  /** Replace the live caption shown under the feature title. */
  status(text: string): void;
}

export interface FeatureContext {
  readonly app: App;
  readonly world: World;
  readonly canvas: HTMLCanvasElement;
  readonly hud: FeatureHud;
  /** Resolves after `count` additional renderer frame submissions. */
  frames(count: number): Promise<void>;
}

export interface FeatureHandle {
  /** Switch the demonstrated feature off (`false`) or back on (`true`). */
  toggle?(on: boolean): void | Promise<void>;
  /** Structured self-checks; required for probes, optional for visuals. */
  checks?(): readonly FeatureCheck[] | Promise<readonly FeatureCheck[]>;
}

interface FeatureMeta {
  readonly title: string;
  /** Feature row name exactly as written in the SDK feature catalog. */
  readonly catalog: string;
  /** One or two sentences a tester reads before looking at the canvas. */
  readonly summary: string;
  /** What the tester should observe: the visible toggle difference, or the probe verdict. */
  readonly expect: string;
  /**
   * An engine bug this feature reproduces today. Automation then requires the feature to
   * fail (the reproduction stays live evidence) and turns red once it passes, so the fix
   * removes this field in the same change.
   */
  readonly knownIssue?: string;
}

export interface AppFeature extends FeatureMeta {
  readonly kind: 'visual' | 'probe';
  readonly appOptions?: CreateAppOptions;
  /** The feature deliberately provokes a structured App error (fault injection); the runner then requires one. */
  readonly expectsAppError?: boolean;
  setup(ctx: FeatureContext): FeatureHandle | void | Promise<FeatureHandle | void>;
}

export interface HeadlessFeature extends FeatureMeta {
  readonly kind: 'headless';
  run(checks: CheckList): void | Promise<void>;
}

export type FeatureDefinition = AppFeature | HeadlessFeature;

export function defineFeature<const T extends FeatureDefinition>(definition: T): T {
  return definition;
}

/** Collects named assertions without throwing so one failure keeps the rest visible. */
export class CheckList {
  readonly items: FeatureCheck[] = [];

  ok(name: string, condition: boolean, detail?: string): this {
    this.items.push(
      detail === undefined ? { name, ok: condition } : { name, ok: condition, detail },
    );
    return this;
  }

  equal(name: string, actual: unknown, expected: unknown): this {
    const same = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
    return this.ok(
      name,
      same,
      `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
    );
  }

  near(name: string, actual: number, expected: number, epsilon = 1e-5): this {
    return this.ok(
      name,
      Math.abs(actual - expected) <= epsilon,
      `actual=${actual} expected=${expected} eps=${epsilon}`,
    );
  }

  /** Records `body` as passed unless it throws or returns `false`; a string return becomes the detail. */
  /** `false` fails; a string passes with that detail, so failure reasons must throw; a throw fails with its message. */
  async run(name: string, body: () => unknown | Promise<unknown>): Promise<this> {
    try {
      const value = await body();
      return this.ok(name, value !== false, typeof value === 'string' ? value : undefined);
    } catch (error) {
      return this.ok(
        name,
        false,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
    }
  }
}

export async function runHeadless(feature: HeadlessFeature): Promise<readonly FeatureCheck[]> {
  const checks = new CheckList();
  try {
    await feature.run(checks);
  } catch (error) {
    checks.ok(
      'run completed',
      false,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
  if (checks.items.length === 0) checks.ok('at least one check recorded', false);
  return checks.items;
}
