# cyber_PM

这是 Codex PM 工作区的最小闭环实现。它不直接调用模型 API，也不启动后台 daemon，只通过员工 repo 暴露的 JSON Bridge 完成发现员工、派发任务、读取状态和收集结果。

## 1. 工作模式

推荐目录关系：

```text
codex/
  cyber_PM/
  cyber_employee/
```

`cyber_PM` 是 PM 工作区。`cyber_employee` 是员工母体模板。PM 会把员工 clone 放在 `cyber_PM/employees/` 下，但这些 clone 不进入 PM 仓库提交。

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

同时会打印显式唤醒命令。PM v1 不自动启动 Claude Code。

## 4. 查看状态

```bash
npm run status
```

该命令默认只读，不刷新 `state/employees.json`。它会读取每个员工的 `state/status.json`，输出员工当前状态、活跃任务和模型 profile。

如需同时刷新员工索引：

```bash
npm run status -- --refresh
```

## 5. 查看任务台账

```bash
npm run tasks
```

该命令汇总草稿、派工记录、员工 inbox/outbox 和 PM 结果索引，输出任务生命周期：

- `draft`：只有草稿，未提交。
- `submitted`：已经派工，但还没有收集结果。
- `missing-inbox`：PM 有派工记录，但员工 inbox 任务文件缺失。
- `result-uncollected`：员工 outbox 已有结果，但 PM 还没有 collect。
- `completed`：PM 已收集结果，且结果状态为 `completed`。
- `failed`：PM 已收集结果，且结果状态为 `failed` 或 `blocked`。

## 6. 收集结果

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

## 7. 查看结果汇总

```bash
npm run results
```

常用过滤：

```bash
npm run results -- --employee junior-demo
npm run results -- --status completed
npm run results -- --json
```

`results` 默认只读，适合 PM 快速查看已归档结果、模型、摘要和结果路径。

## 8. 日常 PM 顺序

推荐日常操作顺序：

```bash
npm run discover
npm run submit -- --file tasks/drafts/<task_id>.json --employee <employee_alias>
npm run status
npm run tasks
npm run collect
npm run results
npm run tasks
```

其中只有 `discover`、`submit`、`collect` 会写运行态。`status`、`tasks`、`results` 默认只读。

## 9. Git 约定

PM 仓库只提交框架、脚本、示例和文档。以下内容是运行时文件，不提交：

- `employees/*`
- `tasks/drafts/*.json`
- `tasks/submitted/*`
- `results/collected/*`
- `state/*`
- `logs/*`
- `.env`

## 10. 验收命令

```bash
npm run doctor
npm run validate
npm run setup:demo
npm run discover
cp tasks/drafts/task-0001.example.json tasks/drafts/task-0001.json
npm run submit -- --file tasks/drafts/task-0001.json --employee junior-demo
npm run status
npm run tasks
```

员工执行完成后：

```bash
npm run collect
npm run results
npm run tasks
npm run validate
```
