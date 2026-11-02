import type { RenderGraphPassExecution, RenderGraphPassRunner } from '@forgeax/engine-render-graph';
import type { TextureView } from '@forgeax/engine-rhi';
import type {
  GraphTargetPassReplayPrefixReceipt,
  GraphTargetPassReplayReceipt,
  RenderFrameState,
} from './frame-snapshot';

type PassReplayCapture = Extract<
  NonNullable<RenderFrameState['graphTargetCapture']>,
  { kind: 'pass-replay' }
>;

export interface GraphTargetReplayTarget {
  readonly name: string;
  readonly view: TextureView;
  readonly texture: import('@forgeax/engine-rhi').Texture;
  readonly textureIdentity: number;
  readonly graphGeneration: number;
}

interface ReplayRunnerInput {
  readonly requestedPassNames: ReadonlySet<string>;
  readonly selectedReplayPassNames: readonly string[];
  readonly capture: PassReplayCapture | undefined;
  readonly target: GraphTargetReplayTarget | undefined;
  readonly runPass: RenderGraphPassRunner | undefined;
  readonly replayFailure: (reason: string) => void;
  readonly replayValidationFailed: () => boolean;
}

interface ReplayRunnerState {
  readonly replayedPassNames: Set<string>;
  readonly target: GraphTargetReplayTarget | undefined;
  readonly input: ReplayRunnerInput;
  depthAnchorReceipt?: {
    readonly pass: { name: string; executionIndex: number };
    readonly view: TextureView;
  };
  prefixCallbackCount: number;
}

export interface GraphTargetReplayRunnerState {
  readonly runner: RenderGraphPassRunner;
  readonly replayedPassNames: ReadonlySet<string>;
  prefixCallbackCount(): number;
}

export interface GraphTargetReplaySelection {
  readonly selectedPassNames: readonly string[];
  readonly requestedPassNames: ReadonlySet<string>;
}

export interface GraphTargetReplayTargetAccess {
  readonly graphGeneration: number;
  getColorTargetDescriptor(name: string): { readonly texture: object } | undefined;
  getColorTargetView(name: string): TextureView | undefined;
  getColorTargetTexture(name: string): import('@forgeax/engine-rhi').Texture | undefined;
}

export type GraphTargetReplayRunResult<Error> =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: Error };

export type GraphTargetReplayExecutionResult<Error> =
  | { readonly ok: true }
  | { readonly ok: false; readonly stage: 'validation' }
  | { readonly ok: false; readonly stage: 'initial' | 'replay'; readonly error: Error };

function validateSelectedNames(
  selected: readonly string[],
  available: readonly string[],
  fail: (reason: string) => void,
): boolean {
  if (selected.length === 0) {
    fail('replay-pass-selection-empty');
    return false;
  }
  const availableSet = new Set(available);
  const availableCounts = new Map<string, number>();
  for (const name of available) availableCounts.set(name, (availableCounts.get(name) ?? 0) + 1);
  const duplicate = selected.find((name, index) => selected.indexOf(name) !== index);
  if (duplicate !== undefined) {
    fail(`replay-pass-selection-duplicate:${duplicate}`);
    return false;
  }
  const unknown = selected.find((name) => !availableSet.has(name));
  if (unknown !== undefined) {
    fail(`replay-pass-selection-unknown:${unknown}`);
    return false;
  }
  const nonUnique = selected.find((name) => availableCounts.get(name) !== 1);
  if (nonUnique !== undefined) {
    fail(`replay-pass-selection-non-unique:${nonUnique}`);
    return false;
  }
  return true;
}

