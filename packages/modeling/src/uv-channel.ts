import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import { patchTags } from './finish';
import { CORNER_CHANNEL_DIMENSIONS, type CornerChannelName, type EditMesh } from './mesh';
import type { OpDiagnostic, RoleCounts } from './ops';
import { defaultProtectMip, type PackOptions, packUv, type UvContext } from './uv';

export const CHANNEL_OPS = ['copy', 'swap', 'delete'] as const;
export type ChannelOp = (typeof CHANNEL_OPS)[number];

export interface ChannelOptions {
  readonly op: ChannelOp;
  /** copy: the channel read; swap: one of the two channels. */
  readonly from?: CornerChannelName;
  /** copy: the channel written; swap: the other channel; delete: the channel cleared. */
  readonly to?: CornerChannelName;
}

export interface LightmapOptions {
  /** Square lightmap size in texels. */
  readonly resolution: number;
  /** Texels between islands; default `{ mips: k }` with k the largest keeping the 128-texel mip free of bleeding. */
  readonly padding?: PackOptions['padding'];
  /** Island source (default and only value: the current uv0 islands). */
  readonly from?: 'uv0';
  /** Layout of the pack; a lightmap never stacks congruent islands. */
  readonly pack?: Pick<PackOptions, 'method' | 'rotate' | 'snap'>;
  /**
   * `copyTo-uv2`: when uv1 still holds the patch domain, copy it to uv2 first and record uv2 as the
   * domain carrier (`{ mode: 'surface' }` normals read it there).
   */
  readonly domain?: 'copyTo-uv2';
}

/** What the session records about the patch-domain carrier (BK56). */
export interface Carrier {
  readonly channel: CornerChannelName;
  readonly surfaces: readonly { readonly name: string }[];
}

function fail(
  code: 'model-invalid-argument' | 'model-precondition',
  message: string,
  detail: Record<string, unknown>,
  hint?: string,
) {
  return err(modelingError(code, message, detail, hint));
}

/** True when `channel` is the recorded carrier and a face of a recorded patch has a value in it. */
function holdsDomain(
  mesh: EditMesh,
  carrier: Carrier,
  channel: CornerChannelName,
  faces: readonly number[],
) {
  if (channel !== carrier.channel || !mesh.channels.has(channel)) return false;
  const tags = carrier.surfaces.flatMap((s) => patchTags(mesh, s.name)).filter((t) => t >= 0);
  return faces.some(
    (f) =>
      tags.some((t) => mesh.hasTag(f, t)) &&
      mesh.faceHalves(f).some((h) => mesh.corner(channel, h) !== undefined),
  );
}

function protectedChannel(op: string, channel: CornerChannelName) {
  return fail(
    'model-precondition',
    `${op} leaves the patch-domain carrier ${channel} alone`,
    { code: 'channel-protected', channel },
    'run uv.lightmap with domain copyTo-uv2 to move the patch domain, or pick another channel',
  );
}

/**
 * `m.surface` after `uv.lightmap` moved the carrier: the new faces' patch domain, which the
 * patch builder wrote to uv1, is copied to the recorded carrier so the domain readers find
 * every patch there. uv1 keeps the same values as a placeholder lightmap (a channel must be
 * complete to export); run `uv.lightmap` again to pack them.
 */
export function moveDomainToCarrier(
  mesh: EditMesh,
  faces: readonly number[],
  channel: CornerChannelName,
  diagnostics: OpDiagnostic[],
): void {
  let moved = 0;
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      const v = mesh.corner('uv1', h);
      if (v !== undefined) mesh.setCorner(channel, h, v);
    }
    moved++;
  }
  if (moved > 0)
    diagnostics.push({
      severity: 'warn',
      message: `m.surface wrote the patch domain of ${moved} face(s) to ${channel}; their uv1 is a placeholder until uv.lightmap runs again`,
      detail: { code: 'domain-carrier', carrier: channel, faces: moved },
    });
}

