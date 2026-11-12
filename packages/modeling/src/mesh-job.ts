import { PackageId } from '@forgeax/engine-pack/guid';
import type { NativeCookDraft, NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { PackCookSource } from '@forgeax/engine-pack/source';
import {
  type Asset,
  type ByteCache,
  err,
  type MeshAsset,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { captureActive } from './capture';
import { TS_BACKEND_IDENTITY } from './compute/boolean-ts';
import { sha256 } from './compute/sha256';
import { type ModelingError, modelingError } from './errors';
import type { ExportOptions } from './finish';
import type { Model } from './model';
import type { Rig, RigFinishOptions } from './rig';

/**
 * A rig program as a deferred job: the rig and its finish options (key and packageId
 * come from the source). Its outputs (`mesh/<key>.<part>`, `scene/<key>`,
 * `animation-clip/<key>`, ...) are published one cook source each; one cooker build of
 * the rig serves them all.
 */
export interface RigJob<P extends object = Record<string, unknown>> {
  readonly kind: 'rig';
  readonly name: string;
  /** Module exporting this job, for a cooker executor that runs it elsewhere (see `MeshJobExecutor`). */
  readonly module?: string;
  readonly build: (params: P) => {
    readonly rig: Rig;
    readonly finish: Omit<RigFinishOptions, 'key' | 'packageId'>;
  };
}

type RigOutputs = Awaited<ReturnType<Rig['finish']>>;

/**
 * A program whose outputs are ordinary assets under Pack output keys (a Pack build that
 * outgrows the Pack budget: meshes, LODs, baked textures, materials). Its outputs are
 * published one cook source each; one cooker build serves them all.
 */
export interface AssetsJob<P extends object = Record<string, unknown>> {
  readonly kind: 'assets';
  readonly name: string;
  /** Module exporting this job, for a cooker executor that runs it elsewhere (see `MeshJobExecutor`). */
  readonly module?: string;
  readonly build: (
    params: P,
    /** `cache`: the cook host's compute-job store, for the job's compute options. */
    context: { readonly packageId: PackageId; readonly cache?: ByteCache },
  ) =>
    | Result<Readonly<Record<string, Asset>>, AssetsJobError>
    | Promise<Result<Readonly<Record<string, Asset>>, AssetsJobError>>;
}

/**
 * The failure of an assets job: its outputs come from several owners (modeling, LOD
 * generation, materials), so any structured error; the cooker reports `code: expected`.
 */
export interface AssetsJobError {
  readonly code: string;
  readonly expected: string;
}

/** A job with a declared output set: one build serves every listed output. */
type SetJob<P extends object> = RigJob<P> | AssetsJob<P>;

/**
 * Heavy mesh programs as Pack cook sources (design 10.4): a session whose voxel,
 * remesh or simplify work would crowd the 15 s Pack build runs in the
 * `modeling-mesh-job` NativeCooker instead, and its export is published as an ordinary
 * `mesh/<key>` asset. The job is ordinary code reused by static import (design 10.1):
 * the Pack emits only its name and JSON parameters, and the project's build plugin
 * registers the same job with `createMeshJobCooker([job])`.
 */
export interface MeshJob<P extends object = Record<string, unknown>> {
  /** Registry name: letters, digits, `_`, `.` or `-`. */
  readonly name: string;
  /** Build the session from the job parameters (JSON numbers, strings, booleans). */
  readonly build: (params: P) => Model;
  /** Export options of the published mesh. */
  readonly export?: ExportOptions;
}

/**
 * Completed rig and assets builds a cooker keeps for re-cooks. A build whose outputs
 * have not all been cooked yet is never dropped, however many Packs cook at once.
 */
const SET_BUILDS_KEPT = 2;
/** Default bound of one cook: jobs exist because they outgrow the Pack build timeout. */
const COOK_TIMEOUT_MS = 600_000;

/** Pack custom-source kind and NativeCooker key of a deferred mesh job. */
export const MESH_JOB_COOK_KIND = 'modeling-mesh-job';
const SOURCE_VERSION = 1;
const NAME = /^[\w.-]+$/;
const KEY = /^[a-z0-9][a-z0-9_.-]*$/;
/** A Pack output key: `<kind>/<key>` with further path segments (`mesh/<key>/lod1`). */
const OUTPUT_KEY = /^[a-z][a-z-]*\/[a-z0-9][a-z0-9_.-]*(\/[a-z0-9][a-z0-9_.-]*)*$/;

/** The serialized source of one deferred job: JSON only, so every transport keeps it. */
export interface MeshJobCookSource {
  readonly version: typeof SOURCE_VERSION;
  readonly job: string;
  readonly key: string;
  readonly params: Readonly<Record<string, number | string | boolean>>;
  /** Rig and assets jobs: the Pack's packageId, the output this source publishes and a digest of all of them. */
  readonly set?: { readonly packageId: string; readonly output: string; readonly outputs: string };
}

function jsonParams(params: object): Record<string, number | string | boolean> | undefined {
  if (Object.getPrototypeOf(params) !== Object.prototype) return undefined;
  const out: Record<string, number | string | boolean> = {};
  for (const name of Object.keys(params).sort()) {
    const value = (params as Record<string, unknown>)[name];
    if (
      typeof value === 'number'
        ? !Number.isFinite(value)
        : !['string', 'boolean'].includes(typeof value)
    ) {
      return undefined;
    }
    out[name] = value as number | string | boolean;
  }
  return out;
}

function runJob<P extends object>(
  job: MeshJob<P>,
  key: string,
  params: P,
): Result<Readonly<Record<string, MeshAsset>>, ModelingError> {
  return job.build(params).finish({ key, ...job.export });
}

/**
 * Pack output `mesh/<key>` of `job` as a `modeling-mesh-job` PackCookSource: the build
 * returns at once and the cooker runs the job outside the build timeout. Under a
 * `model.*` capture the job runs in place, so the tools see its session, journal and
 * source lines; the cooked mesh is the same bytes.
 */
export function meshJobSources<P extends object>(
  job: MeshJob<P>,
  options: { readonly key: string; readonly params: P },
): Result<Readonly<Record<string, MeshAsset | PackCookSource>>, ModelingError> {
  if (!NAME.test(job.name)) {
    return err(
      modelingError('model-invalid-argument', 'the job name is letters, digits, _, . or -', {
        name: job.name,
      }),
    );
  }
  if (!KEY.test(options.key)) {
    return err(
      modelingError('model-invalid-argument', 'key is a lowercase source key segment', {
        key: options.key,
      }),
    );
  }
  const params = jsonParams(options.params);
  if (params === undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'job parameters are a plain object of finite numbers, strings and booleans',
        { job: job.name },
        'pass the Pack values the job needs, not sessions or selectors',
      ),
    );
  }
  if (captureActive()) return runJob(job, options.key, options.params);
  const source: MeshJobCookSource = {
    version: SOURCE_VERSION,
    job: job.name,
    key: options.key,
    params,
  };
  return ok({ [`mesh/${options.key}`]: { kind: MESH_JOB_COOK_KIND, execution: 'cooked', source } });
}

