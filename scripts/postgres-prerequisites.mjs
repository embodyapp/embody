import { postgresConfiguration, redact } from "./verification.mjs";
try {
  postgresConfiguration();
} catch (error) {
  console.error(
    redact(error instanceof Error ? error.message : "PostgreSQL prerequisites missing"),
  );
  process.exitCode = 1;
}
