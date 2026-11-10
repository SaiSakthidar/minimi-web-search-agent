import { afterEach, expect, it } from "vitest";
import { dayKey, now, setOverride } from "../src/clock.ts";

afterEach(() => setOverride(null));

it("returns the override when set", () => {
  setOverride("2026-11-03T10:00:00Z");
  expect(now().toISOString()).toBe("2026-11-03T10:00:00.000Z");
});

it("returns the real time when the override is cleared", () => {
  setOverride("2026-11-03T10:00:00Z");
  setOverride(null);
  expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000);
});

it("dayKey uses the local date", () => {
  expect(dayKey("2026-11-03T10:00:00Z")).toMatch(/^2026-11-0[34]$/);
  expect(dayKey(new Date(2026, 10, 3, 23, 30))).toBe("2026-11-03");
});
