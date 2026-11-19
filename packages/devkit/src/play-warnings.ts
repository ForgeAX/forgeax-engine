/**
 * Play warnings grouped by kind. The recorder collects one line per finding and frame
 * (`screenshot <name>: <finding>`, or a bare line for script usage); every output — the
 * compact success value, the compact failure detail and `play.json` — carries the same
 * `PlayWarning[]` shape built here, the compact forms within a byte budget.
 */
/** One kind of play warning across the run. */
export interface PlayWarning {
  /** Finding label, e.g. `mouse.move under pointer lock`. */
  readonly kind: string;
  /** Occurrences across the run (one per screenshot and finding). */
  readonly count: number;
  /**
   * Screenshots it occurred on, in order; empty when the warning is not tied to a frame.
   * A compact output lists the first few and ends with `+N more`.
   */
  readonly screenshots: readonly string[];
  /** The first occurrence in full: what was measured, the likely cause and the fix. */
  readonly message: string;
  /**
   * Other distinct occurrences of this kind (`screenshot <name>: <finding>`), in order;
   * the report lists them all, a compact output drops them first.
   */
  readonly others?: readonly string[];
}

/**
 * Byte budget of the compact `warnings` list, on top of the compact value budget:
 * findings carry their cause and fix in full, so they get their own room.
 */
export const PLAY_WARNING_BYTES = 2400;
/** Warning kinds listed in the compact result before the rest are counted. */
export const PLAY_WARNING_KINDS = 4;
/** One message longer than this is clipped even when listed alone. */
const PLAY_WARNING_MAX = 1600;
/** Screenshot names listed per kind in a compact output. */
const COMPACT_SCREENSHOTS = 6;
/** Other occurrences kept per kind in the report. */
const REPORT_OTHERS = 32;

const SCREENSHOT_PREFIX = /^screenshot (.+?): /;

/** Labels that do not follow the `<label>: ...` form. */
const IRREGULAR_KINDS: readonly (readonly [RegExp, string])[] = [
  [/^mouse\.move ran under pointer lock/, 'mouse.move under pointer lock'],
  [/^mouse\.click .* not the game canvas/, 'mouse.click off canvas'],
];

/** The finding's label: the lowercase words before its first `: `, else its text without numbers. */
export function warningKind(finding: string): string {
  for (const [pattern, kind] of IRREGULAR_KINDS) if (pattern.test(finding)) return kind;
  const label = /^([a-z][a-z -]{0,39}): /.exec(finding)?.[1];
  return label ?? finding.replace(/-?\d+(\.\d+)?/g, '#').slice(0, 80);
}

/** Clips to at most `max` UTF-8 bytes. */
function clip(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let output = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > max - 3) break;
    output += char;
    bytes += size;
  }
  return `${output}…`;
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '');

interface Group {
  readonly kind: string;
  readonly message: string;
  readonly order: number;
  readonly screenshots: string[];
  readonly others: string[];
  count: number;
}

/** Groups recorded warning lines by kind, in the order first seen. */
export function groupPlayWarnings(lines: readonly string[]): PlayWarning[] {
  const groups = new Map<string, Group>();
  for (const line of lines) {
    const shot = SCREENSHOT_PREFIX.exec(line)?.[1];
    const finding = shot === undefined ? line : line.slice(`screenshot ${shot}: `.length);
    const kind = warningKind(finding);
    const group = groups.get(kind);
    if (group === undefined) {
      groups.set(kind, {
        kind,
        message: finding,
        order: groups.size,
        screenshots: shot === undefined ? [] : [shot],
        others: [],
        count: 1,
      });
      continue;
    }
    group.count++;
    if (shot !== undefined && !group.screenshots.includes(shot)) group.screenshots.push(shot);
    if (
      finding !== group.message &&
      !group.others.includes(line) &&
      group.others.length < REPORT_OTHERS
    )
      group.others.push(line);
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ kind, count, screenshots, message, others }) => ({
      kind,
      count,
      screenshots,
      message,
      ...(others.length === 0 ? {} : { others }),
    }));
}

/** A kind for a compact output: few screenshot names, a clipped message, no `others`. */
function compactWarning(warning: PlayWarning): PlayWarning {
  const { screenshots } = warning;
  const listed =
    screenshots.length <= COMPACT_SCREENSHOTS
      ? screenshots
      : [
          ...screenshots.slice(0, COMPACT_SCREENSHOTS - 1),
          `+${screenshots.length - COMPACT_SCREENSHOTS + 1} more`,
        ];
  return {
    kind: warning.kind,
    count: warning.count,
    screenshots: listed,
    message: clip(warning.message, PLAY_WARNING_MAX),
  };
}

/**
 * The play warnings for the compact result and error: the report's kinds in order, each message kept whole, at most `PLAY_WARNING_KINDS` kinds within
 * `PLAY_WARNING_BYTES`; `moreWarningKinds` counts the kinds left in the report.
 */
export function warningsField(report: { readonly warnings?: readonly PlayWarning[] }): {
  readonly warnings?: readonly PlayWarning[];
  readonly moreWarningKinds?: number;
} {
  const all = report.warnings ?? [];
  if (all.length === 0) return {};
  const listed: PlayWarning[] = [];
  let bytes = 2;
  for (const warning of all.slice(0, PLAY_WARNING_KINDS)) {
    const compact = compactWarning(warning);
    const size = jsonBytes(compact) + 1;
    if (listed.length > 0 && bytes + size > PLAY_WARNING_BYTES - 60) break;
    listed.push(compact);
    bytes += size;
  }
  const rest = all.length - listed.length;
  return {
    warnings: listed,
    ...(rest > 0 ? { moreWarningKinds: rest } : {}),
  };
}

/**
 * Where a frame is checked again without a playthrough: the scene preview renders a
 * SceneAsset through its authored camera.
 */
export const SCENE_PREVIEW_HINT =
  'To look at a scene without playing, run forgeax asset preview --kind scene --guid <scene guid> --json; it renders the scene through its authored camera.';
