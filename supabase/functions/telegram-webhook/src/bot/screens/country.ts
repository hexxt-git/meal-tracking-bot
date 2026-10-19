import { COUNTRY_LETTERS, COUNTRY_PAGE_SIZE, countriesByLetter, countryName } from "../../domain/countries.ts";
import { parseChoice } from "../../domain/onboarding.ts";
import type { Button, Keyboard } from "../../telegram/types.ts";
import type { Ctx } from "../context.ts";
import { btn, Reply, rows } from "../ui.ts";
import { settingsView } from "./account.ts";
import { onboardingAction, stepView } from "./onboarding.ts";

/**
 * Callback data: `ct:<mode>` letter grid, `ct:<mode>:l:<letter>:<page>` countries under a letter,
 * `ct:<mode>:c:<code>` pick. Mode `o` is onboarding, `s` settings.
 */
export type CountryMode = "o" | "s";
export type CountryNav = { letter: string; page: number } | null;

export const COUNTRY_QUESTION =
  "Which country do you live in? It's used to look up the food brands, products and restaurants available there.";

export function countryPicker(mode: CountryMode, nav: CountryNav): Keyboard {
  if (!nav || !COUNTRY_LETTERS.includes(nav.letter)) {
    return rows(COUNTRY_LETTERS.map((l) => btn(l, `ct:${mode}:l:${l}:0`)), 6);
  }
  const all = countriesByLetter(nav.letter);
  const pages = Math.ceil(all.length / COUNTRY_PAGE_SIZE);
  const page = Math.min(pages - 1, Math.max(0, nav.page));
  const shown = all.slice(page * COUNTRY_PAGE_SIZE, (page + 1) * COUNTRY_PAGE_SIZE);
  const navRow: Button[] = [
    btn("‹ Letters", `ct:${mode}`),
    ...(page > 0 ? [btn("‹ Prev", `ct:${mode}:l:${nav.letter}:${page - 1}`)] : []),
    ...(page < pages - 1 ? [btn("More ›", `ct:${mode}:l:${nav.letter}:${page + 1}`)] : []),
  ];
  return [...rows(shown.map(([code, name]) => btn(name, `ct:${mode}:c:${code}`)), 2), navRow];
}

export async function countryAction(ctx: Ctx, [mode, kind, a, b]: string[]): Promise<Reply> {
  const nav: CountryNav = kind === "l" ? { letter: a, page: Number(b) || 0 } : null;
  if (mode === "o") {
    if (ctx.user.onboardingStep !== "country") return { toast: "That step was already answered" };
    return kind === "c" ? onboardingAction(ctx, ["country", a]) : { view: stepView(ctx, undefined, "", nav) };
  }
  if (kind === "c") {
    const patch = parseChoice("country", a, ctx.user);
    if (!patch) return {};
    ctx.user = await ctx.db.users.update(patch);
    return { view: await settingsView(ctx), toast: "Country saved" };
  }
  const current = countryName(ctx.user.country);
  return {
    view: {
      text: `<b>Country</b>${current ? `  ·  now ${current}` : ""}\n\n${COUNTRY_QUESTION}`,
      keyboard: [...countryPicker("s", nav), [btn("‹ Settings", "set")]],
    },
  };
}