function validatePrefixSelection(
  capture: PassReplayCapture,
  selected: readonly string[],
  available: readonly string[],
  fail: (reason: string) => void,
): boolean {
  if (capture.onPrefixEncoded === undefined) return true;
  if (capture.onPassEncoded !== undefined) {
    fail('pass-replay-prefix-callback-conflict');
    return false;
  }
  if (capture.depthAttachmentPassName === undefined) {
    fail('pass-replay-depth-attachment-name-missing');
    return false;
  }
  if (capture.observeAfterPassName === undefined) {
    fail('pass-replay-observe-boundary-name-missing');
    return false;
  }
  const firstNonPrefix = selected.find((name, index) => name !== available[index]);
  if (firstNonPrefix !== undefined || selected.length > available.length) {
    fail('pass-replay-selection-not-prefix');
    return false;
  }
  if (selected.at(-1) !== capture.observeAfterPassName) {
    fail('pass-replay-observe-boundary-not-last');
    return false;
  }
  const anchorIndex = selected.indexOf(capture.depthAttachmentPassName);
  if (anchorIndex < 0 || anchorIndex > selected.length - 1) {
    fail('pass-replay-depth-attachment-not-in-prefix');
    return false;
  }
  return true;
}

export function prepareGraphTargetReplaySelection(input: {
  readonly capture: RenderFrameState['graphTargetCapture'];
  readonly replayPassNames: readonly string[] | undefined;
  readonly availablePassNames: readonly string[];
  readonly unsupportedCaptureKind: boolean;
  readonly fail: (reason: string) => void;
}): GraphTargetReplaySelection | undefined {
  if (input.unsupportedCaptureKind) {
    input.fail('capture-kind-unknown');
    return undefined;
  }
  const selected = input.replayPassNames;
  if (selected === undefined) {
    input.fail('replay-pass-selection-missing');
    return undefined;
  }
  if (!validateSelectedNames(selected, input.availablePassNames, input.fail)) return undefined;
  const replayCapture = input.capture?.kind === 'pass-replay' ? input.capture : undefined;
  if (
    replayCapture !== undefined &&
    !validatePrefixSelection(replayCapture, selected, input.availablePassNames, input.fail)
  ) {
    return undefined;
  }
  return { selectedPassNames: selected, requestedPassNames: new Set(selected) };
}

export function resolveGraphTargetReplayTarget(input: {
  readonly capture: RenderFrameState['graphTargetCapture'];
  readonly access: GraphTargetReplayTargetAccess | undefined | null;
  readonly getTextureIdentity: (texture: import('@forgeax/engine-rhi').Texture) => number;
  readonly fail: (reason: string) => void;
}): GraphTargetReplayTarget | undefined {
  const capture = input.capture?.kind === 'pass-replay' ? input.capture : undefined;
  if (capture?.onPassEncoded === undefined && capture?.onPrefixEncoded === undefined)
    return undefined;
  const targetName = capture?.targetName;
  if (targetName === undefined) {
    input.fail('pass-replay-target-name-missing');
    return undefined;
  }
  const access = input.access;
  if (access === undefined || access === null) {
    input.fail(`pass-replay-target-missing:${targetName}`);
    return undefined;
  }
  const view = access.getColorTargetView(targetName);
  const texture = access.getColorTargetTexture(targetName);
  if (view === undefined || texture === undefined) {
    input.fail(`pass-replay-target-missing:${targetName}`);
    return undefined;
  }
  const descriptor = access.getColorTargetDescriptor(targetName);
  if (descriptor !== undefined && descriptor.texture !== texture) {
    input.fail(`pass-replay-target-identity-mismatch:${targetName}`);
    return undefined;
  }
  return {
    name: targetName,
    view,
    texture,
    textureIdentity: input.getTextureIdentity(texture),
    graphGeneration: access.graphGeneration,
  };
}

