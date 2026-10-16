import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ok } from '@forgeax/engine-types';
import { cookParticleCodeEffect, type ParticleCodeModuleSet } from '@forgeax/engine-vfx-compiler';
import { VFX_DIAGNOSTIC_TAPE_BYTES } from './vfx-mesh-lighting.transport';

export type SaveVfxMeshLightingFailure = (
  lane: 'full' | 'limit16',
  state: unknown,
  tape?: string,
) => Promise<void>;

const hostCookRecords: {
  readonly call: number;
  readonly startedAt: string;
  readonly startedMs: number;
  completedAt?: string;
  elapsedMs?: number;
  programs?: readonly { readonly id: string; readonly bytes: number; readonly sha256: string }[];
}[] = [];
let hostCookCalls = 0;

/** Test-host cooking only; no compiler or source evaluation enters the player. */
export const vfxMeshLightingCommands = {
  async saveVfxMeshLightingFailure(
    context: { readonly project: { readonly config: { readonly root: string } } },
    ...args: Parameters<SaveVfxMeshLightingFailure>
  ) {
    const [lane, state, tape] = args;
    if (lane !== 'full' && lane !== 'limit16') throw new Error('Unknown VFX failure lane');
    const evidence = resolve(
      context.project.config.root,
      'artifacts/ci-focus/vfx-mesh-lighting',
      lane,
    );
    await mkdir(evidence, { recursive: true });
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const receipt: Record<string, unknown> = {
      sourceSha,
      state,
      hostCook: {
        nodeVersion: process.version,
        calls: hostCookCalls,
        records: hostCookRecords.map((row) => ({
          ...row,
          elapsedMs: row.elapsedMs ?? performance.now() - row.startedMs,
          completed: row.elapsedMs !== undefined,
        })),
        qualification:
          'Node-host cook invocation wall durations including async waits. Browser RPC delay and unrelated event-loop work are not exclusive compiler CPU time.',
      },
      qualification:
        'The original browser gate failed. Any following diagnostic frame is not acceptance.',
    };
    if (tape !== undefined) {
      if (tape.length > 4 * Math.ceil(VFX_DIAGNOSTIC_TAPE_BYTES / 3))
        throw new Error('VFX diagnostic tape exceeds 64MiB');
      const bytes = Buffer.from(tape, 'base64');
      if (bytes.byteLength > VFX_DIAGNOSTIC_TAPE_BYTES)
        throw new Error('VFX diagnostic tape exceeds 64MiB');
      if (bytes.toString('base64') !== tape)
        throw new Error('Invalid VFX diagnostic tape encoding');
      await writeFile(resolve(evidence, 'following-frame.rhitape'), bytes);
      receipt.tape = {
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }
    await writeFile(resolve(evidence, 'failure.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  },
  async cookVfxMeshLighting(
    _context: unknown,
    source: unknown,
    modules: Readonly<Record<string, ParticleCodeModuleSet>>,
  ) {
    const record: (typeof hostCookRecords)[number] = {
      call: ++hostCookCalls,
      startedAt: new Date().toISOString(),
      startedMs: performance.now(),
    };
    if (hostCookRecords.length >= 256) hostCookRecords.shift();
    hostCookRecords.push(record);
    try {
      const cooked = await cookParticleCodeEffect(source, modules);
      if (cooked.ok)
        record.programs = cooked.value.asset.program.emitters.map((emitter) => ({
          id: emitter.id,
          bytes: Buffer.byteLength(emitter.wgsl),
          sha256: createHash('sha256').update(emitter.wgsl).digest('hex'),
        }));
      return cooked.ok ? ok({ asset: cooked.value.asset }) : cooked;
    } finally {
      record.elapsedMs = performance.now() - record.startedMs;
      record.completedAt = new Date().toISOString();
    }
  },
};
