// Local-topology stand-in for the provider services a hosted candidate reaches on Cloud Run.
// Loaded with `node --import` into candidate containers of the M14 LOCAL journey only (never
// into an image; the admitted image is unchanged). It routes, by exact origin:
//   - the platform JWKS origin (https) to the local gateway's /.well-known/jwks.json (http);
//   - the metadata-server token endpoint to a fixed opaque token (no Google identity exists);
//   - the Cloud Tasks API to the local task recorder, which records and acknowledges tasks.
// Everything else goes to the real network. NOT provider evidence: the live suite (M14 phase 2)
// uses real Cloud Run, Cloud Tasks and HTTPS JWKS.
const { Request, Response, URL } = globalThis;
const config = JSON.parse(process.env.EMBODY_M14_EMULATOR ?? "{}");
if (!config.jwksOrigin || !config.gateway || !config.tasks)
  throw new Error("EMBODY_M14_EMULATOR is incomplete");
const real = globalThis.fetch.bind(globalThis);
const urlOf = (input) =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

globalThis.fetch = async (input, init = {}) => {
  const url = urlOf(input);
  if (url.origin === config.jwksOrigin)
    return real(new URL(url.pathname, config.gateway), { ...init, redirect: "error" });
  if (url.origin === "http://metadata.google.internal")
    return new Response(JSON.stringify({ access_token: "local-emulator", expires_in: 3600 }), {
      headers: { "content-type": "application/json", "metadata-flavor": "Google" },
    });
  if (url.origin === "https://cloudtasks.googleapis.com") {
    const request = new Request(input, init);
    return real(new URL(`/tasks${url.pathname}`, config.tasks), {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: await request.text(),
    });
  }
  return real(input, init);
};
