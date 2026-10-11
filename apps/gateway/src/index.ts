import {
  createGateway,
  createWorkspaceGateway,
  PostgresGatewayStore,
  GatewayRegistry,
  AuthChain,
  apiKeyProvider,
  hashApiKey,
  hostedSigningIdentity,
  cloudRunInvocationToken,
  type GatewayTokenOptions,
} from "@embody/gateway";
import type { Principal } from "@embody/core";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required gateway environment variable: ${name}`);
  return value;
};
const profile = process.env["GATEWAY_PROFILE"] ?? "reference";
const token =
  profile === "hosted"
    ? await hostedSigningIdentity({
        issuer: required("GATEWAY_JWT_ISSUER"),
        kid: required("GATEWAY_JWT_KID"),
        privateKeyPem: required("GATEWAY_JWT_PRIVATE_KEY"),
        publicKeys: (
          JSON.parse(required("GATEWAY_JWT_PUBLIC_JWKS")) as NonNullable<
            GatewayTokenOptions["publicJwks"]
          >
        ).keys,
      })
    : {
        issuer: process.env["GATEWAY_JWT_ISSUER"] ?? "embody-e2e-gateway",
        key: new TextEncoder().encode(required("GATEWAY_JWT_SECRET")),
      };
const environment =
  process.env["NODE_ENV"] === "production" ? ("production" as const) : ("development" as const);
function referenceGateway() {
  const principal: Principal = {
    orgId: process.env["E2E_ORG_ID"] ?? "e2e-org",
    actorId: process.env["E2E_ACTOR_ID"] ?? "e2e-agent",
    actorType: "agent",
    roles: ["developer"],
    scopes: (process.env["E2E_SCOPES"] ?? "kanban:*,email:*").split(",").filter(Boolean),
  };
  const apiKey = required("GATEWAY_API_KEY");
  const secondApiKey = process.env["E2E_SECOND_API_KEY"];
  const registry = new GatewayRegistry({
    allowPrivateEndpoints: true,
    ttlMs: Number(process.env["GATEWAY_REGISTRY_TTL_MS"] ?? 90_000),
    credentials: {
      kanban: required("KANBAN_REGISTRATION_SECRET"),
      email: required("EMAIL_REGISTRATION_SECRET"),
    },
  });
  const app = createGateway({
    registry,
    token,
    environment,
    auth: new AuthChain([
      apiKeyProvider([
        { id: "primary", hash: hashApiKey(apiKey), principal },
        ...(secondApiKey
          ? [
              {
                id: "other-org",
                hash: hashApiKey(secondApiKey),
                principal: {
                  ...principal,
                  orgId: "e2e-other-org",
                  actorId: "other-agent",
                  scopes: ["kanban:*"],
                },
              },
            ]
          : []),
      ]),
    ]),
  });
  app.get("/health", () => ({ live: true, registeredApps: registry.snapshot().length }));
  return app;
}
if (profile !== "reference" && profile !== "hosted") throw new Error("Unknown GATEWAY_PROFILE");
const store =
  profile === "hosted"
    ? new PostgresGatewayStore(required("GATEWAY_PLATFORM_DATABASE_URL"))
    : undefined;
const app = store
  ? createWorkspaceGateway({
      store,
      token,
      environment,
      invocationToken: cloudRunInvocationToken({
        serviceAccountEmail: required("GATEWAY_SERVICE_ACCOUNT_EMAIL"),
      }),
    })
  : referenceGateway();
if (store) app.addHook("onClose", () => store.close());
// No auto-migration or credential bootstrap as runtime; provision separately with maintenance authority.
const port = Number(process.env["PORT"] ?? 4000);
const address = await app.listen({ port, host: process.env["HOST"] ?? "0.0.0.0" });
console.log(`Gateway listening at ${address} (${profile})`);
const close = () => void app.close();
process.once("SIGINT", close);
process.once("SIGTERM", close);
