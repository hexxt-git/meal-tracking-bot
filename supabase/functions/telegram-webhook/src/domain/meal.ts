export type MealItem = {
  name: string;
  portion: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export type Totals = { kcal: number; proteinG: number; carbsG: number; fatG: number };

const round1 = (n: number) => Math.round(n * 10) / 10;

export function itemTotals(items: MealItem[]): Totals {
  return {
    kcal: items.reduce((s, i) => s + i.kcal, 0),
    proteinG: round1(items.reduce((s, i) => s + i.protein_g, 0)),
    carbsG: round1(items.reduce((s, i) => s + i.carbs_g, 0)),
    fatG: round1(items.reduce((s, i) => s + i.fat_g, 0)),
  };
}

export function sumTotals(rows: Totals[]): Totals {
  return {
    kcal: rows.reduce((s, r) => s + r.kcal, 0),
    proteinG: round1(rows.reduce((s, r) => s + r.proteinG, 0)),
    carbsG: round1(rows.reduce((s, r) => s + r.carbsG, 0)),
    fatG: round1(rows.reduce((s, r) => s + r.fatG, 0)),
  };
}

export function sanitizeItems(items: MealItem[]): MealItem[] {
  return items.map((i) => ({
    ...i,
    kcal: Math.max(0, Math.round(i.kcal)),
    protein_g: Math.max(0, i.protein_g),
    carbs_g: Math.max(0, i.carbs_g),
    fat_g: Math.max(0, i.fat_g),
  }));
}
