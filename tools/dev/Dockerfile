FROM node:24-bookworm-slim
WORKDIR /trucker
RUN chown node:node /trucker
USER node

COPY --chown=node:node package.json package-lock.json .npmrc tsconfig.base.json ./
COPY --chown=node:node apps/api/package.json apps/api/package.json
COPY --chown=node:node apps/web/package.json apps/web/package.json
COPY --chown=node:node apps/console/package.json apps/console/package.json
RUN npm ci

COPY --chown=node:node db/ db/
COPY --chown=node:node apps/api/ apps/api/
COPY --chown=node:node apps/web/ apps/web/
COPY --chown=node:node apps/console/ apps/console/
RUN npm run build

