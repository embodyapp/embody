import { defineWorkspace } from "vitest/config";

// The Vitest helper currently loses its callable type under project-service linting.
// eslint-disable-next-line @typescript-eslint/no-unsafe-call
export default defineWorkspace(["packages/*/vitest.config.ts"]);
