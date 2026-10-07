import { z } from "zod";

// What the coach remembers about a user across conversations, journal entries
// and scripts. It's a short list of plain facts the user can see and delete in
// Settings. The browser keeps the list (and syncs it with the profile) and sends
// it with every request; after each exchange it asks /api/remember to update it.

export const MAX_MEMORIES = 80;
export const MAX_MEMORY_CHARS = 300;

export const MemorySchema = z.object({
  memories: z
    .array(z.string())
    .describe(
      `The complete updated list, at most ${MAX_MEMORIES} items. Each is one short, plain fact in the third person ("Has a dentist cleaning booked for Oct 14"). Keep every existing item that is still true, word for word. Update items the new exchange changes, and drop ones it shows are no longer true.`,
    ),
});

export const MEMORY_SYSTEM = [
  "You maintain the memory of a social coaching app for neurodivergent adults: a list of facts the coach should remember about the user so they never have to repeat themselves.",
  "Remember what the user tells you about themselves and their life: people in their life (names, roles, how those relationships are going), their job and workplace, situations they're dealing with and how they turned out, upcoming events and plans with dates, what's hard for them, what helps, their preferences for how the coach talks to them, and their wins.",
  "Only record what the user actually said or clearly confirmed. Don't record the coach's advice, guesses about other people, or anything the user asked to keep out of memory. Resolve relative dates (\"next Tuesday\") using today's date.",
  "Write each fact in plain words, third person, one fact per item. Merge duplicates. When the list is full, drop the least useful items: old, resolved, or trivial ones.",
  "If the exchange contains nothing worth remembering, return the existing list unchanged.",
].join("\n");

export function memoryRequest(memories: string[], exchange: string, today: string) {
  return [
    `Today is ${today}.`,
    "Current memory list:",
    memories.length ? memories.map((m) => `- ${m}`).join("\n") : "(empty)",
    "New exchange:",
    exchange,
  ].join("\n\n");
}
