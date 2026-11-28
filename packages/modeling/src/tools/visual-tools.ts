import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  defineCommand,
  type JsonValue,
  operationCommandPath,
  type ToolContribution,
  type ToolJsonSchema,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';
import { confineToRoot } from './confine';
import { readPng } from './image-metrics';
import { accept, type ContractEntry, checkAccept, type GateResult } from './visual-accept';
import { type CompareOptions, checkCompareOptions, compareImages } from './visual-compare';
import { type ConvergeEntry, checkConverge, converge } from './visual-converge';
import { checkFeatures, type Feature, scoreFeatures } from './visual-microscope';
import {
  checkTurntableOptions,
  evaluateTurntable,
  type TurntableCapture,
} from './visual-turntable';

type Failure = { readonly ok: false; readonly error: Record<string, JsonValue> };

function invalid(expected: string, detail: Record<string, JsonValue>): never {
  return {
    ok: false,
    error: {
      code: 'tool-invalid-args',
      expected,
      hint: 'see the operation args schema',
      detail,
    },
  } as Failure as never;
}

const isFailure = (value: unknown): value is Failure =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;

/** Project-confined image reading and artifact writing shared by the image operations. */
function files(projectRoot: string) {
  const resolve = (path: unknown, arg: string): string | Failure => {
    if (typeof path !== 'string' || path === '')
      return invalid(`${arg} is a project-relative path`, { arg });
    const absolute = confineToRoot(projectRoot, path);
    return absolute ?? invalid(`${arg} stays inside the project root`, { arg, path });
  };
  const image = (path: unknown, arg: string) => {
    const absolute = resolve(path, arg);
    if (isFailure(absolute)) return absolute;
    try {
      return readPng(readFileSync(absolute));
    } catch (cause) {
      return invalid(`${arg} is a readable PNG`, {
        arg,
        path: path as string,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  const write = (out: unknown, items: readonly (readonly [string, Uint8Array])[]) => {
    const dir = resolve(out, 'out');
    if (isFailure(dir)) return dir;
    mkdirSync(dir, { recursive: true });
    return items.map(([name, bytes]) => {
      const file = join(dir, name);
      writeFileSync(file, bytes);
      return relative(projectRoot, file);
    });
  };
  return { resolve, image, write };
}

const OUT_ARG = {
  type: 'string',
  description: 'Project-relative directory the artifact PNGs are written to',
} as const;

const PNG_PATH = { type: 'string', description: 'Project-relative PNG path' } as const;

function command(
  id: string,
  title: string,
  summary: string,
  argsSchema: object,
  run: (args: Record<string, unknown>) => unknown,
): ToolContribution {
  return defineCommand(
    {
      id,
      path: operationCommandPath(id as never),
      title,
      summary,
      realm: 'build',
      argsSchema: toolJsonSchema(argsSchema as unknown as ToolJsonSchema),
      resultSchema: toolJsonSchema({ type: 'object' } as ToolJsonSchema),
      evidence: [],
      capabilities: [],
      errors: ['tool-invalid-args'],
      inputSchema: argsSchema as unknown as JsonValue,
    },
    async (raw) => {
      const result = run(raw as Record<string, unknown>);
      return (isFailure(result) ? result : { ok: true, value: result }) as never;
    },
  );
}

const compareSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reference', 'render'],
  properties: {
    reference: {
      ...PNG_PATH,
      description: 'Reference image (photo, concept art or earlier render)',
    },
    render: {
      ...PNG_PATH,
      description: 'The render to hold to the reference (model.render output)',
    },
    size: {
      type: 'integer',
      minimum: 64,
      maximum: 512,
      description: 'Aligned grid edge, a multiple of 32 (default 192)',
    },
    target: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 1,
      description: 'Weighted fidelity the render must reach (default 0.7)',
    },
    minIoU: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 1,
      description: 'Silhouette IoU the render must reach (default 0.85)',
    },
    maxScaleDelta: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 1,
      description: 'Largest relative difference of the subject frame share (default 0.08)',
    },
    band: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
      description:
        'Fractional [top, bottom] height band of the subject for the interior difference',
    },
    out: OUT_ARG,
  },
} as const;

const featureSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tier', 'roi'],
  properties: {
    id: { type: 'string' },
    tier: { type: 'string', enum: ['critical', 'important', 'detail'] },
    roi: {
      type: 'array',
      items: { type: 'number' },
      minItems: 4,
      maxItems: 4,
      description: '[x0, y0, x1, y1] as fractions of the subject bbox',
    },
    minimumScore: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    concave: { type: 'boolean', description: 'Cavity or recess: the color term is skipped' },
    mask: {
      ...PNG_PATH,
      description: 'Visible-footprint mask PNG (white = compare), same size as the reference',
    },
  },
} as const;

const microscopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reference', 'render', 'features'],
  properties: {
    reference: PNG_PATH,
    render: PNG_PATH,
    size: {
      type: 'integer',
      minimum: 64,
      maximum: 1024,
      description: 'Aligned grid edge (default 256)',
    },
    maxShift: {
      type: 'integer',
      minimum: 0,
      maximum: 32,
      description:
        'Largest per-feature registration shift in grid pixels (default 8; 0 disables it)',
    },
    features: { type: 'array', minItems: 1, items: featureSchema },
  },
} as const;

const turntableSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['captures'],
  properties: {
    captures: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['azimuth', 'path'],
        properties: { azimuth: { type: 'number' }, path: PNG_PATH },
      },
    },
    required: {
      type: 'array',
      items: { type: 'number' },
      description: 'Azimuths that must be present (default 0, 90, 180, 270)',
    },
    tolerance: {
      type: 'number',
      minimum: 0,
      exclusiveMaximum: 45,
      description: 'Degrees a capture may sit from a required azimuth (default 5)',
    },
    minAreaRatio: {
      type: 'number',
      exclusiveMinimum: 0,
      exclusiveMaximum: 1,
      description: 'Smallest silhouette area against the frontal view (default 0.15)',
    },
    allowHoles: { type: 'boolean', description: 'The subject legitimately has through-holes' },
  },
} as const;

const convergeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['history'],
  properties: {
    history: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fidelity', 'defectTags', 'reverted'],
        properties: {
          fidelity: { type: 'number', minimum: 0, maximum: 1 },
          defectTags: { type: 'array', items: { type: 'string' } },
          reverted: { type: 'boolean' },
          hardGateFailures: { type: 'array', items: { type: 'string' } },
          verdict: {
            type: 'string',
            description:
              'model.compare verdict of the iteration; anything but pass keeps the review pending',
          },
        },
      },
    },
    target: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Fidelity that ends the loop (default 0.85)',
    },
    maxIter: { type: 'integer', minimum: 1, description: 'Iteration ceiling (default 6)' },
    minDelta: {
      type: 'number',
      minimum: 0,
      description: 'Smallest fidelity gain that is not a plateau (default 0.02)',
    },
  },
} as const;

const LEVEL_ARG = { type: 'string', enum: ['L0', 'L1', 'L2', 'L3', 'L4'] } as const;

const acceptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['build', 'contract', 'results'],
  properties: {
    build: {
      type: 'string',
      description:
        'Hash of the build every result must have been measured on (the git revision or a digest of source and parameters); a result on another build is stale',
    },
    contract: {
      type: 'array',
      description: 'Per level and part, the gates it must clear before the level passes',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'part', 'gates'],
        properties: {
          level: LEVEL_ARG,
          part: { type: 'string' },
          gates: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    results: {
      type: 'array',
      description:
        'Measured gates: the verdict of a validate, compare, microscope or turntable run',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'part', 'gate', 'pass', 'build'],
        properties: {
          level: LEVEL_ARG,
          part: { type: 'string' },
          gate: { type: 'string' },
          pass: { type: 'boolean' },
          build: { type: 'string' },
          evidence: {
            type: 'string',
            description: 'Path of the report or image behind the verdict',
          },
        },
      },
    },
  },
} as const;

