import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MotherSettingsManager } from "../src/context.js";

function createTempSettings(settings: Record<string, unknown> = {}): MotherSettingsManager {
	const dir = mkdtempSync(join(tmpdir(), "mother-test-"));
	if (Object.keys(settings).length > 0) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	}
	return new MotherSettingsManager(dir);
}

describe("learning settings", () => {
	it("returns defaults when no settings configured", () => {
		const mgr = createTempSettings();
		const s = mgr.getLearningSettings();
		expect(s.enabled).toBe(true);
		expect(s.sentimentModel).toBeNull();
		expect(s.maxLearningsPerDay).toBe(20);
	});

	it("merges partial overrides with defaults", () => {
		const mgr = createTempSettings({ learning: { maxLearningsPerDay: 5 } });
		const s = mgr.getLearningSettings();
		expect(s.enabled).toBe(true);
		expect(s.maxLearningsPerDay).toBe(5);
	});
});

describe("wisdom settings", () => {
	it("returns defaults when no settings configured", () => {
		const mgr = createTempSettings();
		const s = mgr.getWisdomSettings();
		expect(s.enabled).toBe(true);
		expect(s.maxActiveChars).toBe(500);
		expect(s.promotionThreshold).toBe(0.8);
		expect(s.clusterMinOccurrences).toBe(3);
		expect(s.decayDays).toBe(90);
	});
});

describe("relationship settings", () => {
	it("returns defaults when no settings configured", () => {
		const mgr = createTempSettings();
		const s = mgr.getRelationshipSettings();
		expect(s.enabled).toBe(true);
		expect(s.minTurnsForExtraction).toBe(2);
		expect(s.deduplicationThreshold).toBe(0.85);
	});
});
