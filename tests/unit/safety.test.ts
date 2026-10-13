// Unit tests for the crisis pre-check and the cards' safety flag.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { crisisCheck } from "../../src/crisis.ts";
import { ScriptSchema } from "../../src/script.ts";

test("crisis pre-check catches direct crisis language", () => {
  for (const s of [
    "I want to kill myself",
    "I've been thinking about suicide",
    "I keep wanting to hurt myself",
    "everyone would be better off without me",
    "I don't want to be alive anymore",
    "he said he's going to hurt me",
  ]) {
    assert.ok(crisisCheck(s), s);
  }
});

test("crisis pre-check ignores everyday idioms", () => {
  for (const s of ["This meeting is killing me", "I'd rather die than make this phone call", "My mom is gonna kill me"]) {
    assert.ok(!crisisCheck(s), s);
  }
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
