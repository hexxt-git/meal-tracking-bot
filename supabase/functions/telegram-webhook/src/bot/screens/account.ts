// Menu, profile, settings and help panels.
import { ACTIVITY, LB_PER_KG } from "../../domain/nutrition.ts";
import { parseChoice } from "../../domain/onboarding.ts";
import { countryName } from "../../domain/countries.ts";
import { fmtOffset, localTime } from "../../domain/time.ts";
import type { Ctx } from "../context.ts";
import { keyPromptView } from "./onboarding.ts";
import { TZ_QUESTION, tzPicker } from "./timezone.ts";
import { btn, LOG_HINT, Reply, table, View } from "../ui.ts";

export const menuView = (): View => ({
  text: "<b>Menu</b>",
  keyboard: [
    [btn("Today", "day:0"), btn("Week", "week")],
    [btn("History", "hist:0"), btn("Goals", "goals")],
    [btn("Profile", "prof"), btn("Settings", "set")],
    [btn("Export CSV", "csv"), btn("Import CSV", "imp")],
    [btn("Help", "help")],
  ],
});

export const helpView = (): View => ({
  text: `<b>How it works</b>

${LOG_HINT} Several photos sent together count as one meal.

To correct something, just say so, for example "that was 2 eggs, not 3", "add a coke to lunch" or "I had it at 10". Meals logged in the last 24 hours can be changed this way; tapping Fix under a reply tells the assistant which meal you mean.

Packaged and restaurant food is looked up online, preferring products sold in your country (set it in Settings). When an amount matters and can't be guessed, the assistant asks a quick multiple-choice question.

You can also ask about your log, for example "how much protein do I have left today?"

Use Today, History and Menu at the bottom of the chat to browse what you logged, adjust your goals and change settings.`,
  keyboard: [[btn("‹ Menu", "menu")]],
});

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function profileView(ctx: Ctx): View {
  const u = ctx.user;
  const imperial = u.units === "imperial";
  const height = u.heightCm == null ? "–" : imperial
    ? `${Math.floor(Math.round(u.heightCm / 2.54) / 12)}'${Math.round(u.heightCm / 2.54) % 12}"`
    : `${Math.round(u.heightCm)} cm`;
  const weight = u.weightKg == null ? "–" : imperial ? `${Math.round(u.weightKg * LB_PER_KG)} lb` : `${u.weightKg.toFixed(1)} kg`;
  const pace = u.paceKgPerWeek ? (imperial ? `${(u.paceKgPerWeek * LB_PER_KG).toFixed(1)} lb/wk` : `${u.paceKgPerWeek} kg/wk`) : "";
  const goal = u.objective ? `${cap(u.objective)}${u.objective !== "maintain" && pace ? ` ${pace}` : ""}` : "–";
  return {
    text: `<b>Profile</b>\n\n${table([
      ["Sex", u.sex ? cap(u.sex) : "–"],
      ["Age", u.age ? String(u.age) : "–"],
      ["Height", height],
      ["Weight", weight],
      ["Activity", u.activity ? ACTIVITY[u.activity].label.split(" (")[0] : "–"],
      ["Goal", goal],
    ], ["l", "l"])}Editing your profile recalculates your daily goals.`,
    keyboard: [[btn("Edit profile", "prof:edit")], [btn("‹ Menu", "menu")]],
  };
}

export async function settingsView(ctx: Ctx): Promise<View> {
  const u = ctx.user;
  const hasKey = (await ctx.db.keys.get()) != null;
  const other = u.units === "metric" ? "imperial" : "metric";
  return {
    text: `<b>Settings</b>\n\n${table([
      ["Units", cap(u.units)],
      ["Timezone", `${fmtOffset(u.utcOffsetMinutes)}  (now ${localTime(new Date(), u.utcOffsetMinutes).slice(11)})`],
      ["Country", countryName(u.country) ?? "Not set"],
      ["API key", hasKey ? "Saved" : "Not set"],
    ], ["l", "l"])}`,
    keyboard: [
      [btn(`Switch to ${other}`, `units:${other}`)],
      [btn("Change timezone", "tz:s:p:-1"), btn("Change country", "ct:s")],
      [btn(hasKey ? "Replace API key" : "Add API key", "key:new"), ...(hasKey ? [btn("Remove API key", "key:rm")] : [])],
      [btn("Delete account", "acct")],
      [btn("‹ Menu", "menu")],
    ],
  };
}

export async function setUnits(ctx: Ctx, [units]: string[]): Promise<Reply> {
  const patch = parseChoice("units", units, ctx.user);
  if (patch) ctx.user = await ctx.db.users.update(patch);
  return { view: await settingsView(ctx) };
}

/** `tz:s:p:<page>` shows the picker; `tz:s:<offset>` saves. Onboarding picks (`tz:o:*`) are routed to onboarding. */
export async function settingsTimezone(ctx: Ctx, [a, b]: string[]): Promise<Reply> {
  if (a === "p") {
    const page = Number(b);
    return {
      view: {
        text: `<b>Timezone</b>\n\n${TZ_QUESTION}`,
        keyboard: [...tzPicker("s", page >= 0 ? page : null, ctx.user.utcOffsetMinutes), [btn("‹ Settings", "set")]],
      },
    };
  }
  const patch = parseChoice("timezone", a, ctx.user);
  if (!patch) return {};
  ctx.user = await ctx.db.users.update(patch);
  return { view: await settingsView(ctx), toast: "Timezone saved" };
}

export async function keyAction(ctx: Ctx, [action]: string[]): Promise<Reply> {
  if (action === "new") return { view: keyPromptView("set") };
  if (action === "rm") {
    await ctx.db.keys.delete();
    return { view: await settingsView(ctx), toast: "Key removed" };
  }
  return {};
}

export async function accountAction(ctx: Ctx, [action]: string[]): Promise<Reply> {
  if (action === "yes") {
    await ctx.db.users.deleteAccount();
    return { view: { text: "Your profile, meals and API key were deleted. Send /start to begin again.", keyboard: [] } };
  }
  return {
    view: {
      text: "<b>Delete account</b>\n\nThis permanently deletes your profile, every logged meal and your stored API key.",
      keyboard: [[btn("Delete everything", "acct:yes"), btn("Cancel", "set")]],
    },
  };
}
