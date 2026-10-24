// Digest-pinned images the local build emulator uses (test:m11, test:m14): the runtime base the
// recipe assembles onto and the Docker CLI image for docker steps. Cloud Build pulls the same
// digests in the live suites.
export const RUNTIME_IMAGE =
  "docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5";
export const DOCKER_CLI =
  "docker.io/library/docker:29-cli@sha256:6fae2214c3121a28d5aa639d09032f61310b7c9c75ffbad1025f261a1b621800";
