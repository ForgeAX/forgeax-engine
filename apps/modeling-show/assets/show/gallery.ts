import type { ShowSegment } from './director.ts';
import type { ShowSubjectSource } from './subjects.ts';

/**
 * The gallery program: single-Pack kernel and tool cases, one subject per case. A subject
 * names its Packs only; the Show discovers every mesh each Pack publishes and paints slots
 * without a published material from the Show palette. Each Pack is a sibling of the gallery
 * project (`gallery/assets/<case>.pack.ts` re-exports the case Pack).
 */
export const GALLERY_SUBJECTS: readonly ShowSubjectSource[] = [
  {
    name: 'crate',
    source: 'crate: crate.pack (C-001), buildCrate().finish',
    packs: [{ packageId: '01900000-0000-7000-8000-0000000c0001' }],
  },
  {
    name: 'C-002 desk lamp',
    source: 'desk-lamp: lamp.pack (C-002, main), mesh/lamp; parameters height, reach, shadeRadius, ...',
    packs: [{ packageId: '01900000-0000-7000-8000-0000000c0002' }],
  },
  {
    name: 'C-010 bracket',
    source: 'bracket: bracket.pack (C-010, main), mesh/bracket; parameters length, height, thickness, depth, fillet, ...',
    packs: [{ packageId: '01900000-0000-7000-8000-0000000c0010' }],
  },
  {
    name: 'C-011 panel',
    source: 'panel: panel.pack (C-011, main), mesh/panel, boolean cuts; parameters width, depth, thickness, ...',
    packs: [{ packageId: '01900000-0000-7000-8000-0000000c0011' }],
  },
  {
    name: 'C-012 housing',
    source: 'housing: housing.pack (C-012, main), mesh/housing, thin-walled; parameters wall, vents',
    packs: [{ packageId: '01900000-0000-7000-8000-0000000c0012' }],
  },
  {
    name: 'C-101 wheel rim',
    source: 'wheel-rim: wheel-rim.pack (C-101, main), mesh/wheel-rim; parameters diameter, width, spokes, offset, ...',
    packs: [{ packageId: '01900000-0000-7000-8000-0000000c0101' }],
  },
];

export const GALLERY_SEGMENTS: readonly ShowSegment[] = GALLERY_SUBJECTS.map((_, subject) => ({
  subject,
  kind: 'turntable',
  seconds: 16,
}));
