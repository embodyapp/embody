import { expect, it } from "vitest";
import { parseGenUiResourceJson } from "../src/index.js";

it("decodes bounded static resource JSON and retains exact HTML/security metadata", () => {
  const resource = {
    text: "<!doctype html><main>Immutable code</main>",
    mimeType: "text/html;profile=mcp-app",
    metadata: {
      csp: { resourceDomains: ["https://assets.example"] },
      permissions: { camera: false },
      prefersBorder: true,
    },
  };
  expect(parseGenUiResourceJson(JSON.stringify(resource))).toEqual(resource);
});
it.each([
  "null",
  "[]",
  '{"text":"ok","tenantSecret":"private"}',
  '{"text":"ok","metadata":{"script":"private"}}',
  '{"text":"ok","mimeType":"text/html"}',
  '{"text":"ok","metadata":{"csp":{"resourceDomains":["file:///etc/passwd"]}}}',
  '{"text":"ok","metadata":{"permissions":{"camera":"private"}}}',
  "private invalid JSON",
])("rejects untrusted resource JSON without reflecting values", (json) => {
  expect(() => parseGenUiResourceJson(json)).toThrow("GenUI resource JSON is invalid");
});
