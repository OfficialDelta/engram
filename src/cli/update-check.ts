import { createRequire } from "node:module";
import updateNotifier from "update-notifier";

export function checkForUpdates(): void {
	try {
		const require = createRequire(import.meta.url);
		const pkg = require("../../package.json") as {
			name: string;
			version: string;
		};
		updateNotifier({ pkg }).notify();
	} catch {
		// Silently swallow all errors — network failures, missing fields, corrupt cache
	}
}
