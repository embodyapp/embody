// Suites whose workers claim every due workflow step in the database (as in production, where
// one database belongs to one app) must not overlap: each would claim the other's steps. They
// hold this session advisory lock for their whole run, whatever the runner's file parallelism.
import { createRequire } from "node:module";
import { URL } from "node:url";

const { Client } = createRequire(new URL("../../../storage/package.json", import.meta.url))("pg");
const CLAIMING_SUITES = 2_026_101_520;

export async function holdClaimLock(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [CLAIMING_SUITES]);
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [CLAIMING_SUITES]);
    } finally {
      await client.end();
    }
  };
}
