# PM Plan 示例

这个文件展示 Codex PM 如何把一次用户自然语言需求落成项目级计划。Codex 自带 `/plan` 用于会话内思考和对齐；`plans/<plan_id>.json` 是持久化记录，用于重启后继续推进。

## Goal

示例：让 Codex PM 拆解一个用户自然语言需求，并协调多个 employee 完成。

## Strategy

- 开放、复杂、需要判断的任务交给 senior。
- 边界清晰、验收标准明确的任务交给 junior。
- 无依赖任务可以并行派发；有依赖任务按 `depends_on` 顺序推进。
- 每次 `runs/tasks/results/resolve` 后，PM 应同步更新 plan 中对应任务的 `pm_status`、`result_path` 和最终汇总。

## Tasks

| task_id | title | employee | status |
| --- | --- | --- | --- |
| task-plan-example-senior | 示例 senior 调研任务 | senior-demo | draft |
| task-plan-example-junior | 示例 junior 执行任务 | junior-demo | draft |

## Final Summary

未完成时保持为空；完成后由 Codex PM 写入面向用户的最终汇总。
