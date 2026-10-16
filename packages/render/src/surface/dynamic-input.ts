import type {
  MaterialDynamicFieldType,
  MaterialDynamicInputLayout,
  MaterialDynamicInputSchema,
} from '@forgeax/engine-types';
import { deriveMaterialDynamicInputLayout, err, ok, type Result } from '@forgeax/engine-types';

export type DynamicInputValue = number | readonly number[];

/** Stable public address of one admitted Surface draw member. */
export interface SurfaceDynamicInputMemberIdentity {
  /** `World.identity`; stable across renderer-local World reordering. */
  readonly worldIdentity: string;
  readonly entityKey: number;
  readonly drawItemIndex: number;
  readonly instanceOrdinal: number;
}

export interface DynamicInputRange {
  readonly pageId: number;
  readonly sourceId: string;
  /** Producer-owned domain identity retained across device regeneration. */
  readonly domain: string;
  readonly byteOffset: number;
  readonly recordStart: number;
  readonly recordCount: number;
  readonly instanceIndex: number;
  readonly member: SurfaceDynamicInputMemberIdentity;
  readonly contentRevision: number;
  readonly bufferGeneration: number;
  readonly deviceGeneration: number;
}

export interface DynamicInputDirtyRange {
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface DynamicInputUploadReceipt {
  readonly sourceId: string;
  readonly pageId: number;
  readonly contentRevision: number;
  readonly bufferGeneration: number;
  readonly deviceGeneration: number;
  readonly ranges: readonly DynamicInputDirtyRange[];
  readonly bytes: number;
}

export interface DynamicInputConsumptionReceipt extends DynamicInputRange {
  readonly frameNumber: number;
  readonly uploadedRevision: number;
}

/**
 * Renderer input for one frame of a published Surface dynamic page.
 *
 * `ranges` join by their stable World/entity/draw/instance member identity.
 * Producer order is irrelevant and cannot redirect one member's dynamic
 * records to another member after culling or World reordering.
 */
export interface SurfaceDynamicInputFrame {
  readonly page: ReadonlyDynamicInputPage;
  readonly ranges?: readonly DynamicInputRange[];
  /** Producer-owned membership/address revision; time and record values do not advance it. */
  readonly projectionRevision: number;
  readonly frameTime: number;
}

export type DynamicInputErrorCode =
  | 'invalid-schema'
  | 'invalid-record'
  | 'range-overflow'
  | 'domain-overflow'
  | 'not-uploaded'
  | 'stale-generation'
  | 'released';

export interface DynamicInputErrorDetail {
  readonly operation:
    | 'create'
    | 'write'
    | 'reserve'
    | 'upload'
    | 'consume'
    | 'reconfigure'
    | 'release';
  readonly field?: string;
  readonly expected: string;
  readonly actual?: unknown;
  readonly sourceId?: string;
  readonly pageId?: number;
}

const ERROR_POLICY: Readonly<
  Record<DynamicInputErrorCode, { readonly expected: string; readonly hint: string }>
> = {
  'invalid-schema': {
    expected: 'the dynamic input schema has one derived bounded record layout',
    hint: 'repair the root MaterialSurface dynamicInput declaration and recook it',
  },
  'invalid-record': {
    expected: 'each dynamic record matches the derived scalar/vector fields',
    hint: 'write finite values using the field names and types declared by the material',
  },
  'range-overflow': {
    expected: 'the instance range stays within the declared read-only page',
    hint: 'reduce the range or increase the producer page budget before publication',
  },
  'domain-overflow': {
    expected: 'the page stays within its declared number of producer domains',
    hint: 'reuse an existing domain or publish a larger bounded declaration',
  },
  'not-uploaded': {
    expected: 'the current page revision was uploaded before frame consumption',
    hint: 'submit the page upload receipt and retry the same frame',
  },
  'stale-generation': {
    expected: 'the range, upload, and device use one current page generation',
    hint: 'discard stale addresses and rebuild the producer projection for the current device',
  },
  released: {
    expected: 'the read-only page is still attached to its owning Render lifecycle',
    hint: 'create a new page after releasing the old owner',
  },
};

export class DynamicInputError extends Error {
  readonly code: DynamicInputErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: DynamicInputErrorDetail;

