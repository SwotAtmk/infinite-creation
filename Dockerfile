# syntax=docker/dockerfile:1.7
# 单镜像多阶段：app = 后端 + Agent，web = Studio 静态站 + 反向代理。
# 构建：docker compose build
# 运行：docker compose up -d

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app

# 依赖层：先放 sdk.mjs，让 postinstall 的 ensure-agent 直接跳过（镜像里不装 bun）
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY studio/package.json ./studio/package.json
COPY scripts/ensure-agent.mjs ./scripts/ensure-agent.mjs
COPY vendor/openclaude/dist/sdk.mjs ./vendor/openclaude/dist/sdk.mjs
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ENV NODE_ENV=production \
    NEXT_DIST_DIR=.next-studio
RUN mkdir -p data logs \
    && pnpm build \
    && pnpm --filter studio build

# 去掉 Next 构建缓存再交给运行层，避免把 ~470MB 的 cache 打进镜像
FROM build AS cleaned
RUN rm -rf .next-studio/cache .next-studio/trace .next-studio/types

# 静态 ffmpeg / ffprobe：不通过 apt 拉整套多媒体依赖，构建更快、镜像更可控
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

# CA 证书：slim 镜像不带 ca-certificates；从完整 node 镜像复制，避免构建时联网装包
FROM node:22-bookworm AS certs

# 后端运行层：只保留生产依赖 + 运行时源码
FROM node:22-bookworm-slim AS app
ENV NODE_ENV=production \
    PORT=4610 \
    NEXT_DIST_DIR=.next-studio \
    NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
RUN chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
    && ffmpeg -version >/dev/null
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY studio/package.json ./studio/package.json
COPY scripts/ensure-agent.mjs ./scripts/ensure-agent.mjs
COPY vendor/openclaude/dist/sdk.mjs ./vendor/openclaude/dist/sdk.mjs
RUN pnpm install --prod --frozen-lockfile

COPY --from=cleaned /app/.next-studio ./.next-studio
COPY --from=cleaned /app/studio/dist ./studio/dist
COPY --from=cleaned /app/server.js ./server.js
COPY --from=cleaned /app/next.config.mjs ./next.config.mjs
COPY --from=cleaned /app/middleware.js ./middleware.js
COPY --from=cleaned /app/jsconfig.json ./jsconfig.json
COPY --from=cleaned /app/app ./app
COPY --from=cleaned /app/lib ./lib
COPY --from=cleaned /app/public ./public
COPY --from=cleaned /app/skills ./skills
COPY --from=cleaned /app/workflows ./workflows
COPY --from=cleaned /app/scripts ./scripts
COPY --from=cleaned /app/config.example.json ./config.example.json
RUN mkdir -p /app/data /app/logs
EXPOSE 4610 4710
CMD ["node", "server.js"]
