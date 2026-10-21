import { describe, expect, it } from 'vitest';
import {
  defineComponent,
  isSchemaVocabKeyword,
  parseManagedArraySchema,
  type SchemaFieldType,
} from '../component';

describe('one scalar and array element vocabulary', () => {
  it.each([
    'shared<bad tag>',
    'shared<bad-tag>',
    'shared<x<y>>',
    'shared<>',
  ])('rejects %s both alone and inside arrays', (element) => {
    expect(isSchemaVocabKeyword(element)).toBe(false);
    for (const field of [`array<${element}>`, `array<${element}, 4>`]) {
      expect(parseManagedArraySchema(field)).toBeNull();
      expect(() =>
        defineComponent(`Invalid_${field}`, { value: field as SchemaFieldType }),
      ).toThrow();
    }
  });
  it.each([
    'shared<material>',
    'asset<animation-clip>',
    'entity',
    'u16',
  ])('keeps valid element %s in both array forms', (element) => {
    expect(parseManagedArraySchema(`array<${element}>`)).toEqual({
      elementType: element,
      length: undefined,
    });
    expect(parseManagedArraySchema(`array<${element}, 4>`)).toEqual({
      elementType: element,
      length: 4,
    });
  });
});
