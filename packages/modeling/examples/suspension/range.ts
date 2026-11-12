import { buildSuspension, SUSPENSION_DEFAULTS, SUSPENSION_JOINTS, type SuspensionParameters } from './suspension.ts';
import pack from './suspension.pack.ts';

type Name = keyof SuspensionParameters;
const DECLARED = pack.parameters as readonly { name: Name; minimum: number; maximum: number }[];

/**
 * The parameter points the declared range is proven on: every range endpoint with the
 * other parameters at their defaults, then every corner of the four ranges.
 */
export function rangeProbes(): { readonly probe: string; readonly parameters: SuspensionParameters }[] {
  const ends = DECLARED.flatMap(({ name, minimum, maximum }) =>
    [minimum, maximum].map((v) => ({ probe: `${name}=${v}`, parameters: { ...SUSPENSION_DEFAULTS, [name]: v } })),
  );
  const corners = Array.from({ length: 2 ** DECLARED.length }, (_, mask) => {
    const parameters = { ...SUSPENSION_DEFAULTS };
    for (const [i, { name, minimum, maximum }] of DECLARED.entries()) parameters[name] = mask & (1 << i) ? maximum : minimum;
    return { probe: `corner ${DECLARED.map(({ name }) => `${name}=${parameters[name]}`).join(' ')}`, parameters };
  });
  return [...ends, ...corners];
}

/** Assembly validation with the designed joints at one parameter point, reduced to counts. */
export function probeJoints(parameters: SuspensionParameters) {
  const report = buildSuspension(parameters).validate({ contacts: SUSPENSION_JOINTS });
  const crossing = report.issues.find((i) => i.code === 'self-intersection');
  const fits = (report.issues.find((i) => i.code === 'designed-contact')?.detail as {
    fits: { parts: string[]; status: string; depth: number; tolerance: number }[];
  } | undefined)?.fits ?? [];
  return {
    closed: report.closed,
    confirmedCrossings: crossing?.severity === 'warn' ? ((crossing.detail as { total?: number }).total ?? 1) : 0,
    errors: report.issues.filter((i) => i.severity === 'error').length,
    warnings: report.issues.filter((i) => i.severity === 'warn').map((i) => i.code),
    fits,
  };
}
