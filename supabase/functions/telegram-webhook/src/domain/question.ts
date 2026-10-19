/** The user's message as received, kept so the assistant can be re-run once its question is answered. */
export type ChatInput = {
  text: string;
  photoIds: string[];
  imageMime: string;
  audio: { fileId: string; mime: string | null } | null;
  /** ISO time the user sent the message: the reference "now" and the logged time of any meal it creates. */
  sentAt: string;
  messageId: number;
};

export type QuestionAnswer = { question: string; answer: string };

export type PendingQuestion = {
  /** Short random id in the buttons, so taps on an older question's buttons are ignored. */
  id: string;
  question: string;
  options: string[];
  askedAt: string;
  input: ChatInput;
  /** Earlier rounds, oldest first; the open question is not included. */
  history: QuestionAnswer[];
  fixMealId: string | null;
};

export const isOpen = (q: PendingQuestion | null, now: number, ttlMs: number): q is PendingQuestion =>
  q != null && now - Date.parse(q.askedAt) < ttlMs;

export const newQuestionId = () => crypto.randomUUID().slice(0, 8);

const normalized = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Edits that only change case, punctuation or spacing don't change what the message says. */
export const isMeaningfulEdit = (before: string, after: string) => normalized(before) !== normalized(after);
