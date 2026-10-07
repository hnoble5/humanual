import { z } from "zod";

// The coach's reply to a journal entry: a short card, not a conversation.
export const JournalSchema = z.object({
  title: z.string().describe("3-7 word title for the entry in the user's own terms, e.g. 'Called the gym to cancel'"),
  went_well: z
    .array(z.string())
    .describe("1-3 specific things that went well or that they handled well, taken from what they wrote. Never invent. Empty only if nothing in the entry fits."),
  encouragement: z
    .string()
    .describe("1-2 sentences of encouragement specific to this entry. No generic praise, no therapy-speak."),
  advice: z
    .string()
    .describe("One concrete thing to try next time, or a next step, with exact words if it involves saying something. Empty string if nothing is needed."),
  reality: z
    .string()
    .describe("If they're replaying or worried about something: an honest check on how much it matters and how likely others noticed or will remember. Empty string otherwise."),
  follow_up: z
    .string()
    .describe("Only if something really needs follow-up (a reply, an apology, a task): the exact words or step. Otherwise empty string."),
});
export type JournalCard = z.infer<typeof JournalSchema>;

export function journalRequest(text: string, replaying: string) {
  return [
    "This request comes from the Journal tool in the app, not the chat. The user wrote a journal entry and wants a short reply: encouragement and, where it helps, advice. Don't ask questions: reply now.",
    "Read it the way a coach who knows them would: notice what they did well, be honest, and keep it short enough to read in under a minute.",
    "A journal is a safe place to vent. Don't lecture, and don't turn a good day into a to-do list: leave advice, reality, and follow_up empty when nothing is needed.",
    "Use what's in their profile when it's relevant, but never invent facts about them or the people involved.",
    `Journal entry:\n${text}`,
    replaying ? `Something they keep replaying: ${replaying}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
