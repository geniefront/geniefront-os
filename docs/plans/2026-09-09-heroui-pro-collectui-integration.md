# HeroUI Pro：CollectUI 代理接入约定

核对日期：2026-09-09。用户指定 HeroUI Pro 使用 [CollectUI 代理](https://docs.collectui.pro/)。本文补充 [V2 重构计划](2026-09-09-v2-refactor-architecture-plan.md)，后续开发 HeroUI Pro 组件前先读本文。

本轮完成文档学习、现有配置结构核对和 hpmcp 发布包的只读检查。未运行安装器、未下载付费组件、未调用带凭据的代理接口、未修改 MCP 配置；未验证用户凭据有效性。用户在会话中提供的凭据没有复制到本文件或其他仓库文件。

## 1. 产品和凭据对应关系

| 项目 | 使用方式 |
| --- | --- |
| HeroUI 开源基础组件 | `@heroui/react`、`@heroui/styles`，延续现有项目风格 |
| HeroUI React Pro | `@heroui-pro/react`，按 CollectUI 文档使用 `hpsetup` 安装 |
| MCP | `hpmcp` 本地代理，Web 选择 `react` 渠道 |
| Agent Skills | CollectUI 提供的 React Pro 与 design-taste 技能包 |
| 用户所称 `hp_key` | 安装下载凭据；hpsetup 环境变量名为 `HEROUI_KEY` |
| `HEROUI_PERSONAL_TOKEN` | MCP/Skills 使用的另一枚凭据，不能用 HP Key 替代 |

网站 URL 中的 `hp_key`/`personal_token` 是文档站凭据注入参数，不是 Vite 配置。项目文档、示例、提交和分享链接只使用占位符；真实凭据放在本机私有配置或 CI secret 中，不加 `VITE_` 前缀，不进入浏览器构建产物。

CollectUI 是第三方代理，HeroUI Pro 是商业组件来源，不归入此前 MIT 开源组件的授权范围。文档站关于上游授权、备份、可用性和更新期限的描述属于提供方声明，本轮未独立验证。实际采用范围以用户订阅和对应许可为准。

## 2. 本项目的使用优先级

1. 优先使用已保留的自定义业务组件与 HeroUI 基础组件。
2. 通用高级界面优先查询 HeroUI Pro：Sidebar、Sheet、Command、EmptyState、Stepper、KPI、表格/图表、数字输入和聊天展示等。
3. 根据实际安装版本的 MCP 文档、包导出和类型选择 API，不按旧截图或文档中的组件数量写死能力。
4. Pro 也有 Kanban、Agenda 等组件，但不因此替换用户自定义 Kanban 和日程。只在局部复用确有收益时接入。
5. AI SDK 负责模型通信；assistant-ui primitives 负责聊天运行时与交互；HeroUI/Pro 可承担外观与部分展示组件。不要同时维护 assistant-ui 和 Pro 各自独立的聊天状态机。
6. shadcn 仅作设计/组件实现参考。引入源码时必须适配 `@gf/ui`，不叠加整套 shadcn 全局主题；不替换现有配色、导航或业务流程。

## 3. 安装与升级流程

来源：[hpsetup 用法](https://docs.collectui.pro/hpsetup/usage)、[工作原理](https://docs.collectui.pro/hpsetup/architecture)、[Web 快速开始](https://docs.collectui.pro/web/quick-start)。

后续在独立 V2 工程中接入，步骤为：

1. 确认基础 HeroUI 页面已能运行，记录工作区和依赖基线。
2. 查看所选 hpsetup 版本的 `--help`，先执行 `--dry-run`，检查工作区、peer dependencies 和配置变更范围。
3. 为 Web 选择 `react` 产品。当前不安装 Native Pro；原生应用不在本次重构范围。
4. 安装后检查 package manifests、lockfile、workspace 构建脚本许可与实际包版本。
5. 接入 CSS 和一个实际使用的组件，执行类型检查、生产构建及浏览器检查。
6. 记录安装器版本、Pro 版本及对应依赖；升级作为显式维护任务，不在普通启动时隐式追最新。

官方文档给出的交互式调用形式如下，占位符不可原样执行：

```text
pnpm dlx hpsetup@<已核对的版本> <HP_KEY> react --dry-run
pnpm dlx hpsetup@<已核对的版本> <HP_KEY> react
```

自动模式通过进程环境的 `HEROUI_KEY` 提供凭据，并从 package.json 推断产品。示意调用如下，前提是环境和目标依赖已配置：

```text
pnpm dlx hpsetup@<已核对的版本> --dry-run
```

注意：文档称重新运行 hpsetup 会查询并更新 Pro 包；仅固定安装器版本不等于固定下载的 Pro 版本。文档未列出明确的 Pro 版本选择参数，不编造 `--version` 等安装选项。首次接入要验证固定产物/缓存恢复与 CI 重现方法，不能宣称 lockfile 单独足以复现代理下载内容。

### Monorepo 与 pnpm

- 文档支持从 monorepo 根目录扫描 Web/Native workspace；自动模式会处理所有匹配应用，初次安装要核对目标范围。
- hpsetup 文档写明跳过 `packages/*` 共享库。V2 计划有 `packages/ui`，因此需要明确 Pro 依赖归属，并验证共享库的依赖解析；不能以根安装成功推断 `@gf/ui` 可以直接引用 Pro。
- pnpm 安装可能修改 workspace 的 `allowBuilds` 等配置。只允许已核对且实际需要的构建脚本，不把批准所有依赖当作安装前提。
- 文档列出本地缓存 `~/.heroui/cache/`；`--no-cache` 有频率限制，排错不循环强制刷新。
- 文档中的 Next.js/Vercel、Bun 和模板示例不是本项目的架构要求。继续使用 React/Vite、pnpm、Fastify，不因接入 Pro 换栈。

## 4. CSS 与导入约定

全局样式顺序：

```css
@import "tailwindcss";
@import "@heroui/styles";
@import "@heroui-pro/react/css";
```

随后使用 `@gf/ui` 统一管理现有品牌变量与有明确作用范围的业务样式。保留并验证项目现有 CSS layer、Portal 和语义 z-index 规则。

Pro 组件使用子路径导入，例如：

```tsx
import { AreaChart } from "@heroui-pro/react/area-chart";
import { ChartTooltip } from "@heroui-pro/react/chart-tooltip";
```

避免从 `@heroui-pro/react` 主入口导入全部组件。代理文档说明主入口可能让 Vite 解析未使用组件的依赖，引起 Markdown/代码高亮等依赖报错。子路径以实际版本的 `exports` 为准。来源：[子路径导入](https://docs.collectui.pro/other/heroui-pro-subpath-imports)。

CollectUI 的 monorepo 示例明确记录了 shadcn 全局样式覆盖 HeroUI 的问题。V2 不直接复制其删除所有 globals 的步骤，因为当前文件还有品牌与层级规则；只定位并移除冲突规则。来源：[Monorepo 指南](https://docs.collectui.pro/monorepo/default-monorepo)。

pnpm/Vite 如果出现 `jsx` 导出错误，文档提供 `optimizeDeps.include` 排查方向。先复现并确认 React 解析和依赖版本，再针对实际组件配置；不把主入口预构建示例无条件套入所有项目。

## 5. MCP 配置与查询工作流

来源：[Local MCP](https://docs.collectui.pro/ai-tools/mcp)。本轮发现旧工程 `.mcp.json` 已有 `heroui-pro` 和 `heroui-native-pro` 条目，使用 `npx` 启动 `hpmcp@latest`，参数分别为渠道与 token。只核对结构，没有改写或在本文复制凭据；配置存在不代表当前会话已连接成功。

公开 npm 发布包只读核对结果：2026-09-09 的 `hpmcp` latest 为 `0.0.18`，启动形式为 `hpmcp <react|native> <token>`。该版本读取位置参数，没有直接读取 `HEROUI_PERSONAL_TOKEN` 环境变量的代码。因此不能只设置这个环境变量而漏传 token。来源：[npm 发布元数据](https://registry.npmjs.org/hpmcp/latest)。

通用 MCP 客户端 JSON 结构示例，仅用于说明参数；应放在客户端本机私有配置，不能将填入真实值的版本提交到仓库：

```json
{
  "mcpServers": {
    "heroui-pro": {
      "command": "npx",
      "args": ["-y", "hpmcp@0.0.18", "react", "<PERSONAL_TOKEN>"]
    }
  }
}
```

客户端支持的配置格式和秘密注入方式按实际客户端核对；不要假设所有客户端都支持 `${ENV_VAR}` 字符串插值。可用本地启动脚本把进程环境中的 token 传给 hpmcp；当前尚未创建此脚本。

hpmcp 发布包配置的 React 上游是 `https://hp-mcp-proxy.932324.xyz/mcp`，Native 是 `https://hp-native-mcp-proxy.932324.xyz/mcp`。这些域名来自指定代理的配置，区别于 HeroUI 官方直连。

开发组件时：

1. 发现当前 MCP 暴露的工具和输入 schema。
2. 查询组件列表与目标组件文档，再查询 CSS/主题变量。
3. 查询源码时注意 `get_component_source_code` 在文档中限定为 OSS `@heroui/react`，不能宣称可用它获取全部 Pro 源码。
4. 按实际返回 API 编写 `@gf/ui` 封装和 Storybook 场景。
5. 只有用户提供具体 HeroUI AI Chat 导出任务时才调用导出工具，不主动读取无关导出资料。

文档声称 Web MCP 已统一覆盖 Pro 与 OSS；后续以工具发现结果验证，避免重复配置两套 Web MCP。离线缓存仅可复用已有内容，不视为实时最新文档。

## 6. Agent Skills

来源：[Agent Skills](https://docs.collectui.pro/ai-tools/skills)。当前需要的技能为：

- `heroui-react-pro`：Pro 组件模式、API 与 CSS 使用约定。
- `heroui-pro-design-taste`：排版、间距、颜色、表单和无障碍等设计原则。

`heroui-native-pro` 当前不安装。设计技能与用户已认可的风格冲突时，以用户要求为准；不借技能改变 Kanban/日程的产品方向。

文档提供安装脚本地址 `https://hp-skills.932324.xyz/install`，使用 `HEROUI_PERSONAL_TOKEN` 认证；安装参数是上述技能名称。后续如实施安装，先下载到本地检查脚本，再以所选技能为参数执行，避免在未读取脚本时直接管道执行。

文档所列 Codex 技能目录为 `~/.codex/skills/{skill-name}/`，支持通过 `HEROUI_PRO_SKILLS_DIR` 指定目录。自动安装脚本可能检测多个 AI 客户端，执行前核对目标目录与覆盖范围。本文仅记录方案，没有安装或宣称当前会话已加载这些技能。

## 7. 接入完成标准

- Pro 在目标 Web workspace 和 `@gf/ui` 中均能正确解析；重新安装/构建有明确的版本与产物恢复方案。
- 代表组件类型检查、生产构建通过；浏览器中无缺依赖、样式覆盖或弹层层级问题。
- MCP 至少完成一次组件列表、组件文档和主题查询；实际输入 schema 已核对。
- 所需 Skills 已安装到正确客户端位置并能被发现；未配置项如实记录。
- 仓库文档和前端构建不包含真实凭据；本地配置与 CI secret 的来源明确。
- 自定义 Kanban、日程和现有视觉基线继续保留；Pro 组件的接入通过新旧场景对照。

以上均为后续实施验收条件，本轮只完成学习与文档补充。
