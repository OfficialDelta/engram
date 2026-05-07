import { describe, expect, it } from "vitest";
import { computeStrength } from "../core/strength.js";
import type { StrengthParams } from "../types.js";

function makeParams(overrides: Partial<StrengthParams> = {}): StrengthParams {
	return {
		sourceEpisodeCount: 1,
		sessionsWithoutReinforcement: 0,
		successfulEpisodes: 1,
		totalEpisodes: 1,
		causallyImportant: false,
		...overrides,
	};
}

describe("computeStrength", () => {
	it("returns 0 when sourceEpisodeCount is 0", () => {
		const result = computeStrength(makeParams({ sourceEpisodeCount: 0 }));
		expect(result).toBe(0);
	});

	it("defaults outcomeConsistency to 0.5 when totalEpisodes is 0", () => {
		const result = computeStrength(
			makeParams({
				sourceEpisodeCount: 1,
				totalEpisodes: 0,
				successfulEpisodes: 0,
			}),
		);
		// frequency=log2(2)=1, recency=1, outcomeConsistency=0.5, causal=1.0 → 0.5
		expect(result).toBeCloseTo(0.5, 5);
	});

	it("returns recency=1.0 when sessionsWithoutReinforcement is 0", () => {
		const result = computeStrength(
			makeParams({
				sourceEpisodeCount: 1,
				sessionsWithoutReinforcement: 0,
				successfulEpisodes: 1,
				totalEpisodes: 1,
			}),
		);
		// frequency=1, recency=1, outcomeConsistency=1, causal=1 → 1.0
		expect(result).toBeCloseTo(1.0, 5);
	});

	it("computes known input correctly and clamps to 1.0", () => {
		const result = computeStrength(
			makeParams({
				sourceEpisodeCount: 3,
				sessionsWithoutReinforcement: 2,
				successfulEpisodes: 2,
				totalEpisodes: 3,
				causallyImportant: false,
			}),
		);
		// frequency=log2(4)=2, recency=exp(-0.2)≈0.8187, outcome=2/3≈0.6667, causal=1.0
		// raw ≈ 2 * 0.8187 * 0.6667 ≈ 1.0916 → clamped to 1.0
		expect(result).toBe(1);
	});

	it("clamps large values with causallyImportant=true to 1.0", () => {
		const result = computeStrength(
			makeParams({
				sourceEpisodeCount: 100,
				sessionsWithoutReinforcement: 0,
				successfulEpisodes: 100,
				totalEpisodes: 100,
				causallyImportant: true,
			}),
		);
		expect(result).toBe(1);
	});

	it("shows significant decay after 20 inactive sessions (R012)", () => {
		const result = computeStrength(
			makeParams({
				sourceEpisodeCount: 1,
				sessionsWithoutReinforcement: 20,
				successfulEpisodes: 1,
				totalEpisodes: 1,
				causallyImportant: false,
			}),
		);
		// frequency=1, recency=exp(-2)≈0.1353, outcome=1, causal=1 → ≈0.1353
		expect(result).toBeCloseTo(Math.exp(-2), 4);
		expect(result).toBeLessThan(0.15);
	});

	it("returns value between 0 and 1 for moderate params", () => {
		const result = computeStrength(
			makeParams({
				sourceEpisodeCount: 5,
				sessionsWithoutReinforcement: 3,
				successfulEpisodes: 3,
				totalEpisodes: 5,
				causallyImportant: false,
			}),
		);
		expect(result).toBeGreaterThan(0);
		expect(result).toBeLessThanOrEqual(1);
	});
});
