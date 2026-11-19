import { fileURLToPath } from 'node:url';
import { defineProject } from "vitest/config";

export default defineProject({
	root: fileURLToPath(new URL('.', import.meta.url)),
	// Transform under the shared policy; tsc owns project-reference validation.
	tsconfig: fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)),
	test: {
		environment: "node",
		name: "@forgeax/engine-pack",
		typecheck: {
			enabled: true,
			tsconfig: "./tsconfig.json",
		},
		include: [
			"__tests__/**/*.test.ts",
			"__tests__/**/*.test-d.ts",
			"src/**/__tests__/**/*.test.ts",
			"src/**/__tests__/**/*.test-d.ts",
		],
		exclude: ["**/dist/**", "**/node_modules/**"],
	},
});
