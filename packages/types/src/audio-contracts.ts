// Audio error contracts.

// === AudioErrorCode / AudioError / AudioErrorDetail -- audio error SSOT (feat-20260527-audio-system M1 / w4) ===
//
// Decision anchors:
// - requirements S-8 (5-member independent closed union: context-creation-failed /
//   decode-failed / context-suspended / invalid-clip-handle / bus-not-found)
// - requirements AC-13 (AudioErrorCode closed union switch exhaustiveness)
// - plan-strategy D-7 (AudioErrorCode SSOT in engine-types, parallel to
//   ImageErrorCode / GltfErrorCode / AssetErrorCode)
// - plan-strategy section 8 AI User Affordance (structured 4-field surface:
//   .code / .expected / .hint / .detail)
// - charter P3 (explicit failure: switch (err.code) exhaustive without default;
//   .hint provides concrete recovery action)
// - charter P4 (consistent abstraction: structurally parallel to AssetError,
//   ImageError, GltfError same 4-field shape)
// - architecture-principles #1 SSOT (the closed literals + class shape + hints table
//   live here once; engine-audio package references this module)

/**
 * Closed `AudioErrorCode` union (plan-strategy D-7;
 * requirements S-8). Exhaustive `switch (err.code)` needs no default
 * fallback -- TypeScript guards union completeness at compile time
 * (charter P3 explicit failure).
 *
 * Domain-separated from Asset and Import errors at the audio engine surface (`@forgeax/engine-audio`
 * AudioError + `@forgeax/engine-audio-webaudio` backend).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'context-creation-failed'` | `new AudioContext()` threw or returned null (privacy browser / no audio device) |
 * | `'decode-failed'` | `decodeAudioData(arrayBuffer)` rejected (corrupt file / unsupported codec) |
 * | `'context-suspended'` | `play()` called while AudioContext.state is `'suspended'` and gesture listener failed to resume |
 * | `'invalid-clip-handle'` | AudioSource.clip handle is dangling or refers to an unregistered asset |
 * | `'control-failed'` | Host filter/FFT control is invalid or its source is not retained |
 * | `'bus-not-found'` | AudioSource.bus names an ID absent from the accepted graph |
 */
export type AudioErrorCode =
  | 'context-creation-failed'
  | 'decode-failed'
  | 'context-suspended'
  | 'invalid-clip-handle'
  | 'bus-not-found'
  | 'control-failed'
  | 'stream-failed';

/**
 * Per-code `AudioError` detail shapes -- discriminated payloads narrowed
 * by `AudioError.code` so AI users writing `switch (err.code)` get
 * control-flow-tightened access to the relevant detail fields
 * (charter P3 explicit failure).
 */

/** `context-creation-failed` payload: carries the original error reason. */
export interface AudioCtxCreationFailedDetail {
  readonly code: 'context-creation-failed';
  readonly reason: string;
}

/** `decode-failed` payload: carries the original decode error reason. */
export interface AudioDecodeFailedDetail {
  readonly code: 'decode-failed';
  readonly reason: string;
}

/** `context-suspended` payload: empty marker detail (no extra fields). */
export interface AudioCtxSuspendedDetail {
  readonly code: 'context-suspended';
}

/** `invalid-clip-handle` payload: carries the dangling handle identifier. */
export interface AudioInvalidClipHandleDetail {
  readonly code: 'invalid-clip-handle';
  readonly clipHandleId: number;
}

/** `bus-not-found` payload: carries the invalid bus name attempted. */
export interface AudioBusNotFoundDetail {
  readonly code: 'bus-not-found';
  readonly attemptedBus: string;
}

/**
 * Discriminated detail union for `AudioError`, narrowed per `AudioError.code`.
 * AI users obtain the concrete detail shape via `switch (err.code)` without
 * needing a fallback `as` cast (charter P3).
 */
