import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFixApproaches } from "./review-fixes.js";
import type { FixApproach } from "./types.js";

const A1: FixApproach = {
  title: "Stream",
  description: "Use streaming response instead of buffering",
  snippet: "const stream = res.pipe(transform)",
  prompt: "Refactor to use streaming: replace buffer with stream.pipe",
};

const A2: FixApproach = {
  title: "Cache",
  description: "Cache the result to avoid recomputing",
  snippet: "const cached = cache.get(key) ?? compute(key)",
  prompt: "Add cache layer: wrap compute() with cache.get/set",
};

test("empty fixes array returns empty string", () => {
  assert.strictEqual(renderFixApproaches([]), "");
});

test("2-approach input includes heading and both titles", () => {
  const result = renderFixApproaches([A1, A2]);
  assert.ok(result.includes("**Ways to fix this:**"), "heading missing");
  assert.ok(result.includes("**Stream**"), "first title missing");
  assert.ok(result.includes("**Cache**"), "second title missing");
});

test("2-approach input includes both snippets", () => {
  const result = renderFixApproaches([A1, A2]);
  assert.ok(result.includes(A1.snippet), "first snippet missing");
  assert.ok(result.includes(A2.snippet), "second snippet missing");
});

test("2-approach input includes two 📋 Copy as prompt details blocks", () => {
  const result = renderFixApproaches([A1, A2]);
  const count = (result.match(/📋 Copy as prompt/g) ?? []).length;
  assert.strictEqual(count, 2, "expected 2 copy-as-prompt details blocks");
});

test("TSX-looking snippet gets tsx fence", () => {
  const result = renderFixApproaches([
    { title: "Component", description: "Wrap in component", snippet: "<div>hello</div>", prompt: "wrap" },
  ]);
  assert.ok(result.includes("```tsx"), "expected tsx fence for JSX-like snippet");
});

test("plain snippet gets plain fence", () => {
  const result = renderFixApproaches([
    { title: "Plain", description: "Simple fix", snippet: "const x = 1", prompt: "set x to 1" },
  ]);
  assert.ok(result.includes("```\n"), "expected plain fence for non-JSX snippet");
  assert.ok(!result.includes("```tsx"), "should NOT have tsx fence for plain snippet");
});

test("snippet containing triple backticks gets a longer outer fence", () => {
  const mdSnippet = "```js\nconst x = 1\n```";
  const result = renderFixApproaches([
    {
      title: "Fence",
      description: "Snippet with embedded backticks",
      snippet: mdSnippet,
      prompt: "wrap in a fence",
    },
  ]);
  // Content has runs of 3 backticks → outer fence must use 4+ ticks
  assert.ok(result.includes("````"), "expected 4-tick outer fence when snippet contains ```");
  // Snippet content must appear verbatim (inner backticks not breaking the block)
  assert.ok(result.includes(mdSnippet), "snippet content must appear verbatim inside the fence");
});
