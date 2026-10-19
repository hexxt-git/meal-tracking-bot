import { MealItem, sanitizeItems } from "./meal.ts";

/** Columns written by the export, in order. Import reads columns by name, so older exports without logged_at_utc work too. */
export const EXPORT_COLUMNS = [
  "eaten_at_utc",
  "eaten_local_date",
  "eaten_local_time",
  "logged_at_utc",
  "description",
  "kcal",
  "protein_g",
  "carbs_g",
  "fat_g",
  "items",
  "note",
] as const;

const REQUIRED = ["eaten_at_utc", "description", "kcal", "protein_g", "carbs_g", "fat_g"];

export const MAX_IMPORT_ROWS = 5000;

export function toCsv(rows: unknown[][]): string {
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [EXPORT_COLUMNS.join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n");
}

/** RFC 4180: quoted fields may contain commas, newlines and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') (field += '"', i++);
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(field), field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field), rows.push(row), row = [], field = "";
    } else field += c;
  }
  if (field || row.length) (row.push(field), rows.push(row));
  return rows.filter((r) => r.some((f) => f.trim()));
}

export type ImportedMeal = {
  eatenAt: Date;
  loggedAt: Date;
  description: string;
  items: MealItem[];
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  userNote: string | null;
};

export type ImportResult = { ok: true; meals: ImportedMeal[]; invalidRows: number } | { ok: false; error: string };

export function parseMealsCsv(text: string): ImportResult {
  const [header, ...body] = parseCsv(text);
  if (!header) return { ok: false, error: "The file is empty." };
  const col = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  const missing = REQUIRED.filter((c) => !col.has(c));
  if (missing.length) return { ok: false, error: `Missing columns: ${missing.join(", ")}.` };
  if (body.length > MAX_IMPORT_ROWS) return { ok: false, error: `Too many rows (${body.length}); the limit is ${MAX_IMPORT_ROWS}.` };

  const get = (r: string[], name: string) => r[col.get(name) ?? -1]?.trim() ?? "";
  const meals: ImportedMeal[] = [];
  let invalidRows = 0;
  for (const r of body) {
    const meal = parseRow((name) => get(r, name));
    if (meal) meals.push(meal);
    else invalidRows++;
  }
  return { ok: true, meals, invalidRows };
}

function parseRow(get: (name: string) => string): ImportedMeal | null {
  const eatenAt = new Date(get("eaten_at_utc"));
  const logged = get("logged_at_utc");
  const loggedAt = logged ? new Date(logged) : eatenAt;
  const description = get("description").slice(0, 200);
  const [kcal, proteinG, carbsG, fatG] = ["kcal", "protein_g", "carbs_g", "fat_g"].map((c) => Number(get(c)));
  const valid = (d: Date) => !isNaN(d.getTime()) && d.getTime() <= Date.now() + 86_400_000;
  if (!valid(eatenAt) || !valid(loggedAt) || !description) return null;
  if (![kcal, proteinG, carbsG, fatG].every((n) => Number.isFinite(n) && n >= 0 && n < 100_000)) return null;
  return {
    eatenAt,
    loggedAt,
    description,
    items: parseItems(get("items")),
    kcal: Math.round(kcal),
    proteinG,
    carbsG,
    fatG,
    userNote: get("note").slice(0, 2000) || null,
  };
}

function parseItems(json: string): MealItem[] {
  try {
    const raw = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    const items = raw.filter((i) =>
      i && typeof i.name === "string" && typeof i.portion === "string" &&
      ["kcal", "protein_g", "carbs_g", "fat_g"].every((k) => typeof i[k] === "number" && Number.isFinite(i[k]))
    ).map((i) => ({ name: i.name, portion: i.portion, kcal: i.kcal, protein_g: i.protein_g, carbs_g: i.carbs_g, fat_g: i.fat_g }));
    return sanitizeItems(items);
  } catch {
    return [];
  }
}