function outputsDigest(outputs: readonly string[]): string {
  return sha256(new TextEncoder().encode(JSON.stringify([...outputs].sort())));
}

function checkJob(name: string, key: string): Result<void, ModelingError> {
  if (!NAME.test(name)) {
    return err(
      modelingError('model-invalid-argument', 'the job name is letters, digits, _, . or -', {
        name,
      }),
    );
  }
  if (!KEY.test(key)) {
    return err(
      modelingError('model-invalid-argument', 'key is a lowercase source key segment', { key }),
    );
  }
  return ok(undefined);
}

function runRigJob<P extends object>(
  job: RigJob<P>,
  key: string,
  packageId: string,
  params: P,
): Result<RigOutputs extends Result<infer T, unknown> ? T : never, ModelingError> {
  const id = PackageId.parse(packageId);
  if (!id.ok) {
    return err(
      modelingError('model-invalid-argument', 'packageId is a dash-form package UUID', {
        packageId,
      }),
    );
  }
  const built = job.build(params);
  return built.rig.finish({ ...built.finish, key, packageId: id.value });
}

/** Outputs of one rig or assets job build, or its first failure. */
export type MeshJobSetResult = Result<
  Readonly<Record<string, Asset>>,
  ModelingError | AssetsJobError
>;

/**
 * One build of a rig or assets job: the build the `modeling-mesh-job` cooker runs for
 * every output of a Pack, and what a `MeshJobExecutor` runs for it elsewhere.
 */
