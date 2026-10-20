/** Hours without a logged meal after which a reminder is sent, once each, until the next meal is logged. */
export const REMINDER_HOURS = [12, 18, 24, 48];

const TEXTS: Record<number, string> = {
  12: "No meal logged in the last 12 hours. Send a photo, a description or a voice note when you eat.",
  18: "No meal logged in 18 hours. If you've eaten since, send it now so today's totals stay right.",
  24: "Nothing logged for a day. Whenever you eat next, send it here to keep your log going.",
  48: "Nothing logged for 2 days. This is the last reminder until you log a meal again. Reminders can be turned off in Settings.",
};

export const reminderText = (hours: number) => TEXTS[hours] ?? `No meal logged in ${hours} hours.`;
