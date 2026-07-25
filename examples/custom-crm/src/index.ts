/**
 * This app's own plugin surface. Kept as a single entry point so the plugin can be
 * lifted into its own published package later without touching its callers.
 */
export {
  acmeCrmPlugin,
  acmeCrmMigrationsDir,
  hipaaVetoReason,
  REGULATED_VERTICAL,
} from "./plugin.ts";
