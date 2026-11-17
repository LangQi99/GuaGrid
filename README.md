# GuaGrid v1 · 卦阵

卦阵在本机调度八个独立的 Codex 会话。乾、坤、震、巽、坎、离、艮、兑各有自己的角色、Skill 和 MCP 配置，可以并行做事，也能查到彼此的进度和成果。

## 启动

准备 Node.js 22 或更新版本、Git，以及已登录的 Codex CLI。启动时把 `--workspace` 指向要工作的 Git 仓库。卦阵从它已经提交的 `HEAD` 创建独立工作目录。

```sh
codex login status
npm start -- --workspace /path/to/your/repo
```

打开 [本地工作台](http://127.0.0.1:8788/)。默认用「八卦协作」完成一项任务。震与兑先并行试跑、梳理需求，乾、巽、坎、离并行整理方案和检查，坤在协作分支上实现，艮独立验收。艮指出具体缺陷时，坤返工一次，再由艮复验。也可以单独运行 Step 1、自动分派或指定一卦。

## 卦的配置

`profiles` 目录下每一卦都有一份 `AGENTS.md`、`SKILL.md` 和 `mcp.json`。卦阵把角色说明和预置 Skill 传给独立会话，Codex 也会加载任务工作目录的项目指令。

每卦都启用本机 `guagrid` MCP 的 `get_grid_status`。传入 `agent` 可以查单个卦，省略时返回八卦职责和状态。八卦协作中，每卦都能用 `get_task_result` 按任务 ID 查看同组交付。

八卦协作中，`tongqi` 可以找同组任意其他卦，尚未开工的卦也能回复。应方从自己的会话 fork 预分析，回「应」时给出是否接受。接受的通气会把原文和预分析一起写回应方主会话。信息流会显示「感」「应」和写回结果。

各卦的 `mcp.json` 中，`tools` 是内置工具清单，`servers` 可以提供额外的 Codex MCP 服务器配置。巽和离分别附了 Context7 和 Playwright 的启用示例。

## 工作结果

每次八卦协作共用一个 Git worktree，分支名为 `guagrid/<协作ID>`。震和坤在各自阶段修改，其他卦在同一目录只读核对。协作交付后，工作台显示分支、实现结果和验收证据。单独派发的任务各用自己的 worktree，分支和文件都可以在本机检查及合并。

服务绑定本机回环地址。任务记录写入 `~/.guagrid/<工作仓库标识>/state.json`，可以通过 `--state-dir` 指定位置。重启时，在途任务会标记为中断；已有 Codex 会话可以从对应的卦继续发消息。可用 `--port` 改端口，`--codex` 指定 Codex CLI 路径。

```sh
npm test
```

测试用临时 Git 仓库和本地 Codex 接口替身覆盖并行派发、互查状态和队列继续运行。