export type AudioErrorDetail =
  | {
      readonly code: 'stream-failed';
      readonly reason:
        | 'unsupported-format'
        | 'range-unsupported'
        | 'range-oversized'
        | 'integrity-failed'
        | 'network-failed'
        | 'budget-exceeded';
      readonly message: string;
    }
  | AudioCtxCreationFailedDetail
  | AudioDecodeFailedDetail
  | AudioCtxSuspendedDetail
  | AudioInvalidClipHandleDetail
  | AudioBusNotFoundDetail
  | { readonly code: 'control-failed'; readonly reason: string };

/**
 * Structured audio error -- four-field surface (`.code` / `.expected` /
 * `.hint` / `.detail`) structurally parallel to `@forgeax/engine-types`
 * `AssetError` + `ImageError` + `GltfError` same-shape errors
 * (charter P4 consistent abstraction; AGENTS.md "Errors are structured.
 * Return Result, never throw for expected failures.").
 *
 * AI users consume the structured triple via property access:
 * `switch (err.code) { case 'decode-failed': ... err.hint ... }`
 * -- never by parsing `.message` (charter P3 explicit failure red line).
 *
 * The `.message` field is auto-composed for human stack traces and carries
 * the same content as `.code` + `.expected` + `.hint`; AI users prefer
 * field access on the structured triple.
 *
 * @example AI-user exhaustive switch on the closed union (no default fallback)
 * ```ts
 * import { AudioError, type AudioErrorCode } from '@forgeax/engine-types';
 *
 * function recover(code: AudioErrorCode): string {
 *   switch (code) {
 *     case 'context-creation-failed': return 'check browser supports AudioContext';
 *     case 'decode-failed':          return 'ensure audio file is a valid wav/mp3/ogg/flac';
 *     case 'context-suspended':      return 'call play after user gesture to trigger resume';
 *     case 'invalid-clip-handle':    return 'verify clip was registered via AssetRegistry';
 *     case 'control-failed':        return 'inspect detail.reason and correct the Host control';
 *     case 'bus-not-found':          return 'configure the requested bus ID';
 *     case 'stream-failed':          return 'inspect the closed reason and repair source/Range/budget';
 *   }
 * }
 * ```
 */
export class AudioError extends Error {
  readonly code: AudioErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: AudioErrorDetail;

  constructor(args: {
    code: AudioErrorCode;
    expected: string;
    hint: string;
    detail?: AudioErrorDetail;
  }) {
    super(`[AudioError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'AudioError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    if (args.detail !== undefined) {
      this.detail = args.detail;
    }
  }
}

/**
 * Per-code `.hint` string literals SSOT (plan-strategy D-7 lock-in).
 * Exported so engine-audio error helpers and tests consume the same SSOT
 * -- any drift here updates both producer call sites and the AGENTS.md
 * Error model table.
 *
 * The shape is a `Record<AudioErrorCode, string>` so future additions to
 * the closed union are a compile-time error here as well (reinforces
 * charter P3 explicit failure). Each hint embeds an executable recovery
 * action so AI users self-repair (charter P3).
 */
export const AUDIO_ERROR_HINTS: Readonly<Record<AudioErrorCode, string>> = {
  'stream-failed':
    'inspect the stream source/Range host/byte budget and retry explicitly after repair',
  'control-failed':
    'wait for a retained source; use distinct nodes from the supplied Host context and a valid FFT size',
  'context-creation-failed':
    'check browser supports AudioContext; verify no privacy extension blocks audio; try reloading the page after user gesture',
  'decode-failed':
    'ensure audio file is a valid wav/mp3/ogg/flac at the GUID path; check file integrity (truncated or empty bytes)',
  'context-suspended':
    'call play after a user gesture (click/tap/keydown) to trigger AudioContext.resume(); if in iframe check sandbox attribute',
  'invalid-clip-handle':
    'verify clip was registered via AssetRegistry.register() before spawning AudioSource; inspect active handles via assetRegistry.inspect()',
  'bus-not-found': 'declare the bus ID in the accepted audio graph before playback',
};
