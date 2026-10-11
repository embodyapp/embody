import { platformConfiguration } from "./verification.mjs";
try {
  platformConfiguration();
} catch {
  console.error(
    "Missing or invalid platform database configuration (EMBODY_PLATFORM_URL / EMBODY_PLATFORM_MIGRATION_URL)",
  );
  process.exitCode = 1;
}
