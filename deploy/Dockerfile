# ─────────────────────────────────────────────────────────────────────────────
#  API 镜像。
#
#  早期版本直接把整个 workspace（含 dev 依赖）拷进去用 tsx 跑 TS 源码，844MB。
#  现在用 esbuild 打成单文件再跑普通 node：
#    · 不带 node_modules —— turbo / vitest / drizzle-kit / typescript 全部留在构建阶段
#    · 不带 TS 源码和 sourcemap 之外的任何编译期产物
#    · 运行时只有 node:22-alpine + 一个 .mjs + tini
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable

# 先只拷清单，让依赖层能被缓存：改业务代码不会重装 node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json  packages/contracts/
COPY packages/db/package.json         packages/db/
COPY packages/scheduling/package.json packages/scheduling/
COPY packages/rotation/package.json   packages/rotation/
COPY packages/payroll/package.json    packages/payroll/
# ⚠️ ai / yelp 也要在这里 —— apps/api 依赖它们（拍照开店走 @gf/ai）。
# 漏掉的表现不在 install 那一步，而在后面 esbuild 打包时：
# "Could not resolve @anthropic-ai/sdk" —— 因为那个包压根没装进来。
COPY packages/ai/package.json         packages/ai/
COPY packages/yelp/package.json       packages/yelp/
COPY apps/api/package.json            apps/api/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

# 打成单文件。
# --packages=bundle 把依赖也打进去；postgres.js / jose / fastify 都是纯 JS，
# 没有原生模块，所以打得进去。
RUN node_modules/.bin/esbuild apps/api/src/main.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=esm \
      --outfile=/out/server.mjs \
      --minify \
      --sourcemap=external \
      --legal-comments=none \
      --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" \
 && ls -lh /out/server.mjs


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini 负责转发信号并回收僵尸进程。
# 没有它 node 是 PID 1，收不到 SIGTERM 就只能等 10 秒被 SIGKILL ——
# 滚动部署时正在处理的请求会被硬切断。
RUN apk add --no-cache tini

COPY --from=build /out/server.mjs /out/server.mjs.map ./

USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "server.mjs"]