export async function buildMeshJobSet(
  job: RigJob<never> | AssetsJob<never>,
  options: {
    readonly key: string;
    readonly packageId: string;
    readonly params: object;
    readonly cache?: ByteCache;
  },
): Promise<MeshJobSetResult> {
  const { key, packageId, params, cache } = options;
  if (job.kind === 'rig') return runRigJob(job as RigJob<object>, key, packageId, params);
  const id = PackageId.parse(packageId);
  if (!id.ok) {
    return err(
      modelingError('model-invalid-argument', 'packageId is a dash-form package UUID', {
        packageId,
      }),
    );
  }
  return (job as AssetsJob<object>).build(params, {
    packageId: id.value,
    ...(cache === undefined ? {} : { cache }),
  });
}

/** A rig or assets job build for an executor: plain data naming the job's module. */
export interface MeshJobRequest {
  readonly module: string;
  readonly job: string;
  readonly key: string;
  readonly packageId: string;
  readonly params: Readonly<Record<string, number | string | boolean>>;
  /** The kernel identity of the requesting cooker (scheduling records key on it). */
  readonly identity: string;
}

/**
 * Runs a job build elsewhere, such as Worker threads (`meshJobWorkers` in
 * `@forgeax/engine-modeling/tools`): the result must equal `buildMeshJobSet` of the
 * same job and request. `cache` is the cook host's store; an executor may also keep its
 * own scheduling records there, never anything that reaches outputs. Resolving
 * `undefined` declines the request, and the cooker builds the job inline.
 */
export type MeshJobExecutor = (
  request: MeshJobRequest,
  context: { readonly cache?: ByteCache },
) => Promise<MeshJobSetResult | undefined>;

/**
 * The output keys of a rig job, by building its rig once without exporting it (offline:
 * a script or test writes them next to the Pack, which must list its outputs without
 * running the job).
 */
export function rigJobOutputs<P extends object>(
  job: RigJob<P>,
  options: { readonly key: string; readonly params: P },
): Result<readonly string[], ModelingError> {
  const checked = checkJob(job.name, options.key);
  if (!checked.ok) return checked;
  const built = job.build(options.params);
  return built.rig.outputKeys({ ...built.finish, key: options.key });
}

/**
 * Pack outputs of a rig job as `modeling-mesh-job` PackCookSources, one per key in
 * `outputs` (from `rigJobOutputs`): the build returns at once and the cooker builds the
 * rig once for all of them. A stale `outputs` list fails the cook (the cooker compares
 * it with the built rig). Under a `model.*` capture the job runs in place.
 */
export function rigJobSources<P extends object>(
  job: RigJob<P>,
  options: SetSourceOptions<P>,
): Result<Readonly<Record<string, PackCookSource | RigOutputValue>>, ModelingError> {
  if (captureActive()) {
    const checked = setSources(job, options);
    if (!checked.ok) return checked;
    const out = runRigJob(job, options.key, PackageId.format(options.packageId), options.params);
    if (!out.ok) return out;
    const stale = staleOutputs(Object.keys(out.value), options.outputs);
    return stale === undefined ? out : err(stale);
  }
  return setSources(job, options);
}

/**
 * Pack outputs of an assets job as `modeling-mesh-job` PackCookSources, one per key in
 * `outputs` (from `assetsJobOutputs`, written next to the Pack): the build returns at once
 * and the cooker builds the job once for all of them. Under a `model.*` capture the job
 * runs in place.
 */
export async function assetsJobSources<P extends object>(
  job: AssetsJob<P>,
  options: SetSourceOptions<P>,
): Promise<
  Result<Readonly<Record<string, PackCookSource | Asset>>, ModelingError | AssetsJobError>
> {
  if (captureActive()) {
    const checked = setSources(job, options);
    if (!checked.ok) return checked;
    const out = await job.build(options.params, { packageId: options.packageId });
    if (!out.ok) return out;
    const stale = staleOutputs(Object.keys(out.value), options.outputs);
    return stale === undefined ? out : err(stale);
  }
  return setSources(job, options);
}

