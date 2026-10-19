import type { User, UserDb } from "../db/index.ts";
import type { Keyboard } from "../telegram/types.ts";
import { telegram } from "../telegram/api.ts";

export type Ctx = {
  user: User;
  db: UserDb;
  reply: (html: string, keyboard?: Keyboard) => Promise<unknown>;
};

export function createCtx(user: User, db: UserDb): Ctx {
  return { user, db, reply: (html, keyboard) => telegram.send(user.chatId, html, keyboard) };
}
