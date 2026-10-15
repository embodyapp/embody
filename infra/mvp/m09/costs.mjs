// M09 cost worksheet. List prices, USD, us-central1, captured 2026-10-15 from the public
// pricing pages below. Estimates only: not an invoice, not a cap. Free allowances are per
// billing account and are deliberately ignored here, so the worksheet errs high.
export const PRICES = Object.freeze({
  capturedAt: "2026-10-15",
  region: "us-central1",
  sources: Object.freeze({
    sql: "https://cloud.google.com/sql/pricing",
    run: "https://cloud.google.com/run/pricing",
    tasks: "https://cloud.google.com/tasks/pricing",
    artifactRegistry: "https://cloud.google.com/artifact-registry/pricing",
    logging: "https://cloud.google.com/stackdriver/pricing",
    tasksLimits: "https://docs.cloud.google.com/tasks/docs/quotas",
  }),
  sqlHourly: Object.freeze({ "db-f1-micro": 0.0105, "db-g1-small": 0.035 }),
  sqlHddGiBHour: 0.000123288,
  sqlSsdGiBHour: 0.000232877,
  sqlBackupGiBHour: 0.000109589,
  sqlIdleIpv4Hour: 0.01,
  runVcpuSecond: 0.000024,
  runGiBSecond: 0.0000025,
  runPerMillionRequests: 0.4,
  tasksPerMillionOperations: 0.4,
  artifactGiBHour: 0.000136986,
  loggingPerGiB: 0.5,
});
const HOURS_PER_MONTH = 730;
const round = (value) => Math.round(value * 100) / 100;

/**
 * Monthly running baseline for the MVP (MD06 ceiling $50). Inputs are workload assumptions;
 * every line item is listed so the owner can review and change them.
 */
export function monthlyWorksheet({
  tier = "db-f1-micro",
  diskGiB = 10,
  backupGiB = 1,
  apps = 5,
  actionsPerAppMonth = 20_000,
  vcpu = 1,
  memoryGiB = 0.5,
  secondsPerRequest = 0.3,
  coldStartSeconds = 3,
  coldStartsPerAppMonth = 3_000,
  durableItemsPerAppMonth = 2_000,
  tasksPerDurableItem = 2,
  drainSeconds = 0.5,
  imageGiB = 2,
  logGiB = 2,
  gatewayRequestsMonth = 150_000,
} = {}) {
  if (!(tier in PRICES.sqlHourly)) throw new Error("Unsupported Cloud SQL tier");
  const appRequests = apps * actionsPerAppMonth;
  const drains = apps * durableItemsPerAppMonth * tasksPerDurableItem;
  const activeSeconds =
    (appRequests + gatewayRequestsMonth) * secondsPerRequest +
    drains * drainSeconds +
    (apps + 1) * coldStartsPerAppMonth * coldStartSeconds;
  const items = [
    {
      item: "Cloud SQL instance",
      basis: `${tier}, zonal, 730 h`,
      usd: PRICES.sqlHourly[tier] * HOURS_PER_MONTH,
    },
    {
      item: "Cloud SQL storage",
      basis: `${diskGiB} GiB HDD`,
      usd: diskGiB * PRICES.sqlHddGiBHour * HOURS_PER_MONTH,
    },
    {
      item: "Cloud SQL backups",
      basis: `${backupGiB} GiB used`,
      usd: backupGiB * PRICES.sqlBackupGiBHour * HOURS_PER_MONTH,
    },
    {
      item: "Cloud Run CPU",
      basis: `${Math.round(activeSeconds)} active s × ${vcpu} vCPU (request billing)`,
      usd: activeSeconds * vcpu * PRICES.runVcpuSecond,
    },
    {
      item: "Cloud Run memory",
      basis: `${Math.round(activeSeconds)} active s × ${memoryGiB} GiB`,
      usd: activeSeconds * memoryGiB * PRICES.runGiBSecond,
    },
    {
      item: "Cloud Run requests",
      basis: `${appRequests + gatewayRequestsMonth + drains} requests incl. drains`,
      usd: ((appRequests + gatewayRequestsMonth + drains) / 1e6) * PRICES.runPerMillionRequests,
    },
    {
      item: "Cloud Tasks",
      basis: `${drains} tasks × (create + ≥1 delivery)`,
      usd: ((drains * 2) / 1e6) * PRICES.tasksPerMillionOperations,
    },
    {
      item: "Artifact Registry",
      basis: `${imageGiB} GiB images`,
      usd: imageGiB * PRICES.artifactGiBHour * HOURS_PER_MONTH,
    },
    { item: "Cloud Logging", basis: `${logGiB} GiB ingested`, usd: logGiB * PRICES.loggingPerGiB },
    { item: "Egress, DNS, domain, Secret Manager", basis: "contingency", usd: 3 },
  ].map((line) => ({ ...line, usd: round(line.usd) }));
  const total = round(items.reduce((sum, line) => sum + line.usd, 0));
  return {
    prices: PRICES.capturedAt,
    items,
    totalUsd: total,
    ceilingUsd: 50,
    withinCeiling: total <= 50,
  };
}

/** Conservative one-off qualification estimate (MD06 one-off budget $25) from measured lifetimes. */
export function qualificationEstimate({
  sqlHours,
  tier = "db-f1-micro",
  diskGiB = 10,
  backupGiBHours = 0,
  serviceActiveSeconds,
  jobSeconds,
  taskOperations,
  logGiB = 0.1,
  imageGiB = 2,
  imageHours = 24,
  contingencyUsd = 2,
}) {
  for (const value of [sqlHours, serviceActiveSeconds, jobSeconds, taskOperations])
    if (!(Number.isFinite(value) && value >= 0)) throw new Error("Measured lifetimes required");
  // Assume a full 1 vCPU + 1 GiB for every service/job second, idle or not.
  const runSeconds = serviceActiveSeconds + jobSeconds;
  const items = {
    sql: PRICES.sqlHourly[tier] * sqlHours + diskGiB * PRICES.sqlHddGiBHour * sqlHours,
    backups: backupGiBHours * PRICES.sqlBackupGiBHour,
    run: runSeconds * (PRICES.runVcpuSecond + PRICES.runGiBSecond),
    tasks: (taskOperations / 1e6) * PRICES.tasksPerMillionOperations,
    logs: logGiB * PRICES.loggingPerGiB,
    images: imageGiB * PRICES.artifactGiBHour * imageHours,
    contingency: contingencyUsd,
  };
  const total = Object.values(items).reduce((sum, value) => sum + value, 0);
  return {
    invoiceMeasured: false,
    prices: PRICES.capturedAt,
    items: Object.fromEntries(Object.entries(items).map(([key, value]) => [key, round(value)])),
    estimatedUpperUsd: round(total),
  };
}
