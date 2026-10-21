import type {
  AssetDecoder,
  AssetDecoderInput,
  AssetDecoderLease,
  AssetKind,
  AssetLoadError,
  AssetPreparationContext,
  Result,
} from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';
import { copyAssetData } from './asset-data';
import { freezeRuntimePayload } from './immutable-payload.js';

interface DecoderEntry {
  readonly identity: symbol;
  readonly decoder: AssetDecoder<unknown>;
  readonly decode: (input: AssetDecoderInput<unknown>) => Promise<Result<unknown, AssetLoadError>>;
  references: number;
}

interface DecoderRegistryOptions {
  readonly scopeId?: string;
}

export class DecoderRegistry {
  referencePolicy(kind: string): 'eager' | 'deferred' {
    return this.dispatch.get(kind)?.decoder.references ?? 'eager';
  }
  private readonly dispatch = new Map<string, DecoderEntry>();
  private readonly scopeId: string;
  private disposed = false;

  constructor(options: DecoderRegistryOptions = {}) {
    this.scopeId = options.scopeId ?? 'asset-runtime';
  }

  install<P, K extends string>(kind: AssetKind<P, K>, decoder: AssetDecoder<P>): AssetDecoderLease {
    if (this.disposed) throw new TypeError('asset runtime decoder registry is disposed');
    if (typeof kind.kind !== 'string' || kind.kind.trim().length === 0)
      throw new TypeError('asset decoder kind must be a non-empty string');
    if (typeof decoder.decode !== 'function')
      throw new TypeError(`asset decoder for "${kind.kind}" must provide decode(input)`);
    if (decoder.prepare !== undefined && typeof decoder.prepare !== 'function')
      throw new TypeError(
        `asset decoder for "${kind.kind}" must provide synchronous prepare(value, context)`,
      );
    const normalizedDecoder = decoder as AssetDecoder<unknown>;
    const existing = this.dispatch.get(kind.kind);
    if (existing !== undefined) {
      if (existing.decoder !== normalizedDecoder) {
        throw new TypeError(`duplicate decoder kind "${kind.kind}"`);
      }
      existing.references += 1;
      return this.createLease(kind.kind, existing);
    }
    const identity = Symbol(kind.kind);
    const entry: DecoderEntry = {
      identity,
      decoder: normalizedDecoder,
      decode: (input) =>
        decoder.decode(input as AssetDecoderInput<P>) as Promise<Result<unknown, AssetLoadError>>,
      references: 1,
    };
    this.dispatch.set(kind.kind, entry);
    return this.createLease(kind.kind, entry);
  }

  private createLease(kind: string, entry: DecoderEntry): AssetDecoderLease {
    let released = false;
    return {
      kind,
      dispose: () => {
        if (released) return;
        released = true;
        entry.references -= 1;
        if (entry.references === 0 && this.dispatch.get(kind)?.identity === entry.identity) {
          this.dispatch.delete(kind);
        }
      },
    };
  }

  has<P, K extends string>(kind: AssetKind<P, K>): boolean {
    return this.dispatch.has(kind.kind);
  }

  canPrepare(kind: string): boolean {
    return this.dispatch.get(kind)?.decoder.prepare !== undefined;
  }

  prepare(
    kind: string,
    value: unknown,
    context: AssetPreparationContext,
  ): Result<unknown, AssetError> {
    const entry = this.dispatch.get(kind);
    const prepare = entry?.decoder.prepare;
    const invalid = (expected: string) =>
      new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: 'install a live owner decoder with synchronous runtime preparation for this kind',
      });
    if (this.disposed || prepare === undefined)
      return err(invalid(`active runtime preparation for kind "${kind}"`));
    try {
      // Extension code may retain both its input and result. Neither can alias
      // accepted current content, including binary data unchanged by a patch.
      const result = prepare(copyAssetData(value), context);
      if (this.disposed || this.dispatch.get(kind) !== entry)
        return err(invalid(`the preparation lease for kind "${kind}" to remain active`));
      if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean')
        return err(invalid('synchronous preparation returning a Result'));
      return result.ok ? ok(copyAssetData(result.value)) : result;
    } catch (cause) {
      return err(
        cause instanceof AssetError ? cause : invalid('plain validated runtime asset data'),
      );
    }
  }

  load<P, K extends string>(
    kind: AssetKind<P, K>,
    input: AssetDecoderInput<P>,
  ): Promise<Result<P, AssetLoadError>> {
    return this.decode(kind, input);
  }

  loadByKind(
    kind: string,
    input: AssetDecoderInput<unknown>,
  ): Promise<Result<unknown, AssetLoadError>> {
    if (this.disposed) return Promise.resolve(err(disposedError(this.scopeId)));
    const entry = this.dispatch.get(kind);
    if (entry === undefined) {
      return Promise.resolve(
        err({
          code: 'asset-decoder-missing',
          expected: `an active decoder for kind "${kind}"`,
          hint: 'install the owner decoder lease before loading this kind',
          detail: { kind },
        }),
      );
    }
    return this.decodeEntry(kind, entry, input);
  }

  async decode<P, K extends string>(
    kind: AssetKind<P, K>,
    input: AssetDecoderInput<P>,
  ): Promise<Result<P, AssetLoadError>> {
    if (this.disposed) return err(disposedError(this.scopeId));
    if (input.signal.aborted) return err(cancelledError(input.envelope.guid));
    const entry = this.dispatch.get(kind.kind);
    if (entry === undefined) {
      return err({
        code: 'asset-decoder-missing',
        expected: `an active decoder for kind "${kind.kind}"`,
        hint: 'install the owner decoder lease before loading this kind',
        detail: { kind: kind.kind },
      });
    }
    return (await this.decodeEntry(kind.kind, entry, input)) as Result<P, AssetLoadError>;
  }

  private async decodeEntry(
    kind: string,
    entry: DecoderEntry,
    input: AssetDecoderInput<unknown>,
  ): Promise<Result<unknown, AssetLoadError>> {
    if (this.disposed) return err(disposedError(this.scopeId));
    if (input.signal.aborted) return err(cancelledError(input.envelope.guid));
    try {
      const result = await entry.decode(input);
      if (this.disposed) return err(disposedError(this.scopeId));
      if (this.dispatch.get(kind)?.identity !== entry.identity) {
        return err(supersededError(input.envelope.guid, kind));
      }
      if (input.signal.aborted) return err(cancelledError(input.envelope.guid));
      return result.ok ? ok(freezeRuntimePayload(copyAssetData(result.value))) : result;
    } catch {
      return err({
        code: 'asset-decode-failed',
        expected: `decoder for kind "${kind}" to return a Result`,
        hint: 'inspect the owner decoder and retry the current publication',
        detail: { guid: input.envelope.guid, kind },
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dispatch.clear();
  }
}

function cancelledError(guid: string): AssetLoadError {
  return {
    code: 'asset-load-cancelled',
    expected: 'the request AbortSignal to remain live until decode completes',
    hint: 'retry with a live AbortSignal when the request is still needed',
    detail: { guid },
  };
}

function disposedError(scopeId: string): AssetLoadError {
  return {
    code: 'asset-runtime-disposed',
    expected: 'an active asset runtime decoder scope',
    hint: 'obtain a new Registry from the current realm',
    detail: { scopeId },
  };
}

function supersededError(guid: string, kind: string): AssetLoadError {
  return {
    code: 'asset-superseded',
    expected: `the decoder lease for kind "${kind}" to remain current until decode completes`,
    hint: 'retry the current publication after reinstalling its owner decoder',
    detail: { guid, generation: 0 },
  };
}
