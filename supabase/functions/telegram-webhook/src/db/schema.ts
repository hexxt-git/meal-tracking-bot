// Typed mirror of supabase/migrations (the migrations are the source of truth for DDL, RLS and grants).
import { sql } from "drizzle-orm";
import { bigint, boolean, date, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MealItem } from "../domain/meal.ts";
import type { Step, Units } from "../domain/onboarding.ts";
import type { PendingQuestion, SavedRun } from "../domain/question.ts";
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
  country: text("country"),
  targetKcal: integer("target_kcal"),
  targetProteinG: integer("target_protein_g"),
  targetCarbsG: integer("target_carbs_g"),
  targetFatG: integer("target_fat_g"),
  fixMealId: uuid("fix_meal_id"),
  remindersEnabled: boolean("reminders_enabled").notNull().default(true),
  lastReminderAt: tstz("last_reminder_at"),
  pendingQuestion: jsonb("pending_question").$type<PendingQuestion>(),
  retryRun: jsonb("retry_run").$type<SavedRun>(),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const meals = app.table("meals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tgId: tgId(),
  eatenAt: tstz("eaten_at").notNull().defaultNow(),
  loggedAt: tstz("logged_at").notNull().defaultNow(),
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
  batchId: uuid("batch_id").notNull().defaultRandom(),
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

export const aiUsage = app.table("ai_usage", {
  tgId: tgId(),
  day: date("day").notNull(),
  costUsd: decimal("cost_usd").notNull().default(0),
  runs: integer("runs").notNull().default(0),
  searches: integer("searches").notNull().default(0),
  budgetBypassed: boolean("budget_bypassed").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.tgId, t.day] })]);

export const chatMessages = app.table("chat_messages", {
  tgId: tgId(),
  messageId: bigint("message_id", { mode: "number" }).notNull(),
  text: text("text").notNull().default(""),
  sentAt: tstz("sent_at").notNull(),
  batchIds: uuid("batch_ids").array().notNull().default([]),
  role: text("role").$type<"user" | "assistant">().notNull().default("user"),
  /** e.g. "photo", "voice note": what the message carried besides text. */
  attachments: text("attachments").array().notNull().default([]),
  createdAt: tstz("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tgId, t.messageId] })]);

export type ChatMessage = typeof chatMessages.$inferSelect;

export type User = typeof users.$inferSelect;
export type UserPatch = Partial<Omit<typeof users.$inferInsert, "tgId" | "createdAt" | "updatedAt">>;
export type Meal = typeof meals.$inferSelect;
export type NewMeal = Omit<typeof meals.$inferInsert, "id" | "tgId" | "createdAt" | "updatedAt">;
/** A meal row serialized to JSON (dates become ISO strings). */
export type MealSnapshot = Omit<Meal, "eatenAt" | "loggedAt" | "createdAt" | "updatedAt"> & {
  eatenAt: string;
  loggedAt: string;
  createdAt: string;
  updatedAt: string;
};
