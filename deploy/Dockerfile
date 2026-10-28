ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
FROM ${NODE_IMAGE} AS platform
WORKDIR /suite/apps/platform
COPY apps/platform/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/platform/ ./
COPY packages/ /suite/packages/
COPY suite.json /suite/suite.json
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS makit
WORKDIR /suite/apps/makit
COPY apps/makit/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/makit/ ./
RUN npm run build:selfhost

FROM ${NODE_IMAGE} AS makit-dependencies
WORKDIR /suite/apps/makit
COPY apps/makit/package*.json ./
RUN npm pkg delete 'dependencies.@lark-apaas/fullstack-nestjs-core' 'dependencies.@lark-apaas/nestjs-common' && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && test ! -d node_modules/@lark-apaas/fullstack-nestjs-core && test ! -d node_modules/@lark-apaas/nestjs-common

FROM ${NODE_IMAGE} AS weknow
RUN npm install -g pnpm@11.25.0 --ignore-scripts --no-audit --no-fund
WORKDIR /suite/integrations/weknow/source
COPY integrations/weknow/source/package.json integrations/weknow/source/pnpm-lock.yaml integrations/weknow/source/pnpm-workspace.yaml ./
COPY integrations/weknow/source/patches/ ./patches/
COPY integrations/weknow/source/apps/server/package.json ./apps/server/package.json
COPY integrations/weknow/source/apps/client/package.json ./apps/client/package.json
COPY integrations/weknow/source/packages/editor-ext/package.json ./packages/editor-ext/package.json
RUN pnpm install --frozen-lockfile
COPY integrations/weknow/source/ ./
RUN npm --prefix packages/editor-ext run build && npm --prefix apps/server run build && npm --prefix apps/client run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /suite
COPY --from=platform /suite/apps/platform /suite/apps/platform
COPY --from=makit-dependencies /suite/apps/makit /suite/apps/makit
COPY --from=makit /suite/apps/makit/dist /suite/apps/makit/dist
COPY --from=makit /suite/apps/makit/scripts/selfhost /suite/apps/makit/scripts/selfhost
COPY --from=makit /suite/apps/makit/migrations /suite/apps/makit/migrations
COPY --from=makit /suite/apps/makit/integrations/iteration-bot /suite/apps/makit/integrations/iteration-bot
COPY --from=weknow /suite/integrations/weknow/source /suite/integrations/weknow/source
COPY packages/ ./packages/
COPY package.json suite.json ./
COPY deploy/runtime/ ./deploy/runtime/
COPY tools/recover-owner.mjs ./tools/recover-owner.mjs
EXPOSE 4100 4101 4102
USER node
CMD ["node", "deploy/runtime/start.mjs"]
