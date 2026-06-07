#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureDir,
  isSafeRelativePath,
  nowIso,
  parseArgs,
  pathExists,
  printTable,
  readJson,
  relativeFrom,
  safeFileName,
  writeJson
} from './lib/project.mjs';
import {
  PROTOCOL_VERSIONS,
  validateTaskPackage
} from './lib/protocol.mjs';
import {
  reconcileLedger,
  readLedger,
  writeLedger
} from './lib/ledger.mjs';

const root = process.cwd();
const args = parseArgs();

const TERMINAL_STATUSES = ['accepted', 'blocked', 'canceled'];
const NON_DISPATCH_STATUSES = ['submitted', 'review-pending', 'needs-rework', ...TERMINAL_STATUSES];
const DEFAULT_ACCEPTANCE = [
  '员工必须写出标准 result JSON，并在 verification 中逐条覆盖本任务 acceptance，且每项显式包含 passed:true 或 passed:false。',
  '员工必须写出 Markdown companion 报告，包含 Result、Verification、Notes。',
  '员工必须通过本员工仓库 npm run validate。'
];

function usage() {
  console.error([
    'usage:',
    '  npm run plan -- --file plans/<plan_id>.json --status',
    '  npm run plan -- --file plans/<plan_id>.json --advance [--apply] [--dispatch] [--no-launch]'
  ].join('\n'));
  process.exit(1);
}

function requirePlanFile() {
  if (!args.file || args.file === true) usage();
  const planPath = path.resolve(root, String(args.file));
  if (!pathExists(planPath)) throw new Error(`plan file not found: ${args.file}`);
  if (!isSafeRelativePath(relativeFrom(root, planPath))) {
    throw new Error(`plan file must be under project root: ${args.file}`);
  }
  return planPath;
}

function requireFields(object, fields, label, errors) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const field of fields) {
    if (!(field in object)) errors.push(`${label} missing required field: ${field}`);
  }
}

