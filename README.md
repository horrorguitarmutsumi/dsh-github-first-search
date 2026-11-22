# dsh-github-first-search

DeepSeek Harness（DSH）插件：**立项 / 选型前，让 agent 优先搜索 GitHub 找参考实现**，而不是直接动手写或泛泛 web 搜索。

架构：**Rust 引擎 + 薄 JS 壳**。所有核心逻辑（GitHub 搜索、README 抓取、限流处理）都在一个正常的 cargo 项目里；JS 壳（约 100 行，基本不用改）只负责把引擎注册成 agent 工具。

```
┌───────────────────────────────────────────┐
│ DSH (Node 宿主)                            │
│  └─ dsh-github-first-search (JS 壳)        │
│      defineTool({ search_github_repos })   │
│      defineTool({ read_github_readme })    │
│           │ 子进程：argv 进，JSON 出        │
│  ┌────────▼─────────┐                      │
│  │ engine/ (Rust)   │  ← 正常的 cargo 项目  │
│  │ GitHub REST API  │    cargo build/test  │
│  └──────────────────┘                      │
└───────────────────────────────────────────┘
```

## 工具

| 工具 | 说明 |
|---|---|
| `search_github_repos` | GitHub 仓库实时搜索，按 star 排序；支持 `language:`、`stars:`、`org:` 等 GitHub 限定符；description 中写明了“立项前必须先调用”的行为规则 |
| `read_github_readme` | 读取 `owner/name` 仓库的 README（markdown，默认截断 2 万字符） |

## 目录结构

```
├─ engine/            # Rust 引擎（正常 cargo 项目，可独立开发/测试/发布）
│  ├─ Cargo.toml
│  └─ src/
│     ├─ main.rs      # CLI 入口：search / readme 子命令
│     ├─ github.rs    # GitHub REST 访问 + 限流处理（含离线单测）
│     ├─ models.rs    # 与 JS 壳的 JSON 契约
│     └─ error.rs     # 统一错误类型（kind: rate_limited / http / …）
├─ src/               # JS 壳（dsh 插件入口）
│  ├─ index.ts        # defineTool 注册 + GITHUB_TOKEN 凭据解析
│  ├─ engine.ts       # 二进制定位 + 子进程调用
│  └─ render.ts       # 纯函数渲染器（可离线单测）
├─ test/              # JS 离线测试（node --test）
└─ cordis.patch.yml   # dsh bundle patch：挂载到 profile 层栈
```

## 快速开始（构建）

前置：Rust 工具链（`rustup`，rustc ≥ 1.85）、Node.js ≥ 24。

```bash
# 1. 构建并测试 Rust 引擎（正常 Rust 开发流程）
cargo test  --manifest-path engine/Cargo.toml
cargo build --release --manifest-path engine/Cargo.toml

# 2. 构建并测试 JS 壳（推荐 pnpm 10；.npmrc 已配置 @deepseek-ai 走官方源）
pnpm install          # 或 npx pnpm@10 install
npm run typecheck
npm test

# 3. 试跑引擎（可选）
engine/target/release/github-first search --query "terminal ui" --language rust --limit 5
```

## 安装到 dsh

```bash
# 从 GitHub 安装（发布仓库后）
dsh plugin --profile web add github:horrorguitarmutsumi/dsh-github-first-search
```

- **引擎二进制的来源**（按优先级自动定位）：
  1. 环境变量 `DSH_GITHUB_FIRST_SEARCH_BIN` 指定的路径
  2. 本地 `engine/target/release` 构建（开发者）
  3. 本地 `engine/target/debug` 构建
  4. `bin/` 目录 —— 安装时 postinstall（或手动 `npm run install:engine`）自动从 GitHub Releases 下载当前平台的二进制，**没有 Rust 工具链的用户也能直接用**
- 找不到引擎时工具不会崩溃，会返回一条 note 说明如何构建。

## 提升速率上限（推荐）

GitHub 匿名搜索限额为 10 次/分钟/IP。在 DSH 中配置名为 `GITHUB_TOKEN` 的凭据（或直接设置同名环境变量）即可提升到 30 次/分钟。插件通过 `ctx.credentials` 解析该凭据并传给引擎，缺省时静默降级为匿名访问。

## “GitHub 优先”是怎么生效的

装上插件即全局生效（无需额外配置），三层保障：

1. **系统提示规则**：插件向 agent 系统提示注册 `dsh-github-first-search:policy` 段落（order 1990，紧挨在宿主 web 搜索指引之前），**无例外**：只要本轮需要联网搜索——新闻、资讯、事件、调研、选型、排错——**第一步必须**先调用 `search_github_repos`（新闻也先搜当事项目/组织名拿一手出处），之后才允许用普通 web 搜索补充；GitHub 没搜到要明确说明。
2. **工具 description**：`search_github_repos` 的描述本身写明“先于通用 web 搜索调用”。
3. **降级行为**：GitHub 限流或引擎缺失时返回明确 note，agent 知道何时可以退回 web 搜索。

想在某个项目里关闭该规则，可在该项目的 `AGENTS.md` 里说明覆盖，或卸载插件。

## 开发指南

### Rust 侧（engine/）

正常 cargo 工作流：

```bash
cd engine
cargo add <crate>     # 加依赖
cargo test            # 跑单测（全部离线，mock GitHub 响应）
cargo clippy          # lint
cargo run -- search --query "todo app"   # 本地试跑
```

进程契约（与 `src/engine.ts` 对应，改动即破坏性变更）：

- `search --query Q [--limit N] [--sort stars|forks|updated|best-match] [--language L] [--min-stars N]`
- `readme owner/name [--max-chars N]`
- 退出码 0 → stdout 输出结果 JSON；退出码 1 → 输出 `{"error":{"kind":…,"message":…}}`

### JS 壳（src/）

壳层只做三件事：定位引擎二进制、spawn 并解析 JSON、用 `defineTool` 注册工具。工具失败时**降级返回 note** 而不是抛错，agent 可以据此调整行为。

```bash
pnpm install        # pnpm 会自动安装 dsh-tools 的严格 peer 链（npm 处理不了）
npm run typecheck   # tsc --noEmit
npm test            # 先 build 再 node --test（离线）
```

> 注意：`@deepseek-ai/*` 的 alpha 包在 npmmirror 等镜像上同步滞后，项目 `.npmrc` 已把 `@deepseek-ai` scope 固定到官方源；npm 因严格 peer 链无法安装，请使用 pnpm（与 DSH 上游一致）。

## 发布流程

1. 推送到 GitHub（本仓库：`github.com/horrorguitarmutsumi/dsh-github-first-search`）。
2. 仓库 topics 加上 `dsh-plugin`（官方的插件收录方式）。
3. 打标签触发发布流水线（`.github/workflows/release.yml`），四个平台的二进制自动挂到 Releases：

   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```

   产物：`github-first-x86_64-pc-windows-msvc.tar.gz`、`github-first-aarch64-apple-darwin.tar.gz`、`github-first-x86_64-apple-darwin.tar.gz`、`github-first-x86_64-unknown-linux-musl.tar.gz`（Linux 为 musl 静态链接，任意发行版可跑）+ `SHA256SUMS.txt`。
4. 用户 `dsh plugin add` 安装后，postinstall 自动下载对应平台二进制到 `bin/`。
5. （可选）`npm publish` 到 npm；（可选）向 [dshpluginhub.dev](https://dshpluginhub.dev/zh) / awesome 列表提交收录。

## License

MIT
