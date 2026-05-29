# cyber_PM

这是 Codex PM 工作区的最小闭环实现。它不直接调用模型 API，也不写用户 home 配置，只通过员工 repo 暴露的 JSON Bridge 协调多个持久化员工。

项目目标已经调整为：

- 部署哪些员工，由用户手动选择和维护。
- PM 只调度已经部署、已启用、可发现的员工。
- PM 接到用户任务后，目标态应自动完成任务建包、员工选择、派发和触发。
- 员工仍是持久化 repo 个体，拥有自己的身份、模型 profile、skills、inbox/outbox、state、logs。
- 后台 watcher/daemon 不是默认目标；自动触发应先通过明确的 PM 命令实现，便于观察和调试。

## 1. 工作模式

推荐目录关系：

```text
codex/
  cyber_PM/
  cyber_employee/
```

`cyber_PM` 是 PM 工作区。`cyber_employee` 是员工母体模板。你手动决定要部署哪些员工，并把员工 clone 放在 `cyber_PM/employees/` 下；这些 clone 不进入 PM 仓库提交。

PM 后续只在这些已部署员工中调度，不负责自动创建无限员工池。

## 2. 初始化

在 `cyber_PM` 内运行：

```bash
npm run doctor
npm run validate
npm run setup:demo
npm run discover
```

预期结果：

- `doctor` 和 `validate` 通过。
- `setup:demo` 创建 `employees/senior-demo` 与 `employees/junior-demo`。
- `discover` 在 `state/employees.json` 生成员工索引。

## 3. 派发任务

复制示例任务为本地草稿：

```bash
cp tasks/drafts/task-0001.example.json tasks/drafts/task-0001.json
```

提交给 junior 员工：

```bash
npm run submit -- --file tasks/drafts/task-0001.json --employee junior-demo
```

脚本会把任务写入：

```text
employees/junior-demo/inbox/tasks/task-0001.json
```

当前 `submit` 命令会打印显式唤醒命令。新的目标态是：PM 接到用户任务后，通过后续的 intake/dispatch 命令自动选择员工、派发任务并触发对应员工运行。

## 4. 自动接收并调度任务

PM 自动调度入口：

```bash
npm run intake -- --file tasks/drafts/<task_id>.json
```

该命令会：

- 读取 `employee-task.v1` JSON 草稿。
- 在已部署、已启用、可发现的员工中自动选择合适员工。
- 写入员工 `inbox/tasks/<task_id>.json`。
- 写入 PM `tasks/submitted/` 记录。
- 刷新 `state/task-ledger.json`。
- 默认以非交互 `auto-run` 模式启动员工 Claude Code，并传入任务执行提示。
- 员工退出后自动执行 `collect` 和 `reconcile`。

常用选项：

```bash
npm run intake -- --file tasks/drafts/<task_id>.json --dry-run
npm run intake -- --file tasks/drafts/<task_id>.json --no-launch
npm run intake -- --file tasks/drafts/<task_id>.json --employee junior-demo
npm run intake -- --file tasks/drafts/<task_id>.json --force
npm run intake -- --file tasks/drafts/<task_id>.json --interactive
npm run intake -- --file tasks/drafts/<task_id>.json --background
```

默认模式会让员工一次性执行任务并自动退出；`--interactive` 仅用于调试，会回到需要人工接管和手动退出的 Claude Code 会话。
`--background` 会后台启动员工，命令立即返回，适合多个员工并行。

已验证结果：

- `task-0008` 已验证默认 `intake` 会以 `auto-run` 启动 `junior-demo`。
- 执行过程中不需要用户手动确认 Claude Code 权限。
- 员工完成后 Claude Code 自动退出，PM 自动继续 `collect` 和 `reconcile`。
- 收集后任务进入 `pm_status=review-pending`，等待 PM 验收决策。

自动选择规则：

- 只选择 `enabled=true` 且 `discovered=true` 的员工。
- 员工必须支持任务 `task_type`。
- 如果任务有 `assignee_level`，员工 `level` 必须精确匹配。
- 员工当前 `state/status.json` 必须是 `idle`。
- 员工不能已有 active run；active run 包括 `starting` 和 `running`。
- 多个候选并列时，按 `config/employees.json` 注册顺序选择。

## 5. 查看状态

```bash
npm run status
```

该命令默认只读，不刷新 `state/employees.json`。它会读取每个员工的 `state/status.json`，输出员工当前状态、活跃任务和模型 profile。

如需同时刷新员工索引：

```bash
npm run status -- --refresh
```

## 6. 查看任务台账

```bash
npm run tasks
```

该命令优先读取 `state/task-ledger.json`。如果账本还不存在，会临时 live 计算草稿、派工记录、员工 inbox/outbox 和 PM 结果索引。

## 7. 查看后台运行

```bash
npm run runs
npm run runs -- --employee junior-demo
npm run runs -- --status running
npm run runs -- --json
```

`runs` 会聚合 `state/runs/*.json` 到 `state/runs.json`，用于查看后台 run 的 `run_id`、员工、任务、状态、PID、退出码和日志路径。

后台运行日志位于：

```text
logs/runs/<run_id>.log
```