  constructor(code: DynamicInputErrorCode, detail: DynamicInputErrorDetail) {
    super(`${code}: ${ERROR_POLICY[code].expected}`);
    this.name = 'DynamicInputError';
    this.code = code;
    this.expected = ERROR_POLICY[code].expected;
    this.hint = ERROR_POLICY[code].hint;
    this.detail = Object.freeze({ ...detail });
  }
}

export type DynamicInputResult<T> = Result<T, DynamicInputError>;

interface DomainRecord {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

function alignRange(ranges: DynamicInputDirtyRange[], start: number, end: number): void {
  if (start >= end) return;
  let index = 0;
  while (index < ranges.length && (ranges[index]?.byteEnd ?? 0) < start) index += 1;
  while (index < ranges.length) {
    const existing = ranges[index];
    if (existing === undefined || existing.byteStart > end) break;
    start = Math.min(start, existing.byteStart);
    end = Math.max(end, existing.byteEnd);
    ranges.splice(index, 1);
  }
  ranges.splice(index, 0, { byteStart: start, byteEnd: end });
}

function fieldWidth(type: MaterialDynamicFieldType): number {
  switch (type) {
    case 'f32':
    case 'u32':
      return 1;
    case 'vec2<f32>':
      return 2;
    case 'vec3<f32>':
      return 3;
    case 'vec4<f32>':
      return 4;
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function invalid(
  code: DynamicInputErrorCode,
  operation: DynamicInputErrorDetail['operation'],
  expected: string,
  actual?: unknown,
  field?: string,
  page?: Readonly<{ sourceId: string; pageId: number }>,
): DynamicInputError {
  return new DynamicInputError(code, {
    operation,
    expected,
    ...(actual === undefined ? {} : { actual }),
    ...(field === undefined ? {} : { field }),
    ...(page === undefined ? {} : page),
  });
}

/**
 * Generic Render-owned CPU side of a read-only dynamic input page. The page
 * has no GPU handle: the renderer's existing resource owner can upload the
 * detached bytes and attach the receipt to a prepared pass.
 */
export class ReadonlyDynamicInputPage {
  readonly sourceId: string;
  readonly pageId: number;
  readonly schema: MaterialDynamicInputSchema;
  readonly layout: MaterialDynamicInputLayout;
  readonly bytes: Uint8Array;
  private contentRevisionValue = 1;
  private bufferGenerationValue = 1;
  private deviceGenerationValue = 1;
  private uploadedRevisionValue = 0;
  private lastUploadedBytesValue = 0;
  private released = false;
  private readonly ownedRanges = new WeakSet<object>();
  private readonly ownedUploads = new WeakSet<object>();
  private readonly dirty = [
    {
      byteStart: 0,
      byteEnd: 0,
    } as DynamicInputDirtyRange,
  ];
  private readonly domains = new Map<string, DomainRecord>();

  private constructor(
    sourceId: string,
    pageId: number,
    schema: MaterialDynamicInputSchema,
    layout: MaterialDynamicInputLayout,
  ) {
    this.sourceId = sourceId;
    this.pageId = pageId;
    this.schema = schema;
    this.layout = layout;
    this.bytes = new Uint8Array(schema.maxPageBytes);
    this.dirty.length = 0;
  }

  static create(input: {
    readonly sourceId: string;
    readonly pageId: number;
    readonly schema: MaterialDynamicInputSchema;
  }): DynamicInputResult<ReadonlyDynamicInputPage> {
    if (input.sourceId.length === 0 || !Number.isSafeInteger(input.pageId) || input.pageId < 0) {
      return err(
        invalid(
          'invalid-schema',
          'create',
          'sourceId is non-empty and pageId is non-negative',
          input.pageId,
        ),
      );
    }
    const layout = deriveMaterialDynamicInputLayout(input.schema);
    if (!layout.ok) {
      return err(
        invalid(
          'invalid-schema',
          'create',
          layout.error.expected,
          layout.error.actual,
          layout.error.field,
        ),
      );
    }
    return ok(
      new ReadonlyDynamicInputPage(input.sourceId, input.pageId, input.schema, layout.value),
    );
  }

  get contentRevision(): number {
    return this.contentRevisionValue;
  }

  get bufferGeneration(): number {
    return this.bufferGenerationValue;
  }

  get deviceGeneration(): number {
    return this.deviceGenerationValue;
  }

  get uploadedRevision(): number {
    return this.uploadedRevisionValue;
  }

  get lastUploadedBytes(): number {
    return this.lastUploadedBytesValue;
  }

  /** Write one complete record and mark only its byte interval dirty. */
  writeRecord(
    index: number,
    values: Readonly<Record<string, DynamicInputValue>>,
  ): DynamicInputResult<number> {
    const live = this.assertLive('write');
    if (!live.ok) return live;
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.schema.maxRecords) {
      return err(
        invalid(
          'range-overflow',
          'write',
          `record index is within [0, ${this.schema.maxRecords})`,
          index,
          'index',
          this,
        ),
      );
    }
    const recordOffset = index * this.layout.stride;
    // Encode into detached bytes first. A malformed later field must leave the
    // previously published record and its dirty/revision state untouched.
    const encoded = new Uint8Array(this.layout.stride);
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    for (const field of this.layout.fields) {
      const value = values[field.name];
      if (value === undefined) {
        return err(
          invalid(
            'invalid-record',
            'write',
            `record contains field ${field.name}`,
            value,
            field.name,
            this,
          ),
        );
      }
      const width = fieldWidth(field.type);
      const numbers = typeof value === 'number' ? [value] : value;
      if (numbers.length !== width || numbers.some((candidate) => !finiteNumber(candidate))) {
        return err(
          invalid(
            'invalid-record',
            'write',
            `${field.name} is a finite ${field.type}`,
            value,
            field.name,
            this,
          ),
        );
      }
      if (
        field.type === 'u32' &&
        (!Number.isInteger(numbers[0]) ||
          (numbers[0] as number) < 0 ||
          (numbers[0] as number) > 0xffffffff)
      ) {
        return err(
          invalid(
            'invalid-record',
            'write',
            `${field.name} is an unsigned 32-bit integer`,
            value,
            field.name,
            this,
          ),
        );
      }
      for (const [component, number] of numbers.entries()) {
        const offset = field.offset + component * 4;
        if (field.type === 'u32') view.setUint32(offset, number as number, true);
        else view.setFloat32(offset, number as number, true);
      }
    }
    this.bytes.set(encoded, recordOffset);
    this.contentRevisionValue += 1;
    alignRange(this.dirty, recordOffset, recordOffset + this.layout.stride);
    return ok(this.contentRevisionValue);
  }

  /** Reserve one explicit instance range; no skin address field is involved. */
  reserveRange(input: {
    readonly domain: string;
    readonly recordStart: number;
    readonly recordCount: number;
    readonly instanceIndex: number;
    readonly member: SurfaceDynamicInputMemberIdentity;
  }): DynamicInputResult<DynamicInputRange> {
    const live = this.assertLive('reserve');
    if (!live.ok) return live;
    if (input.domain.length === 0) {
      return err(
        invalid(
          'domain-overflow',
          'reserve',
          'domain is a non-empty identity',
          input.domain,
          'domain',
          this,
        ),
      );
    }
    if (!this.domains.has(input.domain) && this.domains.size >= this.schema.maxDomains) {
      return err(
        invalid(
          'domain-overflow',
          'reserve',
          `at most ${this.schema.maxDomains} domains are active`,
          this.domains.size + 1,
          'domain',
          this,
        ),
      );
    }
    if (
      !Number.isSafeInteger(input.instanceIndex) ||
      input.instanceIndex < 0 ||
      input.instanceIndex > 0xffffffff
    ) {
      return err(
        invalid(
          'range-overflow',
          'reserve',
          'instance index is an exact unsigned 32-bit integer',
          input.instanceIndex,
          'instanceIndex',
          this,
        ),
      );
    }
    if (
      input.member.worldIdentity.length === 0 ||
      !Number.isSafeInteger(input.member.entityKey) ||
      input.member.entityKey < 0 ||
      input.member.entityKey > 0xffffffff ||
      !Number.isSafeInteger(input.member.drawItemIndex) ||
      input.member.drawItemIndex < 0 ||
      input.member.drawItemIndex > 0xffffffff ||
      !Number.isSafeInteger(input.member.instanceOrdinal) ||
      input.member.instanceOrdinal < 0 ||
      input.member.instanceOrdinal > 0xffffffff
    ) {
      return err(
        invalid(
          'range-overflow',
          'reserve',
          'member is a stable World identity plus exact unsigned 32-bit entity, draw-item, and instance identities',
          input.member,
          'member',
          this,
        ),
      );
    }
    if (
      !Number.isSafeInteger(input.recordStart) ||
      !Number.isSafeInteger(input.recordCount) ||
      input.recordStart < 0 ||
      input.recordCount <= 0 ||
      input.recordStart + input.recordCount > this.schema.maxRecords
    ) {
      return err(
        invalid(
          'range-overflow',
          'reserve',
          'record range and instance index fit the declared page',
          input,
          'recordStart',
          this,
        ),
      );
    }
    const range: DynamicInputRange = {
      pageId: this.pageId,
      sourceId: this.sourceId,
      domain: input.domain,
      byteOffset: input.recordStart * this.layout.stride,
      recordStart: input.recordStart,
      recordCount: input.recordCount,
      instanceIndex: input.instanceIndex,
      member: Object.freeze({ ...input.member }),
      contentRevision: this.contentRevisionValue,
      bufferGeneration: this.bufferGenerationValue,
      deviceGeneration: this.deviceGenerationValue,
    };
    this.ownedRanges.add(range);
    this.domains.set(input.domain, {
      name: input.domain,
      start: input.recordStart,
      end: input.recordStart + input.recordCount,
    });
    return ok(range);
  }

  /** Return detached dirty bytes for the existing resource owner to upload. */
  beginUpload(): DynamicInputResult<DynamicInputUploadReceipt> {
    const live = this.assertLive('upload');
    if (!live.ok) return live;
    const ranges = this.dirty.map((range) => ({ ...range }));
    const bytes = ranges.reduce((sum, range) => sum + range.byteEnd - range.byteStart, 0);
    const receipt: DynamicInputUploadReceipt = {
      sourceId: this.sourceId,
      pageId: this.pageId,
      contentRevision: this.contentRevisionValue,
      bufferGeneration: this.bufferGenerationValue,
      deviceGeneration: this.deviceGenerationValue,
      ranges,
      bytes,
    };
    this.ownedUploads.add(receipt);
    return ok(receipt);
  }

  /**
   * Commit an upload only after the owning queue write has succeeded. A
   * producer that changed the page while a write was in flight leaves the
   * dirty bytes pending and must retry the new revision.
   */
  commitUpload(receipt: DynamicInputUploadReceipt): DynamicInputResult<true> {
    const live = this.assertLive('upload');
    if (!live.ok) return live;
    if (
      !this.ownedUploads.has(receipt) ||
      receipt.sourceId !== this.sourceId ||
      receipt.pageId !== this.pageId ||
      receipt.bufferGeneration !== this.bufferGenerationValue ||
      receipt.deviceGeneration !== this.deviceGenerationValue ||
      receipt.contentRevision !== this.contentRevisionValue
    ) {
      return err(
        invalid(
          'stale-generation',
          'upload',
          'the upload receipt still describes the current page revision and generation',
          receipt,
          'receipt',
          this,
        ),
      );
    }
    this.uploadedRevisionValue = receipt.contentRevision;
    this.lastUploadedBytesValue = receipt.bytes;
    for (const range of receipt.ranges) {
      const index = this.dirty.findIndex(
        (candidate) =>
          candidate.byteStart === range.byteStart && candidate.byteEnd === range.byteEnd,
      );
      if (index >= 0) this.dirty.splice(index, 1);
    }
    return ok(true);
  }

  /** CPU-only convenience: begin and commit are still explicit in production. */
  upload(): DynamicInputResult<DynamicInputUploadReceipt> {
    const receipt = this.beginUpload();
    if (!receipt.ok) return receipt;
    const committed = this.commitUpload(receipt.value);
    if (!committed.ok) return committed;
    return receipt;
  }

  /** Consume an uploaded range after graph submission has completed. */
  consume(
    range: DynamicInputRange,
    frameNumber: number,
  ): DynamicInputResult<DynamicInputConsumptionReceipt> {
    const live = this.assertLive('consume');
    if (!live.ok) return live;
    if (
      !this.ownedRanges.has(range) ||
      range.sourceId !== this.sourceId ||
      range.pageId !== this.pageId ||
      range.bufferGeneration !== this.bufferGenerationValue ||
      range.deviceGeneration !== this.deviceGenerationValue ||
      range.recordStart < 0 ||
      range.recordCount <= 0 ||
      range.recordStart + range.recordCount > this.schema.maxRecords
    ) {
      return err(
        invalid(
          'stale-generation',
          'consume',
          'range belongs to this current page generation',
          range,
          'generation',
          this,
        ),
      );
    }
    if (this.uploadedRevisionValue < range.contentRevision) {
      return err(
        invalid(
          'not-uploaded',
          'consume',
          'range content revision was uploaded before consumption',
          this.uploadedRevisionValue,
          'contentRevision',
          this,
        ),
      );
    }
    return ok({ ...range, frameNumber, uploadedRevision: this.uploadedRevisionValue });
  }

  /** Device loss/rebuild changes physical generations while source identity stays stable. */
  reconfigureDevice(deviceGeneration: number): DynamicInputResult<number> {
    const live = this.assertLive('reconfigure');
    if (!live.ok) return live;
    if (!Number.isSafeInteger(deviceGeneration) || deviceGeneration < 0) {
      return err(
        invalid(
          'stale-generation',
          'reconfigure',
          'deviceGeneration is a non-negative safe integer',
          deviceGeneration,
          'deviceGeneration',
          this,
        ),
      );
    }
    const rendererInitialGeneration =
      this.bufferGenerationValue === 1 &&
      this.deviceGenerationValue === 1 &&
      deviceGeneration === 0;
    if (deviceGeneration < this.deviceGenerationValue && !rendererInitialGeneration) {
      return err(
        invalid(
          'stale-generation',
          'reconfigure',
          'deviceGeneration does not precede the current device generation',
          deviceGeneration,
          'deviceGeneration',
          this,
        ),
      );
    }
    this.deviceGenerationValue = deviceGeneration;
    this.bufferGenerationValue += 1;
    this.uploadedRevisionValue = 0;
    alignRange(this.dirty, 0, this.schema.maxRecords * this.layout.stride);
    return ok(this.bufferGenerationValue);
  }

  release(): DynamicInputResult<true> {
    if (this.released) return ok(true);
    this.released = true;
    this.domains.clear();
    this.dirty.length = 0;
    return ok(true);
  }

  private assertLive(operation: DynamicInputErrorDetail['operation']): DynamicInputResult<true> {
    return this.released
      ? err(
          invalid(
            'released',
            operation,
            ERROR_POLICY.released.expected,
            undefined,
            undefined,
            this,
          ),
        )
      : ok(true);
  }
}