/** The visual feedback operations; image paths are confined to `projectRoot`. */
export function visualFeedbackTools(projectRoot: string): readonly ToolContribution[] {
  const io = files(projectRoot);
  return [
    command(
      'model.compare',
      'Modeling compare',
      'Holds a render to a reference image on a bbox-aligned grid: hard gates, nine weighted signals, hue zones and a verdict (forgeax.model.compare/1); --out writes the comparison sheet and heatmap.',
      compareSchema,
      (args) => {
        const reference = io.image(args.reference, 'reference');
        if (isFailure(reference)) return reference;
        const render = io.image(args.render, 'render');
        if (isFailure(render)) return render;
        const options: CompareOptions = {
          ...(args.size === undefined ? {} : { size: args.size as number }),
          ...(args.target === undefined ? {} : { target: args.target as number }),
          ...(args.minIoU === undefined ? {} : { minIoU: args.minIoU as number }),
          ...(args.maxScaleDelta === undefined
            ? {}
            : { maxScaleDelta: args.maxScaleDelta as number }),
          ...(args.band === undefined ? {} : { band: args.band as readonly [number, number] }),
        };
        const bad = checkCompareOptions(options);
        if (bad !== undefined) return invalid(bad, {});
        const { report, sheet, heatmap } = compareImages(reference, render, options);
        if (args.out === undefined || sheet.length === 0) return report;
        const written = io.write(args.out, [
          ['compare-sheet.png', sheet],
          ['compare-delta-e.png', heatmap],
        ]);
        return isFailure(written) ? written : { ...report, artifacts: written };
      },
    ),
    command(
      'model.microscope',
      'Modeling microscope',
      'Scores declared feature regions of a render against the reference by the worst patch; every critical feature must meet its minimum (forgeax.model.microscope/1).',
      microscopeSchema,
      (args) => {
        const reference = io.image(args.reference, 'reference');
        if (isFailure(reference)) return reference;
        const render = io.image(args.render, 'render');
        if (isFailure(render)) return render;
        const features: Feature[] = [];
        for (const raw of args.features as Record<string, unknown>[]) {
          const { mask: maskPath, ...rest } = raw;
          let mask: Uint8Array | undefined;
          if (maskPath !== undefined) {
            const decoded = io.image(maskPath, `features[${String(raw.id)}].mask`);
            if (isFailure(decoded)) return decoded;
            if (
              decoded.image.width !== reference.image.width ||
              decoded.image.height !== reference.image.height
            )
              return invalid('a feature mask has the size of the reference', {
                feature: String(raw.id),
              });
            mask = new Uint8Array(decoded.image.width * decoded.image.height);
            for (let i = 0; i < mask.length; i++)
              mask[i] = (decoded.image.rgb[i * 3] as number) > 0.5 ? 1 : 0;
          }
          features.push({
            ...(rest as unknown as Feature),
            ...(mask === undefined ? {} : { mask }),
          });
        }
        const bad = checkFeatures(features);
        if (bad !== undefined) return invalid(bad, {});
        return scoreFeatures(reference, render, features, {
          ...(args.size === undefined ? {} : { size: args.size as number }),
          ...(args.maxShift === undefined ? {} : { maxShift: args.maxShift as number }),
        });
      },
    ),
    command(
      'model.turntable',
      'Modeling turntable',
      'Checks an orbit of model.render captures for missing azimuths, silhouette collapse and unwanted through-holes (forgeax.model.turntable/1).',
      turntableSchema,
      (args) => {
        const captures: TurntableCapture[] = [];
        for (const raw of args.captures as { azimuth: number; path: string }[]) {
          const decoded = io.image(raw.path, `captures[${raw.azimuth}]`);
          if (isFailure(decoded)) return decoded;
          captures.push({ azimuth: raw.azimuth, ...decoded });
        }
        const options = {
          ...(args.required === undefined ? {} : { required: args.required as number[] }),
          ...(args.tolerance === undefined ? {} : { tolerance: args.tolerance as number }),
          ...(args.minAreaRatio === undefined ? {} : { minAreaRatio: args.minAreaRatio as number }),
          ...(args.allowHoles === undefined ? {} : { allowHoles: args.allowHoles as boolean }),
        };
        const bad = checkTurntableOptions(captures, options);
        if (bad !== undefined) return invalid(bad, {});
        return evaluateTurntable(captures, options);
      },
    ),
    command(
      'model.converge',
      'Modeling converge',
      'Decides from a correction loop score history whether to continue or stop, and which action follows (forgeax.model.converge/1).',
      convergeSchema,
      (args) => {
        const history = args.history as ConvergeEntry[];
        const options = {
          ...(args.target === undefined ? {} : { target: args.target as number }),
          ...(args.maxIter === undefined ? {} : { maxIter: args.maxIter as number }),
          ...(args.minDelta === undefined ? {} : { minDelta: args.minDelta as number }),
        };
        const bad = checkConverge(history, options);
        if (bad !== undefined) return invalid(bad, {});
        return converge(history, options);
      },
    ),
    command(
      'model.accept',
      'Modeling accept',
      'Folds the gate results of a build into one pass table by level and part; unmeasured and stale gates are not passes (forgeax.model.accept/1).',
      acceptSchema,
      (args) => {
        const contract = args.contract as ContractEntry[];
        const results = args.results as GateResult[];
        const bad = checkAccept(contract, results, args.build);
        if (bad !== undefined) return invalid(bad, {});
        return accept(contract, results, args.build as string);
      },
    ),
  ];
}
