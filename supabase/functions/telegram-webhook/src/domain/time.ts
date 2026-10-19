const DAY_MS = 86_400_000;

/** Whole-hour zones first (UTC−12…+14), then the common fractional ones, so pickers can page through hours first. */
export const TZ_OFFSETS = [
  ...Array.from({ length: 27 }, (_, i) => (i - 12) * 60),
  210, 270, 330, 345, 570,
];

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

const TZ_PAGE_SIZE = 12;
export const TZ_PAGES = Math.ceil(TZ_OFFSETS.length / TZ_PAGE_SIZE);

export function tzPage(page: number): number[] {
  return TZ_OFFSETS.slice(page * TZ_PAGE_SIZE, (page + 1) * TZ_PAGE_SIZE);
}

export function tzPageOf(offsetMin: number): number {
  return Math.max(0, Math.floor(TZ_OFFSETS.indexOf(offsetMin) / TZ_PAGE_SIZE));
}

/** "Mon 19 Oct" for the local date of `d`. */
export function localDayLabel(d: Date, offsetMin: number): string {
  return new Date(d.getTime() + offsetMin * 60_000).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  }).replace(",", "");
}

/** ISO 8601 with the user's offset, e.g. "2026-10-19T13:42:00+01:00". */
export function localIso(d: Date, offsetMin: number): string {
  return `${new Date(d.getTime() + offsetMin * 60_000).toISOString().slice(0, 19)}${isoOffset(offsetMin)}`;
}

/** "Mon 2026-10-19 13:42": weekday included so the model can resolve "on Saturday" or "yesterday". */
export function localStamp(d: Date, offsetMin: number): string {
  const weekday = new Date(d.getTime() + offsetMin * 60_000).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${localTime(d, offsetMin)}`;
}

const SAME_TIME_MS = 15 * 60_000;

/**
 * When a meal was eaten, plus when it was logged if that differs meaningfully.
 * "13:42" · "10:00, logged 13:42" · "Sun 18 Oct 20:00, logged Mon 19 Oct 09:10"
 */
export function mealTimeLabel(eatenAt: Date, loggedAt: Date, offsetMin: number): string {
  const day = (d: Date) => localTime(d, offsetMin).slice(0, 10);
  const at = (d: Date, withDay: boolean) => `${withDay ? `${localDayLabel(d, offsetMin)} ` : ""}${localTime(d, offsetMin).slice(11)}`;
  if (Math.abs(eatenAt.getTime() - loggedAt.getTime()) < SAME_TIME_MS) return at(eatenAt, false);
  const sameDay = day(eatenAt) === day(loggedAt);
  return `${at(eatenAt, !sameDay)}, logged ${at(loggedAt, !sameDay)}`;
}
