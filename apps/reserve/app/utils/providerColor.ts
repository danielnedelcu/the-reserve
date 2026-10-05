/**
 * Deterministic color per provider — stable across sessions and views,
 * shared by the schedule page and the dashboard week calendar.
 */
const PALETTE = [
  "#0f9b8e", // teal
  "#5b6ee1", // indigo
  "#e8833a", // orange
  "#c85c8e", // rose
  "#7f9c3f", // olive
  "#8260a2", // violet
  "#b6975a", // gold
  "#4e8fbf", // steel blue
];

export function providerColor(staffId: string): string {
  let hash = 0;
  for (let i = 0; i < staffId.length; i++) {
    hash = (hash * 31 + staffId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}

/** Soft background tint of the same hue, for month-view chips / day blocks */
export function providerTint(staffId: string): string {
  return `${providerColor(staffId)}1a`; // ~10% alpha hex suffix
}
