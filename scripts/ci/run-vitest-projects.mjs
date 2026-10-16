#!/usr/bin/env node

import path from 'node:path';
import { createVitest, parseCLI } from 'vitest/node';
import { checkTypeTestProjects } from './check-type-test-projects.mjs';

const { filter, options } = parseCLI(['vitest', ...process.argv.slice(2)]);
process.env.TEST = 'true';
process.env.VITEST = 'true';
process.env.NODE_ENV ??= 'test';
// The named `unit` project is an intentional empty command marker. The
// workspace CLI carries `passWithNoTests` through its command path, but the
// createVitest API does not inherit that project-level setting during
// discovery. Pass the same explicit option only for the marker itself so a
// missing test population in every other project still fails loudly.
const allowEmptyUnitMarker = options.project?.length === 1 && options.project[0] === 'unit';
const context = await createVitest('test', {
  ...options,
  ...(allowEmptyUnitMarker ? { passWithNoTests: true } : {}),
  run: true,
  watch: false,
});
if (allowEmptyUnitMarker) context.config.passWithNoTests = true;
try {
  // Vitest 4.1's workspace CLI override list omits typecheck. Apply the
  // requested mode to the resolved projects before Vitest discovers files;
  // otherwise --typecheck.only runs the runtime suite again, and coverage
  // children ignore --typecheck.enabled=false.
  if (options.typecheck !== undefined) {
    for (const project of context.projects) {
      Object.assign(project.config.typecheck, options.typecheck);
      if (options.typecheck.only === true) project.config.typecheck.enabled = true;
    }
  }
  // Vitest does not propagate workspace-level CLI exclusions into each
  // resolved project when using createVitest(). Preserve the CLI contract so
  // split coverage can run expensive semantic preflights exactly once.
  if (options.exclude?.length) {
    const excludes = options.exclude.map((pattern) =>
      (path.isAbsolute(pattern) ? pattern : path.resolve(process.cwd(), pattern)).replaceAll(
        '\\',
        '/',
      ),
    );
    for (const project of context.projects) {
      project.config.exclude = [...project.config.exclude, ...excludes];
    }
  }
  if (options.typecheck?.only === true) await checkTypeTestProjects(context, filter);
  else await context.start(filter);
} catch (error) {
  if (allowEmptyUnitMarker && error?.code === 'VITEST_FILES_NOT_FOUND') {
    process.exitCode = 0;
  } else {
    process.exitCode = error?.exitCode ?? 1;
    throw error;
  }
} finally {
  // Match the CLI's bounded server/worker shutdown, including its timeout
  // diagnostics when a plugin retains a handle after tests have completed.
  await context.exit();
}
