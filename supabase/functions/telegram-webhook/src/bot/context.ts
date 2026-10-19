import type { User, UserDb } from "../db/index.ts";
import { telegram } from "../telegram/api.ts";
import type { View } from "./ui.ts";

export type Ctx = {
  user: User;
  db: UserDb;
  /** Sends a new message: a full view, or plain HTML without buttons. */
  send: (view: View | string) => Promise<unknown>;
};

export function createCtx(user: User, db: UserDb): Ctx {
  return {
    user,
    db,
    send: (view) => typeof view === "string" ? telegram.send(user.chatId, view) : telegram.send(user.chatId, view.text, view.keyboard),
  };
}
