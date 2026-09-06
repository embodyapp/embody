import {
  createGateway,
  GatewayRegistry,
  AuthChain,
  apiKeyProvider,
  hashApiKey,
} from "@embody/gateway";
import type { Principal } from "@embody/core";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required gateway environment variable: ${name}`);
  return value;
};

const principal: Principal = {
  orgId: process.env["E2E_ORG_ID"] ?? "e2e-org",
  actorId: process.env["E2E_ACTOR_ID"] ?? "e2e-agent",
  actorType: "agent",
  roles: ["developer"],
  scopes: (process.env["E2E_SCOPES"] ?? "kanban:*,email:*").split(",").filter(Boolean),
};
const apiKey = required("GATEWAY_API_KEY");
const secondApiKey = process.env["E2E_SECOND_API_KEY"];
const signingSecret = required("GATEWAY_JWT_SECRET");
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
  token: {
    issuer: process.env["GATEWAY_JWT_ISSUER"] ?? "embody-e2e-gateway",
    key: new TextEncoder().encode(signingSecret),
  },
  environment: process.env["NODE_ENV"] === "production" ? "production" : "development",
});
app.get("/health", () => ({ live: true, registeredApps: registry.snapshot().length }));

const port = Number(process.env["PORT"] ?? 4000);
await app.listen({ port, host: process.env["HOST"] ?? "0.0.0.0" });
console.log(`Gateway listening on ${port}`);
const close = () => void app.close();
process.once("SIGINT", close);
process.once("SIGTERM", close);