刷新 PM 账本：

```bash
npm run reconcile
```

输出机器可读任务视图：

```bash
npm run tasks -- --json
```

任务生命周期：

- `draft`：只有草稿，未提交。
- `submitted`：已经派工，但还没有收集结果。
- `missing-inbox`：PM 有派工记录，但员工 inbox 任务文件缺失。
- `result-uncollected`：员工 outbox 已有结果，但 PM 还没有 collect。
- `completed`：PM 已收集结果，且结果状态为 `completed`。
- `failed`：PM 已收集结果，且结果状态为 `failed` 或 `blocked`。

PM 验收状态：

- `review-pending`：员工已有结果，等待 PM 验收。
- `accepted`：PM 已验收通过。
- `needs-rework`：PM 自动复核或人工复核后要求返工；自动复核会生成返工草稿。
- `blocked`：PM 标记阻塞。
- `canceled`：PM 取消该任务。

## 8. PM 验收决策

员工结果 `completed` 不等于 PM 验收通过。收集结果后，按以下流程处理：

```bash
npm run collect
npm run reconcile
npm run tasks
npm run resolve -- --task task-0001 --employee junior-demo --decision accepted --note "验收通过"
```

支持的 `decision`：

```text
accepted
needs-rework
blocked
canceled
```

PM 决策会写入 `state/task-ledger.json`，并追加 `logs/pm-events.jsonl`。两者都是运行态文件，不提交。

如果结果中存在 `verification[].passed=false`，`reconcile` 会自动把任务标记为 `needs-rework`，并在 `tasks/drafts/` 生成返工任务草稿。返工草稿不会自动派发，仍需通过 `intake` 进入下一轮。

## 9. 收集结果

员工通过 Claude Code 执行任务后，运行：

```bash
npm run collect
```

PM 会复制员工的结果到：

```text
results/collected/<employee_id>/<task_id>.json
results/collected/<employee_id>/<task_id>.md
```

`state/collections.json` 会记录已收集结果和 hash。再次运行 `collect` 时，相同结果不会重复归档；如果员工源结果发生变化，PM 会覆盖归档副本并更新索引。

## 10. 查看结果汇总

```bash
npm run results
```

常用过滤：

```bash
npm run results -- --employee junior-demo
npm run results -- --status completed
npm run results -- --json
```

`results` 默认只读，适合 PM 快速查看已归档结果、模型和结果路径。默认表格不展示 `summary`；需要完整摘要时使用 `--json`。

## 11. 日常 PM 顺序

推荐主流程：

```bash
npm run discover
npm run intake -- --file tasks/drafts/<task_id>.json
npm run tasks
npm run results
npm run resolve -- --task <task_id> --employee <employee_alias> --decision accepted --note "验收通过"
```

多个员工并行时：

```bash
npm run intake -- --file tasks/drafts/<junior_task_id>.json --background
npm run intake -- --file tasks/drafts/<senior_task_id>.json --background
npm run runs
npm run tasks
npm run results
```

后台 worker 会在员工退出后自动运行 `collect` 和 `reconcile`。每个员工默认只能有 1 个 active run。

调试时也可以拆开执行：

```bash
npm run discover
npm run submit -- --file tasks/drafts/<task_id>.json --employee <employee_alias>
npm run status
npm run tasks
npm run collect
npm run results
npm run reconcile
npm run tasks
npm run resolve -- --task <task_id> --employee <employee_alias> --decision accepted --note "验收通过"
```

其中 `discover`、`intake`、`submit`、`collect`、`reconcile`、`resolve`、`runs` 会写运行态。`status`、`tasks`、`results` 默认只读。

`intake --dry-run` 不写运行态；`intake --no-launch` 只派发和刷新账本，不启动员工。

`intake` 默认使用 employee 的 `--auto-run` 非交互模式；如需观察员工过程或手动调试，使用 `--interactive`。

`intake --background --timeout-minutes <n>` 可设置后台 run 超时；默认 60 分钟，`0` 表示不设置超时。

## 12. Git 约定

PM 仓库只提交框架、脚本、示例和文档。以下内容是运行时文件，不提交：

- `employees/*`
- `tasks/drafts/*.json`
- `tasks/submitted/*`
- `results/collected/*`
- `state/*`
- `logs/*`
- `.env`

## 13. 验收命令

```bash
npm run doctor
npm run validate
npm run setup:demo
npm run discover
cp tasks/drafts/task-0001.example.json tasks/drafts/task-0001.json
npm run intake -- --file tasks/drafts/task-0001.json --dry-run
npm run intake -- --file tasks/drafts/task-0001.json --dry-run --background
npm run intake -- --file tasks/drafts/task-0001.json --no-launch
npm run status
npm run tasks
```

员工自动触发执行完成后：

```bash
npm run intake -- --file tasks/drafts/<task_id>.json
npm run runs
npm run results
npm run resolve -- --task <task_id> --employee <employee_alias> --decision accepted --note "验收通过"
npm run tasks
npm run validate
```

Iter4.1 已用 `task-0008` 验证默认非交互链路。后续并行员工调度应在此基础上增加后台运行索引、并发上限、运行中状态与超时处理。