/** Validate and execute a requested replay after the normal graph submission pass. */
export function executeGraphTargetReplay<Error>(input: {
  readonly capture: RenderFrameState['graphTargetCapture'];
  readonly replayPassNames: readonly string[] | undefined;
  readonly unsupportedCaptureKind: boolean;
  readonly availablePassNames: readonly string[];
  readonly graphTargetAccess: GraphTargetReplayTargetAccess | undefined | null;
  readonly getTextureIdentity: (texture: import('@forgeax/engine-rhi').Texture) => number;
  readonly runPass: RenderGraphPassRunner | undefined;
  readonly executeInitial: () => GraphTargetReplayRunResult<Error>;
  readonly executeReplay: (runner: RenderGraphPassRunner) => GraphTargetReplayRunResult<Error>;
  readonly reportFailure: (reason: string, availablePassNames: readonly string[]) => void;
}): GraphTargetReplayExecutionResult<Error> {
  let validationFailed = false;
  const fail = (reason: string): void => {
    validationFailed = true;
    input.reportFailure(reason, input.availablePassNames);
  };
  const selection = prepareGraphTargetReplaySelection({
    capture: input.capture,
    replayPassNames: input.replayPassNames,
    availablePassNames: input.availablePassNames,
    unsupportedCaptureKind: input.unsupportedCaptureKind,
    fail,
  });
  if (selection === undefined) return { ok: false, stage: 'validation' };
  const target = resolveGraphTargetReplayTarget({
    capture: input.capture,
    access: input.graphTargetAccess,
    getTextureIdentity: input.getTextureIdentity,
    fail,
  });
  if (validationFailed) return { ok: false, stage: 'validation' };
  const initial = input.executeInitial();
  if (!initial.ok) return { ok: false, stage: 'initial', error: initial.error };
  const passReplayCapture = input.capture?.kind === 'pass-replay' ? input.capture : undefined;
  const replayRunner = createGraphTargetReplayRunner({
    requestedPassNames: selection.requestedPassNames,
    selectedReplayPassNames: selection.selectedPassNames,
    capture: passReplayCapture,
    target,
    runPass: input.runPass,
    replayFailure: fail,
    replayValidationFailed: () => validationFailed,
  });
  const replayed = input.executeReplay(replayRunner.runner);
  if (!replayed.ok) return { ok: false, stage: 'replay', error: replayed.error };
  if (validationFailed) return { ok: false, stage: 'validation' };
  if (replayRunner.replayedPassNames.size !== selection.requestedPassNames.size) {
    fail('replay-pass-selection-zero-hit');
    return { ok: false, stage: 'validation' };
  }
  if (
    passReplayCapture?.onPrefixEncoded !== undefined &&
    replayRunner.prefixCallbackCount() !== 1
  ) {
    fail('pass-replay-prefix-callback-count-invalid');
    return { ok: false, stage: 'validation' };
  }
  return { ok: true };
}

function callbackError(passName: string, kind: string, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return `${kind}:${passName}:${message}`;
}

function depthAttachmentView(pass: RenderGraphPassExecution): TextureView | undefined {
  return (pass as { resolvedDepthStencilAttachmentView?: TextureView })
    .resolvedDepthStencilAttachmentView;
}

function forwardPass(
  input: ReplayRunnerInput,
  pass: RenderGraphPassExecution,
  encode: () => void,
): void {
  if (input.runPass === undefined) encode();
  else input.runPass(pass, encode);
}

function recordPrefixPass(
  state: ReplayRunnerState,
  capture: PassReplayCapture,
  pass: RenderGraphPassExecution,
  encode: () => void,
): void {
  const { replayFailure, replayValidationFailed } = state.input;
  const target = state.target;
  const depthView = depthAttachmentView(pass);
  if (pass.name === capture.depthAttachmentPassName) {
    if (depthView === undefined) {
      replayFailure(`pass-replay-depth-attachment-missing:${pass.name}`);
      return;
    }
    if (target === undefined || depthView !== target.view) {
      replayFailure(`pass-replay-attachment-target-mismatch:${pass.name}`);
      return;
    }
    if (state.depthAnchorReceipt !== undefined) {
      replayFailure(`pass-replay-depth-attachment-multiple-hit:${pass.name}`);
      return;
    }
    state.depthAnchorReceipt = {
      pass: { name: pass.name, executionIndex: pass.executionIndex },
      view: depthView,
    };
  }
  let encoded = false;
  const encodePrefix = () => {
    if (encoded) {
      replayFailure(`pass-replay-encode-multiple-hit:${pass.name}`);
      return;
    }
    encode();
    encoded = true;
    if (replayValidationFailed() || pass.name !== capture.observeAfterPassName) return;
    if (target === undefined || state.depthAnchorReceipt === undefined) {
      replayFailure('pass-replay-depth-attachment-anchor-missing-at-boundary');
      return;
    }
    const receipt = prefixReceipt(state, pass);
    try {
      capture.onPrefixEncoded?.(receipt);
      state.prefixCallbackCount += 1;
    } catch (cause) {
      replayFailure(callbackError(pass.name, 'pass-replay-prefix-callback-threw', cause));
    }
  };
  forwardPass(state.input, pass, encodePrefix);
  if (!encoded && !replayValidationFailed()) {
    replayFailure(`pass-replay-encode-not-called:${pass.name}`);
  }
}

