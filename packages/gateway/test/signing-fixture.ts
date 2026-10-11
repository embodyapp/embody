import { generateKeyPair, exportPKCS8, exportJWK } from "jose";
import { hostedSigningIdentity } from "../src/index.js";
const pair = await generateKeyPair("ES256", { extractable: true });
export const privateKeyPem = await exportPKCS8(pair.privateKey);
export const publicKeys = [
  { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "ES256", use: "sig" },
];
export const signingIdentity = await hostedSigningIdentity({
  issuer: "test",
  kid: "test-key",
  privateKeyPem,
  publicKeys,
});
