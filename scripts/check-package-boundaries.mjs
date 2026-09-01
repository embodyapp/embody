import { ESLint } from "eslint";

const eslint = new ESLint();
const filePath = "packages/host/src/index.ts";
const [invalid] = await eslint.lintText('import "@embody/core/src/internal.js";\n', { filePath });
const [valid] = await eslint.lintText('import "@embody/core";\n', { filePath });
const boundaryViolation = invalid?.messages.some(
  (message) => message.ruleId === "no-restricted-imports",
);

if (!boundaryViolation || (valid?.errorCount ?? 1) !== 0) {
  console.error("Package-boundary lint self-test failed", { invalid, valid });
  process.exitCode = 1;
}
