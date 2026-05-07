import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		exclude: ["src/__tests__/e2e-live.test.ts"],
		setupFiles: ["./vitest.setup.ts"],
	},
});
