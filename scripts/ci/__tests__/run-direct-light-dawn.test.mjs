import { describe, expect, it } from 'vitest';
import {
  DIRECT_LIGHT_DAWN_PARTITIONS,
  DIRECT_LIGHT_DAWN_SCOPES,
  DIRECT_LIGHT_DAWN_TEST_NAMES,
  summarizePartitionReport,
  testNamePattern,
  validatePartitionReport,
} from '../run-direct-light-dawn.mjs';

function reportFor(partition, { selectedStatus = 'passed' } = {}) {
  const selected = new Set(partition.tests);
  return {
    success: true,
    testResults: [
      {
        assertionResults: DIRECT_LIGHT_DAWN_TEST_NAMES.map((title) => ({
          title,
          status: selected.has(title) ? selectedStatus : 'skipped',
        })),
      },
    ],
  };
}

describe('direct-light Dawn partition runner contract', () => {
  it('covers the complete direct-light roster exactly once', () => {
    const covered = DIRECT_LIGHT_DAWN_PARTITIONS.flatMap((partition) => partition.tests);
    expect(covered).toHaveLength(DIRECT_LIGHT_DAWN_TEST_NAMES.length);
    expect(new Set(covered)).toEqual(new Set(DIRECT_LIGHT_DAWN_TEST_NAMES));
    expect(DIRECT_LIGHT_DAWN_PARTITIONS.map((partition) => partition.id)).toEqual([
      'paired-and-contracts',
      'real-pixel-falsifiers-1',
      'real-pixel-falsifiers-2',
      'projector-surface',
      'hdrp-producers',
    ]);
    expect(DIRECT_LIGHT_DAWN_PARTITIONS[0]?.tests).toHaveLength(6);
  });

  it('assigns every native case to exactly one required CI scope', () => {
    const covered = Object.values(DIRECT_LIGHT_DAWN_SCOPES).flatMap((partitions) =>
      partitions.flatMap((partition) => partition.tests),
    );
    expect(covered).toHaveLength(DIRECT_LIGHT_DAWN_TEST_NAMES.length);
    expect(new Set(covered)).toEqual(new Set(DIRECT_LIGHT_DAWN_TEST_NAMES));
    expect(DIRECT_LIGHT_DAWN_SCOPES.producer.map((partition) => partition.id)).toEqual([
      'hdrp-producers',
    ]);
    expect(DIRECT_LIGHT_DAWN_SCOPES.producer.flatMap((partition) => partition.tests)).toEqual(
      DIRECT_LIGHT_DAWN_TEST_NAMES.slice(11, 15),
    );
  });

  it('anchors a pattern at the exact test-title suffix and escapes regexp syntax', () => {
    expect(testNamePattern(['a.b'])).toBe('(?:a\\.b)$');
  });

  it('accepts a report with only the partition tests selected', () => {
    for (const partition of DIRECT_LIGHT_DAWN_PARTITIONS) {
      expect(validatePartitionReport(reportFor(partition), partition)).toEqual(partition.tests);
    }
  });

  it('rejects a selected test that did not pass', () => {
    const partition = DIRECT_LIGHT_DAWN_PARTITIONS[0];
    expect(() =>
      validatePartitionReport(reportFor(partition, { selectedStatus: 'failed' }), partition),
    ).toThrow(/did not pass/);
  });

  it('rejects an unselected test that ran', () => {
    const partition = { id: 'subset', tests: [DIRECT_LIGHT_DAWN_TEST_NAMES[0]] };
    const report = reportFor(partition);
    report.testResults[0].assertionResults[1].status = 'passed';
    expect(() => validatePartitionReport(report, partition)).toThrow(/unexpectedly ran/);
  });

  it('projects bounded failure diagnostics without changing pass criteria', () => {
    const report = {
      success: false,
      testResults: [
        {
          message: 'suite failed',
          failureMessages: ['suite stack'],
          assertionResults: [
            {
              title: DIRECT_LIGHT_DAWN_TEST_NAMES[0],
              status: 'pending',
              failureMessages: ['test stack'],
            },
            { title: DIRECT_LIGHT_DAWN_TEST_NAMES[1], status: 'passed' },
          ],
        },
      ],
      unhandledErrors: [{ message: 'worker failed' }],
    };
    expect(summarizePartitionReport(report)).toEqual({
      success: false,
      assertions: [
        {
          title: DIRECT_LIGHT_DAWN_TEST_NAMES[0],
          status: 'pending',
          failureMessages: ['test stack'],
        },
      ],
      suites: ['suite failed', 'suite stack'],
      unhandledErrors: ['{"message":"worker failed"}'],
    });
  });
});
