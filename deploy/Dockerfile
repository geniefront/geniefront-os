# ─────────────────────────────────────────────────────────────────────────────
#  API 镜像。多阶段：装依赖 → 只带运行时需要的东西进最终层。
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable

# 只先拷贝清单，让依赖层能被缓存 —— 改业务代码不会重装 node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json  packages/contracts/
COPY packages/db/package.json         packages/db/
COPY packages/scheduling/package.json packages/scheduling/
COPY apps/api/package.json            apps/api/
RUN pnpm install --frozen-lockfile --prod=false


FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini 负责转发信号并回收僵尸进程。
# 没有它，容器里的 node 是 PID 1，收不到 SIGTERM 就只能等 10 秒被 SIGKILL——
# 滚动部署时正在处理的请求会被硬切断。
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# 不用 root 跑
RUN chown -R node:node /app
USER node

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./node_modules/.bin/tsx", "apps/api/src/server.ts"]
