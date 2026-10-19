import { fmtOffset, localTime, TZ_OFFSETS, TZ_PAGES, tzPage, tzPageOf } from "../../domain/time.ts";
import { btn, rows } from "../ui.ts";
import type { Button, Keyboard } from "../../telegram/types.ts";

/** Callback prefixes: `tz:<mode>:p:<page>` pages, `tz:<mode>:<offset>` picks. Mode `o` is onboarding, `s` settings. */
export type TzMode = "o" | "s";

export const TZ_QUESTION = "What time is it for you right now?";

/** A clock-time grid: people recognize their current time more easily than a UTC offset. */
export function tzPicker(mode: TzMode, page: number | null, currentOffset: number, now = new Date()): Keyboard {
  const p = Math.min(TZ_PAGES - 1, Math.max(0, page ?? tzPageOf(currentOffset)));
  const clock = (off: number) => localTime(now, off).slice(11);
  const times = tzPage(p).map((off) => {
    const time = clock(off);
    // Zones a day apart (e.g. UTC−10 and UTC+14) share a clock time, so those get their offset too.
    const ambiguous = off % 60 !== 0 || TZ_OFFSETS.some((o) => o !== off && clock(o) === time);
    return btn(ambiguous ? `${time}  ${fmtOffset(off)}` : time, `tz:${mode}:${off}`);
  });
  const nav: Button[] = [
    ...(p > 0 ? [btn("‹ Earlier", `tz:${mode}:p:${p - 1}`)] : []),
    ...(p < TZ_PAGES - 1 ? [btn("Later ›", `tz:${mode}:p:${p + 1}`)] : []),
  ];
  return [...rows(times, 4), ...(nav.length ? [nav] : [])];
}
