import type { PipelineLibraryInspection } from '@forgeax/engine-rhi';

type History = NonNullable<PipelineLibraryInspection['runtimeRequests']>;
type PublicRequest = History['requests'][number];
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type CompilationRecord<P extends object> = Mutable<Omit<PublicRequest, 'pipeline'>> & {
  readonly program: WeakRef<P> | undefined;
};
let nextLibraryId = 0;

/** Runtime misses/demands only. Cache hits do not allocate; descriptors and WGSL
 * are never copied or hashed here. Weak references never make this history an additional GPU resource owner. */
export class PipelineCompilationRecords<P extends object> {
  private readonly libraryId = ++nextLibraryId;
  private readonly rows: CompilationRecord<P>[] = [];
  private sequence = 0;
  private readonly capacity = 32;

  begin(
    input: Omit<
      CompilationRecord<P>,
      'program' | 'sequence' | 'demandedAtMs' | 'completedAtMs' | 'outcome'
    > & { readonly program: P | undefined },
  ): CompilationRecord<P> {
    const row: CompilationRecord<P> = {
      ...input,
      program: input.program === undefined ? undefined : new WeakRef(input.program),
      sequence: ++this.sequence,
      demandedAtMs: performance.now(),
      completedAtMs: null,
      outcome: 'pending',
    };
    this.rows[(row.sequence - 1) % this.capacity] = row;
    return row;
  }

  finish(row: CompilationRecord<P> | undefined, outcome: PublicRequest['outcome']): void {
    if (row === undefined) return;
    row.outcome = outcome;
    row.completedAtMs = performance.now();
  }

  inspect(pipeline: (program: P, row: CompilationRecord<P>) => PublicRequest['pipeline']): History {
    const requests: PublicRequest[] = [];
    const first = Math.max(1, this.sequence - this.capacity + 1);
    for (let sequence = first; sequence <= this.sequence; sequence++) {
      const row = this.rows[(sequence - 1) % this.capacity];
      if (row === undefined) continue;
      const { program: reference, ...metadata } = row;
      const program = reference?.deref();
      requests.push({
        ...metadata,
        pipeline: program === undefined ? null : pipeline(program, row),
      });
    }
    return {
      libraryId: this.libraryId,
      capacity: this.capacity,
      overwritten: Math.max(0, this.sequence - this.capacity),
      latestSequence: this.sequence,
      observedAtMs: performance.now(),
      requests,
    };
  }

  clear(): void {
    this.rows.length = 0;
    this.sequence = 0;
  }
}