function prefixReceipt(
  state: ReplayRunnerState,
  pass: RenderGraphPassExecution,
): GraphTargetPassReplayPrefixReceipt {
  const target = state.target;
  const anchor = state.depthAnchorReceipt;
  if (target === undefined || anchor === undefined) {
    throw new Error('Pass replay prefix receipt requires a target and depth anchor.');
  }
  return {
    ...singlePassReceipt(target, pass, anchor.view),
    replayPassNames: [...state.input.selectedReplayPassNames],
    depthAttachmentPassName: anchor.pass.name,
    observeAfterPassName: pass.name,
    depthAttachmentExecutionIndex: anchor.pass.executionIndex,
  };
}

function recordObservedPass(
  state: ReplayRunnerState,
  capture: PassReplayCapture,
  pass: RenderGraphPassExecution,
  encode: () => void,
): void {
  const { replayFailure, replayValidationFailed } = state.input;
  const target = state.target;
  const depthView = depthAttachmentView(pass);
  if (target === undefined || depthView === undefined) {
    replayFailure(`pass-replay-depth-attachment-missing:${pass.name}`);
    return;
  }
  if (depthView !== target.view) {
    replayFailure(`pass-replay-attachment-target-mismatch:${pass.name}`);
    return;
  }
  let encoded = false;
  const encodeAndObserve = () => {
    if (encoded) {
      replayFailure(`pass-replay-encode-multiple-hit:${pass.name}`);
      return;
    }
    encode();
    encoded = true;
    if (replayValidationFailed()) return;
    try {
      capture.onPassEncoded?.(singlePassReceipt(target, pass, depthView));
    } catch (cause) {
      replayFailure(callbackError(pass.name, 'pass-replay-callback-threw', cause));
    }
  };
  forwardPass(state.input, pass, encodeAndObserve);
  if (!encoded && !replayValidationFailed()) {
    replayFailure(`pass-replay-encode-not-called:${pass.name}`);
  }
}

function singlePassReceipt(
  target: GraphTargetReplayTarget,
  pass: RenderGraphPassExecution,
  depthView: TextureView,
): GraphTargetPassReplayReceipt {
  return {
    passName: pass.name,
    executionIndex: pass.executionIndex,
    resolvedDepthStencilAttachmentView: depthView,
    graphGeneration: target.graphGeneration,
    targetName: target.name,
    targetView: target.view,
    targetTexture: target.texture,
    targetTextureIdentity: target.textureIdentity,
  };
}

function recordSelectedPass(
  state: ReplayRunnerState,
  pass: RenderGraphPassExecution,
  encode: () => void,
): void {
  const { requestedPassNames, replayFailure } = state.input;
  if (!requestedPassNames.has(pass.name)) return;
  if (state.replayedPassNames.has(pass.name)) {
    replayFailure(`replay-pass-selection-multiple-hit:${pass.name}`);
    return;
  }
  state.replayedPassNames.add(pass.name);
  const capture = state.input.capture;
  if (capture?.onPrefixEncoded !== undefined) {
    recordPrefixPass(state, capture, pass, encode);
    return;
  }
  if (capture?.onPassEncoded === undefined) {
    forwardPass(state.input, pass, encode);
    return;
  }
  recordObservedPass(state, capture, pass, encode);
}

/** Capture selected graph-pass receipts while preserving the caller's encoder wrapper. */
export function createGraphTargetReplayRunner(
  input: ReplayRunnerInput,
): GraphTargetReplayRunnerState {
  const state: ReplayRunnerState = {
    replayedPassNames: new Set<string>(),
    target: input.target,
    input,
    prefixCallbackCount: 0,
  };
  return {
    runner: (pass, encode) => recordSelectedPass(state, pass, encode),
    replayedPassNames: state.replayedPassNames,
    prefixCallbackCount: () => state.prefixCallbackCount,
  };
}