function validatePlan(plan, label) {
  const errors = [];
  requireFields(plan, [
    'schema_version',
    'plan_id',
    'created_at',
    'updated_at',
    'goal',
    'status',
    'strategy',
    'tasks',
    'final_summary'
  ], label, errors);
  if (plan?.schema_version !== 'pm-plan.v1') errors.push(`${label} schema_version must be pm-plan.v1`);
  if (plan?.strategy && (typeof plan.strategy !== 'object' || Array.isArray(plan.strategy))) {
    errors.push(`${label} strategy must be an object`);
  }
  if (!Array.isArray(plan?.tasks)) {
    errors.push(`${label} tasks must be an array`);
  } else {
    const ids = new Set();
    for (const [index, task] of plan.tasks.entries()) {
      const taskLabel = `${label} tasks[${index}]`;
      requireFields(task, [
        'task_id',
        'title',
        'task_type',
        'assignee_level',
        'employee_hint',
        'depends_on',
        'draft_path',
        'result_path',
        'pm_status'
      ], taskLabel, errors);
      if (task.task_id) {
        if (ids.has(task.task_id)) errors.push(`${taskLabel} duplicate task_id: ${task.task_id}`);
        ids.add(task.task_id);
      }
      if (task.depends_on && !Array.isArray(task.depends_on)) errors.push(`${taskLabel}.depends_on must be an array`);
      if (task.acceptance && !Array.isArray(task.acceptance)) errors.push(`${taskLabel}.acceptance must be an array`);
      if (task.allowed_paths && !Array.isArray(task.allowed_paths)) errors.push(`${taskLabel}.allowed_paths must be an array`);
      for (const field of ['draft_path', 'result_path']) {
        if (task[field] && !isSafeRelativePath(task[field])) errors.push(`${taskLabel}.${field} must be project-relative`);
      }
    }
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
}

function loadPlan(planPath) {
  const plan = readJson(planPath);
  validatePlan(plan, relativeFrom(root, planPath));
  return plan;
}

function defaultDraftPath(task) {
  return `tasks/drafts/${safeFileName(task.task_id)}.json`;
}

function defaultBody(plan, task) {
  return [
    `# ${task.title}`,
    '',
    '## Plan Goal',
    plan.goal,
    '',
    '## Task',
    task.title
  ].join('\n');
}

function defaultAllowedPaths(task) {
  return [
    `inbox/tasks/${task.task_id}.json`,
    'workspace/**',
    'outbox/**',
    'state/status.json',
    'logs/events.jsonl'
  ];
}

function buildTaskPackage(plan, planTask) {
  const task = {
    schema_version: PROTOCOL_VERSIONS.task,
    task_id: planTask.task_id,
    created_at: nowIso(),
    priority: planTask.priority || 'normal',
    task_type: planTask.task_type,
    assignee_level: planTask.assignee_level,
    model_hint: planTask.model_hint || '',
    input: {
      title: planTask.title,
      body_md: planTask.body_md || defaultBody(plan, planTask),
      attachments: Array.isArray(planTask.attachments) ? planTask.attachments : []
    },
    acceptance: Array.isArray(planTask.acceptance) && planTask.acceptance.length > 0
      ? planTask.acceptance
      : DEFAULT_ACCEPTANCE,
    constraints: {
      allowed_paths: Array.isArray(planTask.allowed_paths) && planTask.allowed_paths.length > 0
        ? planTask.allowed_paths
        : defaultAllowedPaths(planTask),
      deadline_at: planTask.deadline_at || null
    },
    pm_context: {
      kind: 'plan_task',
      plan_id: plan.plan_id,
      depends_on: planTask.depends_on || []
    }
  };
  const errors = [];
  validateTaskPackage(task, planTask.draft_path || defaultDraftPath(planTask), errors);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return task;
}

function ledgerRows() {
  const ledger = pathExists(path.join(root, 'state/task-ledger.json'))
    ? readLedger(root)
    : { tasks: [] };
  return ledger.tasks || [];
}

function findLedgerRow(rows, planTask) {
  const matches = rows.filter((row) => row.task_id === planTask.task_id);
  if (matches.length === 0) return null;
  const hint = planTask.employee_hint || '';
  if (hint) {
    const hinted = matches.filter((row) => row.employee_alias === hint || row.employee_id === hint);
    if (hinted.length === 1) return hinted[0];
    if (hinted.length > 1) throw new Error(`ambiguous ledger rows for ${planTask.task_id} and employee_hint ${hint}`);
    const draftOnly = matches.filter((row) => !row.employee_id && !row.employee_alias);
    if (draftOnly.length === 1) return draftOnly[0];
    return null;
  }
  if (matches.length === 1) return matches[0];
  const draftOnly = matches.filter((row) => !row.employee_id && !row.employee_alias);
  if (draftOnly.length === 1) return draftOnly[0];
  throw new Error(`ambiguous ledger rows for ${planTask.task_id}; set employee_hint to disambiguate`);
}

function indexPlanTasks(plan) {
  return new Map(plan.tasks.map((task) => [task.task_id, task]));
}

function currentStatus(planTask, row) {
  return row?.pm_status || planTask.pm_status || 'draft';
}

function dependencyErrors(plan) {
  const byId = indexPlanTasks(plan);
  const errors = [];
  for (const task of plan.tasks) {
    for (const dep of task.depends_on || []) {
      if (!byId.has(dep)) errors.push(`${task.task_id} depends_on missing task: ${dep}`);
    }
  }
  return errors;
}

function dependenciesAccepted(plan, taskId, statusByTask) {
  const task = indexPlanTasks(plan).get(taskId);
  return (task.depends_on || []).every((dep) => statusByTask.get(dep) === 'accepted');
}

function derivePlanStatus(tasks) {
  const statuses = tasks.map((task) => task.pm_status || 'draft');
  if (statuses.length > 0 && statuses.every((status) => status === 'accepted')) return 'completed';
  if (statuses.includes('needs-rework')) return 'needs-rework';
  if (statuses.includes('review-pending')) return 'reviewing';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('canceled')) return 'canceled';
  if (statuses.some((status) => ['submitted', 'running'].includes(status))) return 'running';
  if (statuses.some((status) => status === 'draft')) return 'draft';
  return 'draft';
}

function finalSummary(plan) {
  const lines = [
    `Plan ${plan.plan_id} completed.`,
    '',
    'Tasks:'
  ];
  for (const task of plan.tasks) {
    lines.push(`- ${task.task_id}: ${task.title} | employee=${task.employee_hint || '(auto)'} | result=${task.result_path || '(none)'}`);
  }
  return lines.join('\n');
}

function analyzePlan(plan, rows) {
  const depErrors = dependencyErrors(plan);
  if (depErrors.length > 0) throw new Error(depErrors.join('\n'));

  const rowByTask = new Map();
  const statusByTask = new Map();
  const projectedTasks = plan.tasks.map((task) => {
    const row = findLedgerRow(rows, task);
    rowByTask.set(task.task_id, row);
    const draftPath = task.draft_path || defaultDraftPath(task);
    const projected = {
      ...task,
      draft_path: draftPath,
      result_path: row?.result_path || task.result_path || '',
      pm_status: currentStatus(task, row),
      employee_hint: row?.employee_alias || row?.employee_id || task.employee_hint || ''
    };
    statusByTask.set(task.task_id, projected.pm_status || 'draft');
    return projected;
  });

  const createDrafts = [];
  const readyTasks = [];
  for (const task of projectedTasks) {
    const status = task.pm_status || 'draft';
    if (NON_DISPATCH_STATUSES.includes(status)) continue;
    if (!dependenciesAccepted({ ...plan, tasks: projectedTasks }, task.task_id, statusByTask)) continue;
    if (!pathExists(path.join(root, task.draft_path))) createDrafts.push(task);
    readyTasks.push(task);
  }

  const status = derivePlanStatus(projectedTasks);
  return {
    projectedPlan: {
      ...plan,
      updated_at: nowIso(),
      status,
      tasks: projectedTasks,
      final_summary: status === 'completed' ? finalSummary({ ...plan, tasks: projectedTasks }) : plan.final_summary
    },
    createDrafts,
    readyTasks,
    rowByTask
  };
}

