// Typed mirror of supabase/migrations (the migrations are the source of truth for DDL, RLS and grants).
import { sql } from "drizzle-orm";
import { bigint, boolean, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MealItem } from "../domain/meal.ts";
import type { Step, Units } from "../domain/onboarding.ts";
import type { Activity, Objective, Sex } from "../domain/nutrition.ts";

const app = pgSchema("app");

const tgId = () => bigint("tg_id", { mode: "number" }).notNull().default(sql`app.tg_id()`);
const decimal = (name: string) => numeric(name, { mode: "number" });
const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const users = app.table("users", {
  tgId: bigint("tg_id", { mode: "number" }).primaryKey(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  firstName: text("first_name"),
  onboardingStep: text("onboarding_step").$type<Step>().notNull().default("key"),
  units: text("units").$type<Units>().notNull().default("metric"),
  sex: text("sex").$type<Sex>(),
  age: integer("age"),
  heightCm: decimal("height_cm"),
  weightKg: decimal("weight_kg"),
  activity: text("activity").$type<Activity>(),
  objective: text("objective").$type<Objective>(),
  paceKgPerWeek: decimal("pace_kg_per_week"),
  utcOffsetMinutes: integer("utc_offset_minutes").notNull().default(0),
  targetKcal: integer("target_kcal"),
  targetProteinG: integer("target_protein_g"),
  targetCarbsG: integer("target_carbs_g"),
  targetFatG: integer("target_fat_g"),
  fixMealId: uuid("fix_meal_id"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const meals = app.table("meals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tgId: tgId(),
  eatenAt: tstz("eaten_at").notNull().defaultNow(),
  description: text("description").notNull(),
  userNote: text("user_note"),
  items: jsonb("items").$type<MealItem[]>().notNull().default([]),
  kcal: integer("kcal").notNull(),
  proteinG: decimal("protein_g").notNull(),
  carbsG: decimal("carbs_g").notNull(),
  fatG: decimal("fat_g").notNull(),
  photoFileIds: text("photo_file_ids").array().notNull().default([]),
  sourceMessageId: bigint("source_message_id", { mode: "number" }),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const mealRevisions = app.table("meal_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tgId: tgId(),
  mealId: uuid("meal_id").notNull(),
  before: jsonb("before").$type<MealSnapshot>(),
  undoneAt: tstz("undone_at"),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

export const processedUpdates = app.table("processed_updates", {
  updateId: bigint("update_id", { mode: "number" }).primaryKey(),
  tgId: tgId(),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

export const mediaGroupItems = app.table("media_group_items", {
  mediaGroupId: text("media_group_id").notNull(),
  tgId: tgId(),
  messageId: bigint("message_id", { mode: "number" }).notNull(),
  fileId: text("file_id").notNull(),
  caption: text("caption"),
  claimed: boolean("claimed").notNull().default(false),
  createdAt: tstz("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.mediaGroupId, t.messageId] })]);

export type User = typeof users.$inferSelect;
export type UserPatch = Partial<Omit<typeof users.$inferInsert, "tgId" | "createdAt" | "updatedAt">>;
export type Meal = typeof meals.$inferSelect;
export type NewMeal = Omit<typeof meals.$inferInsert, "id" | "tgId" | "createdAt" | "updatedAt">;
/** A meal row serialized to JSON (dates become ISO strings). */
export type MealSnapshot = Omit<Meal, "eatenAt" | "createdAt" | "updatedAt"> & { eatenAt: string; createdAt: string; updatedAt: string };