/** The output keys of an assets job, by running it once (offline, like `rigJobOutputs`). */
export async function assetsJobOutputs<P extends object>(
  job: AssetsJob<P>,
  options: { readonly key: string; readonly packageId: PackageId; readonly params: P },
): Promise<Result<readonly string[], ModelingError | AssetsJobError>> {
  const checked = checkJob(job.name, options.key);
  if (!checked.ok) return checked;
  const out = await job.build(options.params, { packageId: options.packageId });
  return out.ok ? ok(Object.keys(out.value).sort()) : out;
}

interface SetSourceOptions<P extends object> {
  readonly key: string;
  readonly packageId: PackageId;
  readonly params: P;
  readonly outputs: readonly string[];
}

function setSources<P extends object>(
  job: SetJob<P>,
  options: SetSourceOptions<P>,
): Result<Readonly<Record<string, PackCookSource>>, ModelingError> {
  const checked = checkJob(job.name, options.key);
  if (!checked.ok) return checked;
  const params = jsonParams(options.params);
  if (params === undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'job parameters are a plain object of finite numbers, strings and booleans',
        { job: job.name },
        'pass the Pack values the job needs, not sessions or selectors',
      ),
    );
  }
  const outputs = options.outputs;
  if (
    !Array.isArray(outputs) ||
    outputs.length === 0 ||
    new Set(outputs).size !== outputs.length ||
    !outputs.every((o) => typeof o === 'string' && OUTPUT_KEY.test(o))
  ) {
    return err(
      modelingError(
        'model-invalid-argument',
        'outputs lists the job output keys once each (rigJobOutputs / assetsJobOutputs)',
        { outputs },
      ),
    );
  }
  const digest = outputsDigest(outputs);
  return ok(
    Object.fromEntries(
      [...outputs].sort().map((output) => [
        output,
        {
          kind: MESH_JOB_COOK_KIND,
          execution: 'cooked' as const,
          source: {
            version: SOURCE_VERSION,
            job: job.name,
            key: options.key,
            params,
            set: { packageId: PackageId.format(options.packageId), output, outputs: digest },
          } satisfies MeshJobCookSource,
        },
      ]),
    ),
  );
}

type RigOutputValue = RigOutputs extends Result<infer T, unknown> ? T[keyof T] : never;

function staleOutputs(
  built: readonly string[],
  declared: readonly string[],
): ModelingError | undefined {
  if (outputsDigest(built) === outputsDigest(declared)) return undefined;
  const have = new Set(built);
  const listed = new Set(declared);
  return modelingError(
    'model-precondition',
    "the Pack's outputs list matches the outputs the job builds",
    {
      missing: built.filter((o) => !listed.has(o)).slice(0, 32),
      extra: declared.filter((o) => !have.has(o)).slice(0, 32),
    },
    'regenerate the list with rigJobOutputs / assetsJobOutputs (the job gained or lost outputs)',
  );
}

function parseSource(source: unknown): MeshJobCookSource {
  const s = source as Partial<MeshJobCookSource> | null;
  const set = s?.set as Partial<NonNullable<MeshJobCookSource['set']>> | undefined;
  if (
    s === null ||
    typeof s !== 'object' ||
    s.version !== SOURCE_VERSION ||
    typeof s.job !== 'string' ||
    typeof s.key !== 'string' ||
    !KEY.test(s.key) ||
    typeof s.params !== 'object' ||
    s.params === null ||
    jsonParams(s.params) === undefined ||
    Object.keys(s).some((k) => !['version', 'job', 'key', 'params', 'set'].includes(k)) ||
    (set !== undefined &&
      (typeof set !== 'object' ||
        set === null ||
        typeof set.packageId !== 'string' ||
        typeof set.output !== 'string' ||
        typeof set.outputs !== 'string'))
  ) {
    throw new TypeError(
      `${MESH_JOB_COOK_KIND}: the source is { version: ${SOURCE_VERSION}, job, key, params } from meshJobSources()`,
    );
  }
  return s as MeshJobCookSource;
}