function intakeCommand(task, options = {}) {
  const command = ['npm', 'run', 'intake', '--', '--file', task.draft_path];
  if (task.employee_hint) command.push('--employee', task.employee_hint);
  if (options.noLaunch) {
    command.push('--no-launch');
  } else {
    command.push('--background');
  }
  return command;
}

function printStatus(plan, analysis) {
  console.log(`plan: ${plan.plan_id}`);
  console.log(`status: ${analysis.projectedPlan.status}`);
  console.log(`goal: ${plan.goal}`);
  printTable(analysis.projectedPlan.tasks.map((task) => ({
    task_id: task.task_id,
    title: task.title,
    depends_on: (task.depends_on || []).join(','),
    employee: task.employee_hint,
    draft_path: task.draft_path,
    result_path: task.result_path,
    pm_status: task.pm_status
  })), [
    { key: 'task_id', header: 'task_id' },
    { key: 'title', header: 'title' },
    { key: 'depends_on', header: 'depends_on' },
    { key: 'employee', header: 'employee' },
    { key: 'draft_path', header: 'draft_path' },
    { key: 'result_path', header: 'result_path' },
    { key: 'pm_status', header: 'pm_status' }
  ]);
}

function printAdvance(analysis, options = {}) {
  console.log(`mode: ${options.apply ? 'apply' : 'dry-run'}${options.dispatch ? ' + dispatch' : ''}${options.noLaunch ? ' + no-launch' : ''}`);
  if (analysis.createDrafts.length === 0) {
    console.log('drafts to create: (none)');
  } else {
    console.log('drafts to create:');
    for (const task of analysis.createDrafts) console.log(`- ${task.draft_path}`);
  }

  if (analysis.readyTasks.length === 0) {
    console.log('ready tasks: (none)');
  } else {
    console.log('ready tasks:');
    for (const task of analysis.readyTasks) {
      console.log(`- ${task.task_id} ${task.title}`);
      console.log(`  ${intakeCommand(task, { noLaunch: options.noLaunch }).join(' ')}`);
    }
  }
}

function writeDrafts(plan, tasks) {
  const written = [];
  for (const task of tasks) {
    const draftPath = path.join(root, task.draft_path);
    if (pathExists(draftPath)) continue;
    const original = plan.tasks.find((item) => item.task_id === task.task_id);
    const draft = buildTaskPackage(plan, { ...original, draft_path: task.draft_path });
    ensureDir(path.dirname(draftPath));
    writeJson(draftPath, draft);
    written.push(task.draft_path);
  }
  return written;
}

function runDispatch(tasks, options = {}) {
  for (const task of tasks) {
    const command = intakeCommand(task, { noLaunch: options.noLaunch });
    const result = spawnSync(command[0], command.slice(1), {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    if (result.status !== 0) {
      throw new Error(`${command.join(' ')} failed with status ${result.status}`);
    }
  }
}

function refreshLedgerIfApply(apply) {
  if (!apply) return ledgerRows();
  const ledger = reconcileLedger(root);
  writeLedger(root, ledger);
  return ledger.tasks || [];
}

try {
  if (!args.status && !args.advance) usage();
  if (args.dispatch && !args.apply) throw new Error('--dispatch requires --apply');
  if (args['no-launch'] && !args.dispatch) throw new Error('--no-launch requires --dispatch');

  const planPath = requirePlanFile();
  const plan = loadPlan(planPath);
  let rows = refreshLedgerIfApply(Boolean(args.apply));
  let analysis = analyzePlan(plan, rows);

  if (args.status) printStatus(plan, analysis);
  if (args.advance) printAdvance(analysis, {
    apply: Boolean(args.apply),
    dispatch: Boolean(args.dispatch),
    noLaunch: Boolean(args['no-launch'])
  });

  if (args.advance && args.apply) {
    const writtenDrafts = writeDrafts(plan, analysis.createDrafts);
    if (writtenDrafts.length > 0) console.log(`created draft(s): ${writtenDrafts.join(', ')}`);
    rows = refreshLedgerIfApply(true);
    analysis = analyzePlan(plan, rows);
    writeJson(planPath, analysis.projectedPlan);
    console.log(`updated plan: ${relativeFrom(root, planPath)}`);

    if (args.dispatch && analysis.readyTasks.length > 0) {
      runDispatch(analysis.readyTasks, { noLaunch: Boolean(args['no-launch']) });
      rows = refreshLedgerIfApply(true);
      const dispatchedPlan = loadPlan(planPath);
      analysis = analyzePlan(dispatchedPlan, rows);
      writeJson(planPath, analysis.projectedPlan);
      console.log(`updated plan after dispatch: ${relativeFrom(root, planPath)}`);
    }
  }
} catch (error) {
  console.error(`error - ${error.message}`);
  process.exit(1);
}
