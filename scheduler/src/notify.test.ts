import { afterEach, describe, expect, test } from "bun:test";
import { withinWorkingHours } from "./notify";

const KEYS = ["RADAR_WINDOW_DAYS", "RADAR_WINDOW_START", "RADAR_WINDOW_END", "RADAR_TIMEZONE"];
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

function at(iso: string, days?: string, start = "00:00", end = "23:59"): boolean {
  if (days) process.env.RADAR_WINDOW_DAYS = days;
  process.env.RADAR_WINDOW_START = start;
  process.env.RADAR_WINDOW_END = end;
  process.env.RADAR_TIMEZONE = "UTC";
  return withinWorkingHours(new Date(iso));
}

// 2026-09-28 is a Monday, 2026-09-27 a Sunday, 2026-10-03 a Saturday.
describe("withinWorkingHours", () => {
  test("defaults to Monday-Friday", () => {
    expect(at("2026-09-28T12:00:00Z")).toBe(true);
    expect(at("2026-09-27T12:00:00Z")).toBe(false);
    expect(at("2026-10-03T12:00:00Z")).toBe(false);
  });

  test("0-6 covers the weekend", () => {
    expect(at("2026-09-27T12:00:00Z", "0-6")).toBe(true);
  });

  test("accepts a list as well as a range", () => {
    expect(at("2026-09-27T12:00:00Z", "0,6")).toBe(true);
    expect(at("2026-09-28T12:00:00Z", "0,6")).toBe(false);
  });

  test("ranges wrap, so 5-1 is Friday to Monday", () => {
    expect(at("2026-09-27T12:00:00Z", "5-1")).toBe(true);
    expect(at("2026-09-30T12:00:00Z", "5-1")).toBe(false);
  });

  // A typo must not silently mute every realtime notification.
  test("falls back to Monday-Friday on an unparseable value", () => {
    expect(at("2026-09-28T12:00:00Z", "banana")).toBe(true);
    expect(at("2026-09-27T12:00:00Z", "banana")).toBe(false);
  });

  test("the hour window applies independently of the day", () => {
    expect(at("2026-09-28T20:00:00Z", "0-6", "09:00", "18:00")).toBe(false);
    expect(at("2026-09-28T10:00:00Z", "0-6", "09:00", "18:00")).toBe(true);
  });

  test("the end of the window is exclusive", () => {
    expect(at("2026-09-28T18:00:00Z", "1-5", "09:00", "18:00")).toBe(false);
    expect(at("2026-09-28T09:00:00Z", "1-5", "09:00", "18:00")).toBe(true);
  });
});