/**
 * A UV operator whose output `channel` holds the patch domain of any of `faces` overwrites it: legacy
 * behaviour (the default carrier uv1 is a free channel to `uv.project`), so it is reported, not refused.
 */
export function carrierOverwriteNote(
  op: string,
  mesh: EditMesh,
  faces: readonly number[],
  channel: CornerChannelName | undefined,
  carrier: Carrier,
  diagnostics: OpDiagnostic[],
): void {
  const target = channel ?? 'uv0';
  if (!holdsDomain(mesh, carrier, target, faces)) return;
  diagnostics.push({
    severity: 'warn',
    message: `${op} overwrites the patch domain held in ${target}; the exact surface normals of those faces are lost; write another channel, or move the domain first with uv.lightmap copyTo-uv2`,
    detail: { code: 'domain-overwritten', channel: target },
  });
}

const known = (name: unknown): name is CornerChannelName =>
  typeof name === 'string' && Object.hasOwn(CORNER_CHANNEL_DIMENSIONS, name);

/** Copy, swap or delete whole corner channels of `faces`. The recorded carrier and uv0 (delete) are refused. */
export function channelOp(
  mesh: EditMesh,
  faces: readonly number[],
  options: ChannelOptions,
  carrier: Carrier,
): Result<RoleCounts, ModelingError> {
  if (!CHANNEL_OPS.includes(options.op))
    return fail('model-invalid-argument', 'uv.channel op is copy, swap or delete', {
      op: options.op,
    });
  const { op, from, to } = options;
  const names = op === 'delete' ? [to] : [from, to];
  if (!names.every(known) || (op !== 'delete' && from === to))
    return fail(
      'model-invalid-argument',
      op === 'delete'
        ? 'uv.channel delete names the channel to clear as to'
        : `uv.channel ${op} names two different channels as from and to`,
      { op, from, to },
    );
  if (op === 'delete') {
    if (to === 'uv0') return protectedChannel('uv.channel delete', 'uv0');
    if (holdsDomain(mesh, carrier, to as CornerChannelName, faces))
      return protectedChannel('uv.channel delete', to as CornerChannelName);
  } else {
    if (
      CORNER_CHANNEL_DIMENSIONS[from as CornerChannelName] !==
      CORNER_CHANNEL_DIMENSIONS[to as CornerChannelName]
    )
      return fail('model-invalid-argument', `uv.channel ${op} joins channels of one dimension`, {
        op,
        from,
        to,
      });
    const written = op === 'copy' ? [to] : [from, to];
    for (const name of written)
      if (holdsDomain(mesh, carrier, name as CornerChannelName, faces))
        return protectedChannel(`uv.channel ${op}`, name as CornerChannelName);
    if (!mesh.channels.has(from as CornerChannelName))
      return fail('model-precondition', `uv.channel ${op} reads a channel the mesh carries`, {
        code: 'channel-missing',
        channel: from,
      });
  }
  let moved = 0;
  if (op === 'delete') {
    const channel = to as CornerChannelName;
    const c = mesh.channels.get(channel);
    if (c === undefined) return ok({ cleared: 0 });
    for (const f of faces)
      for (const h of mesh.faceHalves(f)) {
        if (c.set[h] === 1) moved++;
        c.set[h] = 0;
      }
    if (faces.length === mesh.faceCount) mesh.channels.delete(channel);
    return ok({ cleared: moved });
  }
  const a = from as CornerChannelName;
  const b = to as CornerChannelName;
  for (const f of faces)
    for (const h of mesh.faceHalves(f)) {
      const x = mesh.corner(a, h);
      const y = mesh.corner(b, h);
      const xs = x === undefined ? undefined : Array.from(x);
      const ys = y === undefined ? undefined : Array.from(y);
      const write = (name: CornerChannelName, v: number[] | undefined) => {
        if (v === undefined) {
          const c = mesh.channels.get(name);
          if (c !== undefined) c.set[h] = 0;
        } else mesh.setCorner(name, h, v);
      };
      write(b, xs);
      if (op === 'swap') write(a, ys);
      moved++;
    }
  return ok({ [op === 'copy' ? 'copied' : 'swapped']: moved });
}

