const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
];

const relativeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 hours ago", "in 2 days", falling back to "just now" under a minute. */
export function formatRelativeTime(iso: string): string {
  const deltaSeconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(deltaSeconds);

  for (const [unit, unitSeconds] of RELATIVE_UNITS) {
    if (abs >= unitSeconds) {
      return relativeFormatter.format(Math.round(deltaSeconds / unitSeconds), unit);
    }
  }
  return "just now";
}
