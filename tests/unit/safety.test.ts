// Unit tests for the crisis pre-check and the cards' safety flag.
// Run: npm run test:unit
//
// The two lists below are the spec for src/crisis.ts. When you change a
// pattern, add the phrasing that prompted it here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crisisCheck } from "../../src/crisis.ts";
import { ScriptSchema } from "../../src/script.ts";

const MUST_MATCH = [
  // Suicide and wanting to die
  "I want to kill myself",
  "I've been thinking about suicide",
  "honestly kms",
  "I want to unalive myself",
  "I've been thinking about ending things",
  "I keep having thoughts of ending it",
  "everyone would be better off without me",
  "nobody would care if I was gone",
  "no one would notice",
  "I just want to disappear forever",
  "I don't want to be alive anymore",
  "I don't want to wake up tomorrow",
  "I wish I was never born",
  "I can't do this anymore",
  // Self-harm and overdose
  "I keep wanting to hurt myself",
  "I started cutting myself again",
  "I've been thinking about taking all my pills",
  "what if I took a handful of my meds",
  // Danger from someone else
  "he said he's going to hurt me",
  "she told me she'd kill me if I left",
  "he threatened to kill me",
  "my husband hit me again",
  "I'm scared to go home",
  "I'm not safe here",
];

const MUST_NOT_MATCH = [
  "This meeting is killing me",
  "My boss is going to kill me if I miss this deadline",
  "My mom is gonna kill me when she sees this",
  "I'm going to kill him if he takes credit again lol",
  "I'd rather die than make this phone call",
  "My boss hit me with another deadline",
  "She hit me up on Slack after the meeting",
  "I'm ending things with my landlord, how do I word it?",
  "I want to end the call politely",
  "I can't do this presentation without notes",
  "nobody would care if I skipped the party, right?",
];

test("crisis pre-check catches crisis language", () => {
  const missed = MUST_MATCH.filter((s) => !crisisCheck(s));
  assert.deepEqual(missed, [], "these should match");
});

test("crisis pre-check ignores everyday idioms", () => {
  const flagged = MUST_NOT_MATCH.filter((s) => crisisCheck(s));
  assert.deepEqual(flagged, [], "these should not match");
});

test("memory update for a crisis exchange is caught by the pre-check", () => {
  // /api/remember skips any exchange the pre-check flags.
  assert.ok(crisisCheck("From a coach chat.\n\nThe user wrote:\nI want to die\n\nThe coach replied:\n..."));
});

test("script cards ask for the safety flag first", () => {
  // First, so the model decides before writing anything upbeat. The journal
  // card uses the same field (src/journal.ts).
  assert.equal(Object.keys(ScriptSchema.shape)[0], "safety_concern");
  assert.equal(ScriptSchema.shape.safety_concern.parse(true), true);
});
