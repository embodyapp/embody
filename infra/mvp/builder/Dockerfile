# Embody build recipe image (embody-node24-pnpm-v1). Built by the platform from the exact
# candidate (`node infra/mvp/builder/stage.mjs` creates the context) and referenced by digest.
# It holds trusted step code and the bundled framework packages; customer code only ever runs
# in a no-network sandbox container started from this image as uid 1000.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}
ENV COREPACK_ENABLE_STRICT=0 NPM_CONFIG_UPDATE_NOTIFIER=false
RUN npm install -g --no-audit --no-fund pnpm@11.25.0 && pnpm --version
COPY framework/ /embody/framework/
RUN mkdir -p /embody/tools && cd /embody/tools && \
    npm install --no-audit --no-fund --ignore-scripts /embody/framework/cloud-contracts-*.tgz
COPY prepare.mjs registry.mjs extract.mjs sandbox.sh /embody/
RUN chmod 0555 /embody/sandbox.sh && chmod -R a-w /embody && \
    mkdir -p /app /out /store && chown 1000:1000 /app /out /store
LABEL org.embody.recipe=embody-node24-pnpm-v1
