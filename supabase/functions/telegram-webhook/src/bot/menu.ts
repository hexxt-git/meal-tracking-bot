/** Command names and descriptions for the Telegram menu (setMyCommands). */
export const COMMAND_MENU = [
  ["today", "Today's meals and totals"],
  ["week", "Last 7 days"],
  ["history", "Recent meals (with delete)"],
  ["goals", "Your daily targets"],
  ["profile", "Redo body stats and targets"],
  ["timezone", "Change timezone"],
  ["export", "Download all meals as CSV"],
  ["setkey", "Set your OpenRouter key"],
  ["deletekey", "Delete your OpenRouter key"],
  ["deleteaccount", "Delete all your data"],
  ["help", "How to use the bot"],
] as const;
