# 主管与副主管（Dictator & Lieutenants）

一个 DeepSeek Harness 多 agent 协同插件，参考 Git 分布式工作流中的
[Dictator and Lieutenants](https://git-scm.com/book/en/v2/Distributed-Git-Distributed-Workflows)
模型：主管负责总目标与最终集成，副主管负责一个子系统，贡献者执行自包含任务。

## 全局安装（DSH 用户级）

本插件按 DSH 的**用户级 profile** 安装，不是 npm 的 `-g` 全局包。安装一次后，
当前用户下使用同一 profile 的所有项目和会话都可直接调用，无需在每个项目里重复安装。

从 GitHub 安装：

```text
plugin_manager action=install_bundle target=github:minghai678/dsh-dictator-lieutenants
```

也可以使用完整仓库地址：

```text
plugin_manager action=install_bundle target=https://github.com/minghai678/dsh-dictator-lieutenants
```

`plugin_manager` 会把插件链接到当前 profile 的 `node_modules`，并在该 profile 的
bundle 列表中启用。首次安装后无需重启当前页面；插件会在 Host 侧注册三个工具。
用 `dictator action=doctor` 可以检查 `spawn` provider 和工具是否可用。

> DSH 的插件作用域是 profile。若同时使用多个 profile（例如 `desktop`、`web`），
> 需要在目标 profile 中各安装一次；它不是 npm `-g` 的全局安装。
>
> 如果实际仓库名或 GitHub 用户名不同，请替换 `minghai678/dsh-dictator-lieutenants`。

## 工具

### `dictator`

主管工具，按 `action` 操作：

| action | 作用 |
| --- | --- |
| `start` | 用 `mission` + 1-8 个 `workstreams` 启动工作流，每个子系统一个副主管 |
| `status` | 查看副主管、贡献者、合并请求和错误 |
| `await` | 等待副主管完成，返回状态和合并请求 |
| `steer` | 给指定副主管追加指令 |
| `stop` | 停止全部或指定副主管及其贡献者 |
| `finalize` | 生成最终集成报告，可选写入 `.dsh/dictator-workflows/<id>.md` |
| `doctor` | 检查 provider 和活动工作流 |

`start` 的关键参数：

```json
{
  "action": "start",
  "mission": "实现 X 功能，保持现有测试通过",
  "cwd": "D:\\path\\to\\repo",
  "workstreams": [
    {
      "name": "核心实现",
      "scope": "src/core、相关测试",
      "deliverables": "实现接口并补充单元测试",
      "brief": "不要改动公开 API"
    },
    {
      "name": "文档与示例",
      "scope": "docs/、examples/",
      "deliverables": "更新用法说明和可运行示例"
    }
  ]
}
```

### `lieutenant_delegate`

副主管专用。把子系统拆成 1-6 个贡献者任务并等待结果：

```json
{
  "action": "spawn",
  "tasks": [
    {
      "title": "实现解析器",
      "brief": "只修改 src/core/parser.js，补测试；验收：npm test -- parser 通过",
      "deliverables": "代码、测试和验证输出"
    }
  ]
}
```

如果调用超时，贡献者不会被终止；用 `action=collect` + `task_ids` 继续等待。

### `lieutenant_report`

副主管完成集成后提交结构化合并请求：

```json
{
  "status": "ready",
  "summary": "完成解析器与测试，接口未变",
  "changes": [{ "path": "src/core/parser.js", "description": "新增 parser" }],
  "verification": [{ "command": "npm test -- parser", "result": "12 passed" }],
  "risks": "未覆盖超长输入"
}
```

## 工作流

```text
主管（Dictator）
  ├─ 副主管 A（Lieutenant） ─ 贡献者 A1 / A2 / A3
  ├─ 副主管 B（Lieutenant） ─ 贡献者 B1 / B2
  └─ 副主管 C（Lieutenant） ─ 贡献者 C1
```

1. 主管调用 `dictator action=start`，把总使命拆成互不重叠的子系统。
2. 每个副主管只负责自己的范围，用 `lieutenant_delegate` 拆任务、等待贡献者。
3. 副主管审查贡献者产出、集成、运行验证，再用 `lieutenant_report` 提交合并请求。
4. 主管用 `dictator action=await` 收集交付，审查 `ready/blocked`，用 `finalize` 产出报告。

层级固定为三层：主管 → 副主管 → 贡献者。贡献者不能再委派；副主管也不能再创建副主管。
插件会读取主管当前的 subagent 深度，并把本次工作流的 `maxDepth` 设为“主管深度 + 2”，
因此主管本身是子 agent 时，仍能完整创建副主管和贡献者（只要 provider 允许）。

## 设计边界

- **逻辑分支，不是真实 Git 分支**：插件不自动创建 worktree、branch 或 cherry-pick。
  `branch` 只是合并请求里的逻辑标识；实际 Git 操作由 agent 按项目规范执行。
- **内存状态**：工作流状态保存在 Host 插件进程内；DSH 重启或插件热重载会丢失状态。
  正在运行的子 agent 会被插件的卸载清理逻辑中止。
- **只有主管能定稿**：`start/steer/stop/finalize` 校验调用者身份；副主管和贡献者只能查看。
- **provider 要求**：默认 `spawn` provider；它支持 `depthLimit`、独立上下文和完成结果。
  如果改用其他 provider，必须能从主管深度继续向下两层。
- **输出有界**：单个贡献者结果截断到约 12k 字符，工具输出截断到约 48k 字符；
  详细内容应写入文件和合并请求，不要依赖聊天记录传递大段代码。

## English

A DeepSeek Harness plugin implementing Git's **Dictator and Lieutenants** workflow:

- `dictator` starts a mission with 1-8 workstreams, spawns one lieutenant per
  workstream, awaits/steers/stops them, and finalizes a report.
- `lieutenant_delegate` lets a lieutenant split its subsystem into contributor
  tasks and wait for their results.
- `lieutenant_report` records a structured merge request (`ready` or `blocked`).

The hierarchy is three levels deep: dictator → lieutenant → contributor. The plugin
sets the workflow's absolute `maxDepth` to the dictator's current subagent depth + 2,
so a dictator that is itself a subagent can still create both lower tiers when the
provider allows it. Contributors cannot delegate further. Branches are logical
metadata only; the plugin does not create Git branches or worktrees. Workflow state
is in-memory and is lost on Host restart or plugin reload.

## License

MIT
