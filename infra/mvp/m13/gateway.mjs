// M13 qualification gateway: the hosted workspace gateway on Cloud Run with its own workload
// identity. It serves the public JWKS candidates verify against, the deployment and rollback
// routes (tasks to the controller queue), and app calls to candidates with private Cloud Run
// invocation tokens. Configuration comes from the run's records and secrets only. The M14 suite
// also sets EMBODY_SOURCE_BUCKET and EMBODY_SOURCE_SIGNER: the M10 source routes on GCS (signed
// create-only uploads through the signer's signBlob, verification with the gateway's identity),
// so the packed CLI uploads through the gateway like a user. M13 runs leave them unset.
import { URL } from "node:url";
import {
  GcsSourceObjectStore,
  PostgresGatewayStore,
  cloudRunInvocationToken,
  createWorkspaceGateway,
  hostedSigningIdentity,
} from "../../../packages/gateway/dist/index.js";
import { cloudTasksQueue } from "../../../packages/host/dist/index.js";

const env = process.env;
for (const name of [
  "GATEWAY_PLATFORM_DATABASE_URL",
  "GATEWAY_SERVICE_ACCOUNT_EMAIL",
  "GATEWAY_JWT_ISSUER",
  "GATEWAY_JWT_KID",
  "GATEWAY_JWT_PRIVATE_KEY",
  "GATEWAY_JWT_PUBLIC_JWKS",
  "EMBODY_SQL_CONNECTION",
  "EMBODY_M12_QUEUE",
  "EMBODY_M12_TASK_URL",
  "EMBODY_M12_INVOKER",
])
  if (!env[name]) throw new Error(`Missing ${name}`);
const dsn = new URL(env.GATEWAY_PLATFORM_DATABASE_URL);
dsn.searchParams.set("host", `/cloudsql/${env.EMBODY_SQL_CONNECTION}`);
const store = new PostgresGatewayStore(dsn.href);
const gateway = createWorkspaceGateway({
  store,
  token: await hostedSigningIdentity({
    issuer: env.GATEWAY_JWT_ISSUER,
    kid: env.GATEWAY_JWT_KID,
    privateKeyPem: env.GATEWAY_JWT_PRIVATE_KEY,
    publicKeys: JSON.parse(env.GATEWAY_JWT_PUBLIC_JWKS).keys,
  }),
  invocationToken: cloudRunInvocationToken({
    serviceAccountEmail: env.GATEWAY_SERVICE_ACCOUNT_EMAIL,
  }),
  ...(env.EMBODY_SOURCE_BUCKET && env.EMBODY_SOURCE_SIGNER
    ? {
        sources: {
          objects: new GcsSourceObjectStore({
            bucket: env.EMBODY_SOURCE_BUCKET,
            signerEmail: env.EMBODY_SOURCE_SIGNER,
            timeoutMs: 10_000,
          }),
        },
      }
    : {}),
  deployments: {
    queue: cloudTasksQueue({
      queue: env.EMBODY_M12_QUEUE,
      url: env.EMBODY_M12_TASK_URL,
      audience: env.EMBODY_M12_TASK_URL,
      invokerEmail: env.EMBODY_M12_INVOKER,
    }),
  },
});
await gateway.listen({ host: "0.0.0.0", port: Number(env.PORT ?? 8080) });
