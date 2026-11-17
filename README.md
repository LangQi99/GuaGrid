# GuaGrid v1 · 卦阵

卦阵在本机调度八个独立的 Codex 会话。乾、坤、震、巽、坎、离、艮、兑各有自己的角色、Skill 和 MCP 配置，可以并行做事，也能查到彼此的进度和成果。

## 启动

准备 Node.js 22 或更新版本、Git，以及已登录的 Codex CLI。启动时把 `--workspace` 指向要工作的 Git 仓库。卦阵从它已经提交的 `HEAD` 创建独立工作目录。

```sh
codex login status
npm start -- --workspace /path/to/your/repo
```

打开 [本地工作台](http://127.0.0.1:8788/)。默认将同一份任务同时交给震和兑，震先试跑，兑梳理需求。也可以选择自动分派或指定一个卦，再按行提交多项任务。点八卦图上的任一卦，可以读当前任务和结果、继续发消息或中断回合。

## 卦的配置

`profiles` 目录下每一卦都有一份 `AGENTS.md`、`SKILL.md` 和 `mcp.json`。卦阵把角色说明和预置 Skill 传给独立会话，Codex 也会加载任务工作目录的项目指令。

每卦都启用本机 `guagrid` MCP 的 `get_grid_status`。传入 `agent` 可以查单个卦，省略时返回八卦状态。乾、坤、艮、兑还预置了 `get_task_result`，可以按任务 ID 取回交付。网页上的查询记录来自实际的 MCP 调用。

八卦也可以用 `tongqi` 向另一卦发消息。应方从自己的会话 fork 预分析，再回复是否接受。接受的通气会把原文和预分析一起写回应方会话。工作台的信息流会显示「感」「应」和写回结果。

各卦的 `mcp.json` 中，`tools` 是内置工具清单，`servers` 可以提供额外的 Codex MCP 服务器配置。巽和离分别附了 Context7 和 Playwright 的启用示例。

## 工作结果

每项任务用一个独立的 Git worktree，分支名为 `guagrid/<任务ID>`。工作台会显示分支，鼠标移到分支名可以看完整路径。任务结束后，文件和分支留在工作目录，供你检查和合并。

服务绑定本机回环地址。任务记录写入 `~/.guagrid/<工作仓库标识>/state.json`，可以通过 `--state-dir` 指定位置。重启时，在途任务会标记为中断；已有 Codex 会话可以从对应的卦继续发消息。可用 `--port` 改端口，`--codex` 指定 Codex CLI 路径。

```sh
npm test
```

测试用临时 Git 仓库和本地 Codex 接口替身覆盖并行派发、互查状态和队列继续运行。
