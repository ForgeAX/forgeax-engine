import type { PipelineLibraryInspection } from '@forgeax/engine-rhi';

type History = NonNullable<PipelineLibraryInspection['runtimeRequests']>;
type PublicRequest = History['requests'][number];
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type CompilationRecord<P> = Mutable<Omit<PublicRequest, 'pipeline'>> & {
  readonly program: P | undefined;
};
let nextLibraryId = 0;

/** Runtime misses/demands only. Cache hits do not allocate; descriptors and WGSL
 * are never copied or hashed here. The existing library owns the Program. */
export class PipelineCompilationRecords<P> {
  private readonly libraryId = ++nextLibraryId;
  private readonly rows: CompilationRecord<P>[] = [];
  private sequence = 0;
  private readonly capacity = 32;

  begin(
    input: Omit<CompilationRecord<P>, 'sequence' | 'demandedAtMs' | 'completedAtMs' | 'outcome'>,
  ): CompilationRecord<P> {
    const row: CompilationRecord<P> = {
      ...input,
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
      const { program, ...metadata } = row;
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
