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

/** One run of the assistant on a message, kept so it can be started again. */
export type Job = {
  input: ChatInput;
  answers: QuestionAnswer[];
  fixMealId: string | null;
  /** Set for an edited message; the meals that message touched are looked up when the job runs. */
  edit: { before: string | null; sentAt: string } | null;
  /** Messages sent before `input` that got no reply yet, oldest first; handled together with it. */
  earlier?: ChatInput[];
};

/** The assistant run in progress, kept on the user so a newer message can take it over. */
export type ActiveRun = {
  /** Also the undo batch id of everything the run changes. */
  id: string;
  startedAt: string;
  /** Set once the run has finished its changes and is sending its reply; it can no longer be taken over. */
  committedAt: string | null;
  job: Job;
};

/** A run that started (or committed) this long ago died without clearing itself and is ignored. */
export const isStaleRun = (r: ActiveRun, now: number, staleMs: number) =>
  now - Date.parse(r.committedAt ?? r.startedAt) > staleMs;

/**
 * One job covering an unfinished run's messages and a newer one, or null when they can't be combined:
 * an edit run has its own context, so it is left to finish, and so is the newer job when it edits a message
 * the running job doesn't contain. Editing a message still in flight just replaces its text.
 */
export function mergeJobs(prev: Job, next: Job): Job | null {
  if (prev.edit) return null;
  const pending = [...(prev.earlier ?? []), prev.input];
  if (next.edit) {
    const i = pending.findIndex((m) => m.messageId === next.input.messageId);
    if (i < 0) return null;
    const edited = { ...pending[i], text: next.input.text };
    return {
      ...prev,
      earlier: pending.slice(0, -1).map((m, j) => (j === i ? edited : m)),
      input: i === pending.length - 1 ? edited : prev.input,
    };
  }
  return {
    input: next.input,
    earlier: [...pending, ...(next.earlier ?? [])],
    answers: [...prev.answers, ...next.answers],
    fixMealId: next.fixMealId ?? prev.fixMealId,
    edit: null,
  };
}

/** Every message a job covers, oldest first. */
export const jobInputs = (j: Job) => [...(j.earlier ?? []), j.input];

/** A job that failed or was stopped by the daily budget, behind a Retry or Continue button with this id. */
export type SavedRun = Job & { id: string };

export const isOpen = (
  q: PendingQuestion | null,
  now: number,
  ttlMs: number,
): q is PendingQuestion => q != null && now - Date.parse(q.askedAt) < ttlMs;

export const newQuestionId = () => crypto.randomUUID().slice(0, 8);

const normalized = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Edits that only change case or spacing don't change what the message says. */
export const isMeaningfulEdit = (before: string, after: string) =>
  normalized(before) !== normalized(after);
