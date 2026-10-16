import { describe, expect, it } from 'vitest';
import { defineTool, type ToolPreviewContract, type ToolSubjectRef } from '../../src/index.js';

const subject: ToolSubjectRef = { kind: 'material', guid: 'mat:fixture' };
const preview: ToolPreviewContract = {
  realm: 'engine',
  subject,
  snapshot: { revision: 4, digest: 'sha256:snapshot' },
  requiredEvidence: ['png', 'rhi-tape', 'profile-capture'],
};

describe('preview descriptor contract', () => {
  it('keeps realm, subject, snapshot and required evidence in one descriptor', () => {
    const tool = defineTool(
      {
        id: 'asset.material.preview',
        title: 'Preview material',
        summary: 'Previews one material subject.',
        realm: 'engine',
        argsSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
        resultSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
        evidence: preview.requiredEvidence,
        preview,
      },
      async () => ({ subject, snapshot: preview.snapshot }),
    );

    expect(tool.descriptor.preview).toEqual(preview);
    expect(tool.descriptor.realm).toBe('engine');
    expect(tool.descriptor.evidence).toEqual(preview.requiredEvidence);
  });

  it('does not accept a preview contract whose realm disagrees with the descriptor', () => {
    const previewWithWrongRealm = { ...preview, realm: 'host' as const };
    expect(() =>
      defineTool(
        {
          id: 'asset.mesh.preview',
          title: 'Preview mesh',
          summary: 'Previews one mesh subject.',
          realm: 'engine',
          argsSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
          resultSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
          evidence: preview.requiredEvidence,
          preview: previewWithWrongRealm,
        },
        async () => ({ subject, snapshot: preview.snapshot }),
      ),
    ).toThrow('declares host but descriptor declares engine');
  });
});