export interface MeshJobCookInput {
  readonly guid: string;
  readonly source: unknown;
}

/**
 * The `modeling-mesh-job` NativeCooker over the registered jobs: decodes a
 * `meshJobSources` entry, runs its job and returns the export as an ordinary mesh
 * payload. A failed job throws with its first modeling error, so the cook transaction
 * keeps its last-known-good mesh. `timeoutMs` (default 10 min) is the bound a build host
 * that runs cookers out of process gives one cook (DevKit build roots otherwise stop a
 * cook after 60 s).
 *
 * Cooks are `concurrency: 'parallel'`: a host may cook several Packs at once, and the
 * outputs of one job and parameter set share one build. With `executor`, rig and assets
 * jobs that name their `module` build there (Worker threads: `meshJobWorkers` in
 * `@forgeax/engine-modeling/tools`); other jobs build inline. The output bytes are the
 * same either way.
 */
export function createMeshJobCooker(
  jobs: readonly (MeshJob<never> | SetJob<never>)[],
  options: { readonly timeoutMs?: number; readonly executor?: MeshJobExecutor } = {},
): NativeCooker<Asset, MeshJobCookInput> {
  const timeoutMs = options.timeoutMs ?? COOK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${MESH_JOB_COOK_KIND}: timeoutMs is positive finite milliseconds`);
  }
  const registry = new Map<string, MeshJob<never> | SetJob<never>>();
  for (const job of jobs) {
    if (!NAME.test(job.name) || registry.has(job.name)) {
      throw new TypeError(
        `${MESH_JOB_COOK_KIND}: job names are unique registry names (${job.name})`,
      );
    }
    registry.set(job.name, job);
  }
  const names = [...registry.keys()].sort().join(',');
  // A job is code: editing its build or export options must miss the DDC, like a kernel edit.
  const sourceDigests = new Map<string, string>();
  const sourceOf = (job: MeshJob<never> | SetJob<never>) => {
    let digest = sourceDigests.get(job.name);
    if (digest === undefined) {
      const text = [
        String(job.build),
        JSON.stringify('export' in job ? (job.export ?? null) : null),
      ];
      digest = sha256(new TextEncoder().encode(JSON.stringify(text)));
      sourceDigests.set(job.name, digest);
    }
    return digest;
  };
  // One build per rig or assets job and parameter set serves every output it publishes
  // (S7: 577 outputs of one 2-minute build). A build stays until each of its outputs has
  // been cooked once; of the completed ones, the most recent few stay for re-cooks.
  interface SetBuild {
    readonly built: Promise<MeshJobSetResult>;
    readonly served: Set<string>;
    complete: boolean;
  }
  const setBuilds = new Map<string, SetBuild>();
  const retire = () => {
    const completed = [...setBuilds].filter(([, entry]) => entry.complete);
    for (const [id] of completed.slice(0, Math.max(0, completed.length - SET_BUILDS_KEPT)))
      setBuilds.delete(id);
  };
  const executor = options.executor;
  const runSet = (
    job: SetJob<object>,
    source: MeshJobCookSource,
    packageId: string,
    cache: ByteCache | undefined,
  ): Promise<MeshJobSetResult> => {
    const inline = () =>
      buildMeshJobSet(job as SetJob<never>, {
        key: source.key,
        packageId,
        params: source.params,
        ...(cache === undefined ? {} : { cache }),
      });
    if (executor === undefined || job.module === undefined) return inline();
    const request: MeshJobRequest = {
      module: job.module,
      job: source.job,
      key: source.key,
      packageId,
      params: jsonParams(source.params) ?? {},
      identity: TS_BACKEND_IDENTITY,
    };
    return executor(request, cache === undefined ? {} : { cache }).then(
      (result) => result ?? inline(),
    );
  };
  const setBuild = async (
    job: SetJob<object>,
    source: MeshJobCookSource,
    packageId: string,
    output: string,
    cache: ByteCache | undefined,
  ) => {
    const id = JSON.stringify([source.job, source.key, packageId, jsonParams(source.params)]);
    let entry = setBuilds.get(id);
    if (entry === undefined) {
      entry = { built: runSet(job, source, packageId, cache), served: new Set(), complete: false };
    }
    // Most recently used last: retirement drops the oldest completed builds first.
    setBuilds.delete(id);
    setBuilds.set(id, entry);
    const built = await entry.built;
    entry.served.add(output);
    entry.complete = !built.ok || Object.keys(built.value).every((key) => entry.served.has(key));
    retire();
    return built;
  };
  return {
    key: MESH_JOB_COOK_KIND,
    // Cooks are input-isolated; builds of one job and parameter set are shared above.
    concurrency: 'parallel',
    timeoutMs,
    cacheIdentity: () =>
      `${TS_BACKEND_IDENTITY};jobs=${[...registry.values()]
        .map((job) => `${job.name}:${sourceOf(job)}`)
        .sort()
        .join(',')}`,
    async cook(input, context): Promise<NativeCookDraft<Asset>> {
      if (typeof input?.guid !== 'string' || input.guid.length === 0) {
        throw new TypeError(`${MESH_JOB_COOK_KIND}: the cook input carries its asset GUID`);
      }
      const source = parseSource(input.source);
      const job = registry.get(source.job);
      if (job === undefined) {
        throw new TypeError(
          `${MESH_JOB_COOK_KIND}: job '${source.job}' is registered (createMeshJobCooker([...]) has ${names || 'none'})`,
        );
      }
      const fingerprint = (extra: readonly unknown[]) =>
        `${MESH_JOB_COOK_KIND}:${sha256(
          new TextEncoder().encode(
            JSON.stringify([
              TS_BACKEND_IDENTITY,
              source.job,
              sourceOf(job),
              source.key,
              jsonParams(source.params),
              ...extra,
            ]),
          ),
        )}`;
      if (source.set !== undefined) {
        const set = source.set;
        if (!isSetJob(job)) {
          throw new TypeError(
            `${MESH_JOB_COOK_KIND}: job '${source.job}' is a mesh job (a meshJobSources entry)`,
          );
        }
        const built = await setBuild(
          job as SetJob<object>,
          source,
          set.packageId,
          set.output,
          context?.cache,
        );
        if (!built.ok) throw cookFailure(built.error, source, input.guid, set.output);
        if (outputsDigest(Object.keys(built.value)) !== set.outputs) {
          throw new TypeError(
            `${MESH_JOB_COOK_KIND}: job '${source.job}' builds other outputs than the Pack lists: regenerate the list with rigJobOutputs / assetsJobOutputs`,
          );
        }
        const payload = built.value[set.output];
        if (payload === undefined) {
          throw new TypeError(
            `${MESH_JOB_COOK_KIND}: job '${source.job}' builds no output ${set.output}`,
          );
        }
        return {
          guid: input.guid,
          payload,
          refs: [],
          artifacts: {},
          inputFingerprint: fingerprint([set.packageId, set.output, set.outputs]),
        };
      }
      if (isSetJob(job)) {
        throw new TypeError(
          `${MESH_JOB_COOK_KIND}: job '${source.job}' is a ${job.kind} job (a ${job.kind}JobSources entry)`,
        );
      }
      const out = runJob(job as MeshJob<object>, source.key, source.params);
      if (!out.ok) throw cookFailure(out.error, source, input.guid, `mesh/${source.key}`);
      return {
        guid: input.guid,
        payload: out.value[`mesh/${source.key}`] as MeshAsset,
        refs: [],
        artifacts: {},
        inputFingerprint: fingerprint([]),
      };
    },
  };
}

/** The failing output's identity leads the message: a cook log names the job, key and GUID. */
function cookFailure(
  error: ModelingError | AssetsJobError,
  source: MeshJobCookSource,
  guid: string,
  output: string,
): TypeError {
  const detail = JSON.stringify({
    job: source.job,
    key: source.key,
    output,
    guid,
    ...(error as { readonly detail?: object }).detail,
  });
  return new TypeError(`${error.code}: ${error.expected} ${detail}`, { cause: error });
}

function isSetJob(job: MeshJob<never> | SetJob<never>): job is SetJob<never> {
  const kind = (job as { readonly kind?: string }).kind;
  return kind === 'rig' || kind === 'assets';
}