/**
 * Lightmap uv1 (BK56): the uv0 islands packed once into the unit square of uv1 (no stacking,
 * normalized to one texel density, `resolution` texels, mip-safe padding). uv0 is never written.
 * A uv1 that still holds the patch domain is refused unless `domain: 'copyTo-uv2'`, which keeps
 * the domain in uv2 and records it there through `moveCarrier`.
 */
export function lightmapUv(
  mesh: EditMesh,
  faces: readonly number[],
  options: LightmapOptions,
  context: UvContext,
  diagnostics: OpDiagnostic[],
  carrier: Carrier,
  moveCarrier: (channel: CornerChannelName) => void,
): Result<RoleCounts, ModelingError> {
  const { resolution } = options;
  if (!(Number.isFinite(resolution) && resolution > 0))
    return fail('model-invalid-argument', 'uv.lightmap resolution is a positive number of texels', {
      resolution,
    });
  if (options.from !== undefined && options.from !== 'uv0')
    return fail('model-invalid-argument', 'uv.lightmap from is uv0', { from: options.from });
  if (options.domain !== undefined && options.domain !== 'copyTo-uv2')
    return fail('model-invalid-argument', 'uv.lightmap domain is copyTo-uv2', {
      domain: options.domain,
    });
  const missing = faces.find((f) =>
    mesh.faceHalves(f).some((h) => mesh.corner('uv0', h) === undefined),
  );
  if (missing !== undefined)
    return fail(
      'model-precondition',
      'every lightmapped face has uv0 islands',
      { code: 'no-source-uv', face: missing },
      'project or unwrap these faces into uv0 first',
    );
  const holds = holdsDomain(mesh, carrier, 'uv1', mesh.faces());
  if (holds && options.domain === undefined)
    return fail(
      'model-precondition',
      'uv.lightmap leaves a uv1 that holds the patch domain alone',
      { code: 'patch-domain-carrier', channel: 'uv1' },
      "pass domain: 'copyTo-uv2' to keep the patch domain in uv2",
    );
  const all = mesh.faces();
  if (holds) {
    const uv2 = mesh.channels.get('uv2');
    if (uv2 !== undefined && all.some((f) => mesh.faceHalves(f).some((h) => uv2.set[h] === 1)))
      return fail(
        'model-precondition',
        'uv2 is free to receive the patch domain',
        { code: 'channel-occupied', channel: 'uv2' },
        'clear uv2 with uv.channel delete first',
      );
    for (const f of all)
      for (const h of mesh.faceHalves(f)) {
        const v = mesh.corner('uv1', h);
        if (v !== undefined) mesh.setCorner('uv2', h, v);
      }
  }
  for (const f of faces)
    for (const h of mesh.faceHalves(f))
      mesh.setCorner('uv1', h, mesh.corner('uv0', h) as Float32Array);
  const padding = options.padding ?? { mips: Math.min(10, defaultProtectMip(resolution)) };
  const packed = packUv(
    mesh,
    faces,
    {
      resolution,
      padding,
      normalize: true,
      stack: false,
      channel: 'uv1',
      ...(options.pack?.method === undefined ? {} : { method: options.pack.method }),
      ...(options.pack?.rotate === undefined ? {} : { rotate: options.pack.rotate }),
      ...(options.pack?.snap === undefined ? {} : { snap: options.pack.snap }),
    },
    context,
    diagnostics,
  );
  if (!packed.ok) return packed;
  if (holds) moveCarrier('uv2');
  diagnostics.push({
    severity: 'info',
    message: `uv.lightmap packed uv1 at ${resolution} texels${holds ? ' (patch domain kept in uv2)' : ''}`,
    detail: { resolution, padding, carrier: holds ? 'uv2' : carrier.channel },
  });
  return packed;
}
