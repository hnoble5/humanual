import { z } from "zod";

export const CHANNELS = {
  phone: "Phone call",
  inperson: "In person",
  written: "Text or email",
} as const;
export type ChannelId = keyof typeof CHANNELS;

const level = z.enum(["low", "medium", "high"]);

export const ScriptSchema = z.object({
  title: z.string().describe("Short name for what the script is for, e.g. 'Reschedule a dentist cleaning by phone'"),
  energy: level.describe("How draining this is likely to be"),
  stakes: level.describe("How much it matters if it goes imperfectly"),
  norm: z
    .string()
    .describe("One sentence, under 25 words: the unwritten expectation that matters most here. Empty string if nothing non-obvious."),
  opener: z.string().describe("Exact first words. For text/email: the greeting and first line."),
  ask: z.string().describe("Exact words for the main ask. Use [brackets] for details the user fills in."),
  responses: z
    .array(z.object({ if: z.string(), say: z.string() }))
    .describe("2-3 replies this specific person is most likely to give, each with a short exact answer. For text/email: likely replies to the message."),
  stall: z.string().describe("A line to buy time if it goes off-script. For text/email: how to handle a reply they're not ready for."),
  exit: z.string().describe("A polite way out that's always available."),
  closer: z.string().describe("Exact closing words."),
  message: z
    .string()
    .describe("For text or email ONLY: the full ready-to-send message (with a Subject: line first for email). Empty string for other channels."),
  alternative: z
    .string()
    .describe("One sentence naming a real lower-effort option for this situation (online, app, text, email), or empty string. Don't guess."),
  comfort: z
    .array(z.string())
    .describe("0-2 tips specific to this situation (e.g. what to have in hand). Skip anything generic like 'take a deep breath'. Empty if none."),
});
export type Script = z.infer<typeof ScriptSchema>;

export function scriptRequest(channel: ChannelId, task: string, details: string) {
  return [
    "This request comes from the Scripts tool in the app, not the chat. Don't ask questions: produce the script now.",
    "Write a short, reusable script the user can keep on their phone and read from.",
    `Channel: ${CHANNELS[channel]}`,
    `What they need to do: ${task}`,
    details ? `Extra details from them: ${details}` : "",
    "Rules: exact words only, short sentences that fit one phone screen, [brackets] for anything you don't know.",
    "Be specific to this exact situation and person. Every line should only make sense for this task; cut anything that would fit any phone call or errand.",
    "Use what's in their profile when it's relevant, but never invent facts about them.",
    "Your persona can show in the wording of the norm and tips, but the lines they say must sound like them, plainly, not like you.",
  ]
    .filter(Boolean)
    .join("\n");
}
