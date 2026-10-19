// The subset of Bot API types this bot reads.

export type Chat = { id: number; type: "private" | "group" | "supergroup" | "channel" };
export type From = { id: number; first_name?: string };
export type FileRef = { file_id: string; mime_type?: string; file_name?: string; file_size?: number };

export type Message = {
  message_id: number;
  /** Unix seconds when the user sent it. */
  date: number;
  from: From;
  chat: Chat;
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: FileRef[];
  document?: FileRef;
  voice?: FileRef;
  audio?: FileRef;
};

export type CallbackQuery = {
  id: string;
  from: From;
  data?: string;
  message?: { message_id: number; chat: Chat; text?: string };
};

export type Update = {
  update_id: number;
  message?: Message;
  callback_query?: CallbackQuery;
  my_chat_member?: { chat: Chat; from: From };
};

export type Button = { text: string; callback_data: string } | { text: string; url: string };
export type Keyboard = Button[][];
