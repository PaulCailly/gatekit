import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafetyBlock } from "./gemini.js";

test("isSafetyBlock: true for a 400 safety-policy block (observed shape)", () => {
  const err = new Error(
    "got status: 400. Input blocked: The action to 'Erase all data' involves potential permanent loss of user information and falls under sensitive data management which requires explicit user confirmation.",
  );
  assert.equal(isSafetyBlock(err), true);
});

test("isSafetyBlock: true when status+message split across fields", () => {
  assert.equal(isSafetyBlock({ status: 400, message: "Input blocked under a safety policy" }), true);
});

test("isSafetyBlock: false for an unrelated 500 / network error", () => {
  assert.equal(isSafetyBlock(new Error("got status: 500. internal error")), false);
  assert.equal(isSafetyBlock(new Error("socket hang up")), false);
});
