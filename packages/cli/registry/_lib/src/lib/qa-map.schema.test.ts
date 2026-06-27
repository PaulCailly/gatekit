import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../../docs/public/qa-map.schema.json", import.meta.url)), "utf8"));

test("schema requires the generated-map shape", () => {
  assert.equal(schema.type, "object");
  for (const k of ["generatedAt", "locales", "routes"]) assert.ok(k in schema.properties, `missing ${k}`);
  assert.equal(schema.properties.routes.items.properties.path.pattern, "^/");
});
