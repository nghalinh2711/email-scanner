import { EMAIL_CATEGORIES } from "./types";

/** messages.get costs 20 units. Per-user cap is 6,000 units per minute. */
export const GMAIL_GET_UNITS = 20;
export const GMAIL_UNITS_PER_MINUTE = 6000;

/**
 * One wave is 2,000 units. The next wave starts only after a full minute,
 * so two waves never share the 6,000-unit window.
 */
export const SCAN_WAVE_SIZE = 100;
export const SCAN_WAVE_INTERVAL_MS = 65_000;

export function uncategorizedInboxQuery(): string {
  const excluded = EMAIL_CATEGORIES.map(
    (category) => `-label:"Jev/${category}"`
  ).join(" ");
  return `in:inbox ${excluded}`;
}

export function waitForNextWave(waveStartedAt: number): number {
  return Math.max(0, SCAN_WAVE_INTERVAL_MS - (Date.now() - waveStartedAt));
}
