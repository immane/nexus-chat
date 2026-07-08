FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS deps
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.frontend.json ./
COPY turbo.json ./

COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS builder
WORKDIR /app

COPY packages/shared/ packages/shared/
COPY apps/server/ apps/server/

RUN pnpm turbo build --filter=@nexus-chat/server

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @nexus-chat/server deploy --prod /deploy

FROM node:22-alpine AS runner
RUN apk add --no-cache tini

COPY --from=builder /deploy /app
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
