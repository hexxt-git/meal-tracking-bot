const DAY_MS = 86_400_000;

export const TZ_OFFSETS = [
  ...Array.from({ length: 27 }, (_, i) => (i - 12) * 60),
  210, 270, 330, 345, 570,
].sort((a, b) => a - b);

/** -300 → "-05:00" */
export function isoOffset(min: number): string {
  const a = Math.abs(min);
  return `${min < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

export const fmtOffset = (min: number) => `UTC${isoOffset(min)}`;

/** "YYYY-MM-DD HH:MM" in the given offset. */
export function localTime(d: Date, offsetMin: number): string {
  return new Date(d.getTime() + offsetMin * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

/** UTC instant of local midnight `daysAgo` days back. */
export function dayStart(offsetMin: number, daysAgo = 0, now = Date.now()): Date {
  const localMs = now + offsetMin * 60_000;
  const startLocal = Math.floor(localMs / DAY_MS) * DAY_MS - daysAgo * DAY_MS;
  return new Date(startLocal - offsetMin * 60_000);
}

/** Accepts an AI-provided timestamp only if it's within the last 30 days and not in the future. */
export function parseEatenAt(s: string | null, now = Date.now()): Date | null {
  if (!s) return null;
  const d = new Date(s);
  const t = d.getTime();
  if (isNaN(t) || t > now + 3_600_000 || t < now - 30 * DAY_MS) return null;
  return d;
}

export function groupByLocalDay<T extends { eatenAt: Date }>(rows: T[], offsetMin: number): Map<string, T[]> {
  const days = new Map<string, T[]>();
  for (const r of rows) {
    const day = localTime(r.eatenAt, offsetMin).slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), r]);
  }
  return days;
}
