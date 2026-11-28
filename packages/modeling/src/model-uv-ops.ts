import type { Result } from '@forgeax/engine-types';
import type { ModelingError } from './errors';
import type { CornerChannelName, EditMesh } from './mesh';
import type { RustEditMeshStore } from './mesh-store-rust';
import { describePlan, describeSeams, type OpReport, trimArgs } from './model-helpers';
import {
  resolveRustMipPadding,
  rustUvAuto,
  rustUvPack,
  rustUvProject,
  rustUvUnwrap,
} from './model-rust';
import {
  rustUvLightmap,
  rustUvPlan,
  rustUvStraighten,
  rustUvSwatch,
  rustUvTrim,
} from './model-rust-ext';
import {
  type Attribution,
  type OpDiagnostic,
  type ProjectOptions,
  projectUv,
  type RoleCounts,
} from './ops';
import { type PlanSeamsOptions, planSeams } from './seams';
import type { FaceSelector } from './selectors';
import {
  type AutoUvOptions,
  autoUv,
  type PackOptions,
  packUv,
  type StraightenOptions,
  type SwatchUvOptions,
  seamSelection,
  straightenUv,
  swatchUv,
  type TrimUvOptions,
  trimUv,
  type UnwrapOptions,
  type UvContext,
  unwrapUv,
} from './uv';
import {
  type Carrier,
  type ChannelOptions,
  channelOp,
  type LightmapOptions,
  lightmapUv,
} from './uv-channel';
import { type FromPatchOptions, uvFromPatch } from './uv-patch';

export interface ModelUvHost {
  getTolerance(): number;
  getMesh(): EditMesh;
  hasSurfaces(): boolean;
  domainChannel(): CornerChannelName;
  setDomainChannel(channel: CornerChannelName): void;
  carrier(): Carrier;
  uvContext(): UvContext;
  noteCarrierWrite(
    op: string,
    ids: readonly number[],
    channel: CornerChannelName | undefined,
    diagnostics: OpDiagnostic[],
  ): void;
  shouldUseRust(op: string): boolean;
  runRust(
    op: string,
    args: unknown,
    placement: object,
    body: (
      store: RustEditMeshStore,
      attribution: Attribution,
      diagnostics: OpDiagnostic[],
    ) => Result<RoleCounts, ModelingError>,
  ): OpReport;
  run(
    op: string,
    args: unknown,
    placement: object,
    body: (
      attribution: Attribution,
      diagnostics: OpDiagnostic[],
    ) => Result<RoleCounts, ModelingError>,
  ): OpReport;
  runOn(
    op: string,
    faces: FaceSelector,
    args: object,
    body: (
      ids: number[],
      attribution: Attribution,
      diagnostics: OpDiagnostic[],
    ) => Result<RoleCounts, ModelingError>,
  ): OpReport;
}

/** Construct the `model.uv` operator facade bound to a `Model` session host. */
export function createModelUvOps(host: ModelUvHost) {
  return {
    project: (options: ProjectOptions & { readonly faces?: FaceSelector }): OpReport => {
      const faces = options.faces;
      if (host.shouldUseRust('uv.project') && (faces === undefined || faces.isPureAst())) {
        return host.runRust(
          'uv.project',
          faces === undefined ? options : { selector: faces.description, ...options },
          {},
          (s) => rustUvProject(s, options),
        );
      }
      if (faces === undefined) {
        return host.run('uv.project', options, {}, (_attribution, diagnostics) => {
          host.noteCarrierWrite('uv.project', host.getMesh().faces(), options.channel, diagnostics);
          return projectUv(
            host.getMesh(),
            host.getMesh().faces(),
            options,
            host.getTolerance(),
            diagnostics,
          );
        });
      }
      return host.runOn('uv.project', faces, options, (ids, _attribution, diagnostics) => {
        host.noteCarrierWrite('uv.project', ids, options.channel, diagnostics);
        return projectUv(host.getMesh(), ids, options, host.getTolerance(), diagnostics);
      });
    },
    unwrap: (options: UnwrapOptions & { readonly faces?: FaceSelector } = {}): OpReport => {
      const args =
        options.seams === undefined ? options : { ...options, seams: describeSeams(options.seams) };
      const faces = options.faces;
      const canUseRust =
        host.shouldUseRust('uv.unwrap') &&
        (faces === undefined || faces.isPureAst()) &&
        (options.method === undefined || options.method === 'lscm') &&
        options.refine === undefined &&
        (options.seams === undefined || options.seams === 'marked' || options.seams === 'sharp');
      if (canUseRust) {
        return host.runRust(
          'uv.unwrap',
          faces === undefined ? args : { selector: faces.description, ...args },
          {},
          (s) => rustUvUnwrap(s, options),
        );
      }
      const body = (ids: number[], diagnostics: OpDiagnostic[]) => {
        host.noteCarrierWrite('uv.unwrap', ids, options.channel, diagnostics);
        const seams = seamSelection(host.getMesh(), options.seams);
        if (!seams.ok) return seams;
        return unwrapUv(host.getMesh(), ids, options, seams.value, host.uvContext(), diagnostics);
      };
      if (faces === undefined) {
        return host.run('uv.unwrap', args, {}, (_attribution, diagnostics) =>
          body(host.getMesh().faces(), diagnostics),
        );
      }
      return host.runOn('uv.unwrap', faces, args, (ids, _attribution, diagnostics) =>
        body(ids, diagnostics),
      );
    },
    plan: (options: PlanSeamsOptions & { readonly faces?: FaceSelector } = {}): OpReport => {
      const body = (ids: number[], diagnostics: OpDiagnostic[]) =>
        planSeams(host.getMesh(), ids, options, host.uvContext(), diagnostics);
      const args = describePlan(options);
      const faces = options.faces;
      if (
        host.shouldUseRust('uv.plan') &&
        (faces === undefined || faces.isPureAst()) &&
        !host.hasSurfaces() &&
        options.refine === undefined
      ) {
        return host.runRust('uv.plan', args, {}, (s) => rustUvPlan(s, faces, options));
      }
      if (faces === undefined) {
        return host.run('uv.plan', args, {}, (_attribution, diagnostics) =>
          body(host.getMesh().faces(), diagnostics),
        );
      }
      return host.runOn('uv.plan', faces, args, (ids, _attribution, diagnostics) =>
        body(ids, diagnostics),
      );
    },
    fromPatch: (options: FromPatchOptions & { readonly faces?: FaceSelector }): OpReport => {
      const read = (ids: number[], diagnostics: OpDiagnostic[]) =>
        uvFromPatch(host.getMesh(), ids, options, diagnostics, host.domainChannel());
      const faces = options.faces;
      if (faces === undefined) {
        return host.run('uv.fromPatch', options, {}, (_attribution, diagnostics) =>
          read(host.getMesh().faces(), diagnostics),
        );
      }
      return host.runOn('uv.fromPatch', faces, options, (ids, _attribution, diagnostics) =>
        read(ids, diagnostics),
      );
    },
    channel: (options: ChannelOptions & { readonly faces?: FaceSelector }): OpReport => {
      const body = (ids: number[]) => channelOp(host.getMesh(), ids, options, host.carrier());
      const faces = options.faces;
      if (faces === undefined)
        return host.run('uv.channel', options, {}, () => body(host.getMesh().faces()));
      return host.runOn('uv.channel', faces, options, (ids) => body(ids));
    },
    lightmap: (options: LightmapOptions): OpReport => {
      const pad = options.padding === undefined ? 4 : resolveRustMipPadding(options.padding);
      if (host.shouldUseRust('uv.lightmap') && !host.hasSurfaces() && Number.isFinite(pad)) {
        return host.runRust('uv.lightmap', options, {}, (s) => rustUvLightmap(s, options));
      }
      return host.run('uv.lightmap', options, {}, (_attribution, diagnostics) =>
        lightmapUv(
          host.getMesh(),
          host.getMesh().faces(),
          options,
          host.uvContext(),
          diagnostics,
          host.carrier(),
          (channel) => host.setDomainChannel(channel),
        ),
      );
    },
    straighten: (options: StraightenOptions & { readonly faces?: FaceSelector } = {}): OpReport => {
      const body = (ids: number[], diagnostics: OpDiagnostic[]) => {
        host.noteCarrierWrite('uv.straighten', ids, options.channel, diagnostics);
        const edges =
          options.edges === undefined ? undefined : options.edges.resolve(host.getMesh());
        if (edges !== undefined && !edges.ok) return edges;
        return straightenUv(
          host.getMesh(),
          ids,
          options,
          edges?.value,
          host.uvContext(),
          diagnostics,
        );
      };
      const args =
        options.edges === undefined ? options : { ...options, edges: options.edges.description };
      const faces = options.faces;
      if (
        host.shouldUseRust('uv.straighten') &&
        (faces === undefined || faces.isPureAst()) &&
        options.edges === undefined &&
        (options.channel ?? 'uv0') !== host.domainChannel() &&
        !host.hasSurfaces()
      ) {
        return host.runRust('uv.straighten', args, {}, (s) => rustUvStraighten(s, faces, options));
      }
      if (faces === undefined) {
        return host.run('uv.straighten', args, {}, (_attribution, diagnostics) =>
          body(host.getMesh().faces(), diagnostics),
        );
      }
      return host.runOn('uv.straighten', faces, args, (ids, _attribution, diagnostics) =>
        body(ids, diagnostics),
      );
    },
    pack: (options: PackOptions & { readonly faces?: FaceSelector }): OpReport => {
      const faces = options.faces;
      const canUseRust =
        host.shouldUseRust('uv.pack') &&
        (faces === undefined || faces.isPureAst()) &&
        (options.method === undefined || options.method === 'skyline') &&
        options.stack !== true &&
        options.density === undefined &&
        options.with === undefined &&
        (options.channel ?? 'uv0') !== host.domainChannel() &&
        !host.hasSurfaces();
      if (canUseRust) {
        const pad = resolveRustMipPadding(options.padding);
        if (Number.isFinite(pad) && pad >= 0) {
          return host.runRust(
            'uv.pack',
            faces === undefined ? options : { selector: faces.description, ...options },
            {},
            (s) => rustUvPack(s, options, pad),
          );
        }
      }
      if (faces === undefined) {
        return host.run('uv.pack', options, {}, (_attribution, diagnostics) => {
          host.noteCarrierWrite('uv.pack', host.getMesh().faces(), options.channel, diagnostics);
          return packUv(
            host.getMesh(),
            host.getMesh().faces(),
            options,
            host.uvContext(),
            diagnostics,
          );
        });
      }
      return host.runOn('uv.pack', faces, options, (ids, _attribution, diagnostics) => {
        host.noteCarrierWrite('uv.pack', ids, options.channel, diagnostics);
        return packUv(host.getMesh(), ids, options, host.uvContext(), diagnostics);
      });
    },
    auto: (options: AutoUvOptions & { readonly faces?: FaceSelector }): OpReport => {
      const faces = options.faces;
      const canUseRust =
        host.shouldUseRust('uv.auto') &&
        (faces === undefined || faces.isPureAst()) &&
        options.refine === undefined &&
        (options.respectSharp === undefined || typeof options.respectSharp === 'boolean') &&
        (options.method === undefined || options.method === 'lscm') &&
        (options.pack?.method === undefined || options.pack.method === 'skyline') &&
        options.pack?.stack !== true &&
        options.pack?.density === undefined &&
        (options.channel ?? 'uv0') !== host.domainChannel() &&
        !host.hasSurfaces();
      if (canUseRust) {
        const pad = resolveRustMipPadding(options.padding);
        if (Number.isFinite(pad) && pad >= 0) {
          return host.runRust(
            'uv.auto',
            faces === undefined ? options : { selector: faces.description, ...options },
            {},
            (s) => rustUvAuto(s, options, pad),
          );
        }
      }
      if (faces === undefined) {
        return host.run('uv.auto', options, {}, (_attribution, diagnostics) => {
          host.noteCarrierWrite('uv.auto', host.getMesh().faces(), options.channel, diagnostics);
          return autoUv(
            host.getMesh(),
            host.getMesh().faces(),
            options,
            host.uvContext(),
            diagnostics,
          );
        });
      }
      return host.runOn('uv.auto', faces, options, (ids, _attribution, diagnostics) => {
        host.noteCarrierWrite('uv.auto', ids, options.channel, diagnostics);
        return autoUv(host.getMesh(), ids, options, host.uvContext(), diagnostics);
      });
    },
    trim: (options: TrimUvOptions & { readonly faces: FaceSelector }): OpReport => {
      if (
        host.shouldUseRust('uv.trim') &&
        options.faces.isPureAst() &&
        !Array.isArray(options.region) &&
        options.variation === undefined &&
        options.offset === undefined &&
        (options.channel ?? 'uv0') !== host.domainChannel() &&
        !host.hasSurfaces()
      ) {
        return host.runRust('uv.trim', trimArgs(options), {}, (s) =>
          rustUvTrim(s, options.faces, options),
        );
      }
      return host.runOn(
        'uv.trim',
        options.faces,
        trimArgs(options),
        (ids, _attribution, diagnostics) => {
          host.noteCarrierWrite('uv.trim', ids, options.channel, diagnostics);
          return trimUv(host.getMesh(), ids, options, diagnostics);
        },
      );
    },
    swatch: (options: SwatchUvOptions & { readonly faces: FaceSelector }): OpReport => {
      if (
        host.shouldUseRust('uv.swatch') &&
        options.faces.isPureAst() &&
        (options.channel ?? 'uv0') !== host.domainChannel() &&
        !host.hasSurfaces()
      ) {
        return host.runRust('uv.swatch', trimArgs(options), {}, (s) =>
          rustUvSwatch(s, options.faces, options),
        );
      }
      return host.runOn(
        'uv.swatch',
        options.faces,
        trimArgs(options),
        (ids, _attribution, diagnostics) => {
          host.noteCarrierWrite('uv.swatch', ids, options.channel, diagnostics);
          return swatchUv(host.getMesh(), ids, options, diagnostics);
        },
      );
    },
  };
}
