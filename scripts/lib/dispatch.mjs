import path from 'node:path';
import {
  ensureDir,
  pathExists,
  readJson,
  relativeFrom,
  safeFileName,
  writeJson
} from './project.mjs';
import {
  employeeProtocolPath,
  loadEmployeeConfig,
  validateTaskPackage
} from './protocol.mjs';

export function loadTask(root, taskFile) {
  const taskPath = path.resolve(root, taskFile);
  if (!pathExists(taskPath)) {
    throw new Error(`task file not found: ${taskFile}`);
  }

  const task = readJson(taskPath);
  const errors = [];
  validateTaskPackage(task, taskFile, errors);
  if (errors.length > 0) throw new Error(errors.join('\n'));

  return { task, taskPath };
}

function employeeConfigOrder(root) {
  const config = loadEmployeeConfig(root);
  const byPath = new Map();
  for (const [index, employee] of config.employees.entries()) {
    byPath.set(employee.path, index);
  }
  return byPath;
}

function employeeFailureReason(employee, task) {
  if (!employee.enabled) return 'employee is disabled';
  if (!employee.discovered) return 'employee repo is not discovered';
  if (!employee.paths) return 'employee protocol paths are missing';
  if (task.task_type && !employee.accepts_task_types.includes(task.task_type)) {
    return `does not accept task_type ${task.task_type}`;
  }
  if (task.assignee_level && task.assignee_level !== employee.level) {
    return `level ${employee.level} does not match assignee_level ${task.assignee_level}`;
  }
  if (employee.status?.state !== 'idle') {
    return `state is ${employee.status?.state || 'unknown'}, not idle`;
  }
  return '';
}

export function selectEmployee(root, index, task, selector = '') {
  const employees = index.employees || [];
  if (selector) {
    const employee = employees.find((item) => item.alias === selector || item.employee_id === selector);
    if (!employee) throw new Error(`employee not found: ${selector}`);
    const reason = employeeFailureReason(employee, task);
    if (reason) throw new Error(`${employee.alias || employee.employee_id} cannot take task: ${reason}`);
    return employee;
  }

  const rejected = [];
  const candidates = [];
  for (const employee of employees) {
    const reason = employeeFailureReason(employee, task);
    if (reason) {
      rejected.push(`${employee.alias || employee.path}: ${reason}`);
    } else {
      candidates.push(employee);
    }
  }

  if (candidates.length === 0) {
    throw new Error([
      'no eligible idle employee found',
      ...rejected.map((reason) => `- ${reason}`)
    ].join('\n'));
  }

  const orderByPath = employeeConfigOrder(root);
  candidates.sort((a, b) => {
    const orderA = orderByPath.get(a.path) ?? Number.MAX_SAFE_INTEGER;
    const orderB = orderByPath.get(b.path) ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB || a.alias.localeCompare(b.alias);
  });

  return candidates[0];
}

export function buildInitialPrompt(taskId) {
  return [
    `请执行项目内任务 ${taskId}。`,
    `请读取 .claude/commands/execute-task.md，并按照 /execute-task ${taskId} 的协议执行。`,
    `JSON 任务包是 inbox/tasks/${taskId}.json。`,
    '完成后必须写 outbox/results 对应 JSON 和 Markdown，更新 state/status.json，并追加 logs/events.jsonl。'
  ].join(' ');
}

export function buildLaunchArgs(task, employee, options = {}) {
  const profile = task.model_hint || employee.default_model_profile;
  const args = ['run', 'claude', '--', '--profile', profile, '--task', task.task_id];
  if (options.skipPermissions) args.push('--skip-permissions');
  if (options.prompt) args.push(options.prompt);
  return { profile, args };
}

export function buildLaunchCommand(employee, launchArgs) {
  return `cd ${employee.path} && npm ${launchArgs.map((arg) => JSON.stringify(arg)).join(' ')}`;
}

export function prepareDispatch(root, taskPath, task, employee, options = {}) {
  const inboxDir = employeeProtocolPath(root, employee, employee.paths.inbox);
  const employeeTaskPath = path.join(inboxDir, `${task.task_id}.json`);
  const submittedPath = path.join(
    root,
    'tasks/submitted',
    `${safeFileName(employee.employee_id)}__${safeFileName(task.task_id)}.json`
  );
  const prompt = buildInitialPrompt(task.task_id);
  const { profile, args: launchArgs } = buildLaunchArgs(task, employee, {
    prompt: options.includePrompt ? prompt : '',
    skipPermissions: options.skipPermissions
  });
  const wakeArgs = buildLaunchArgs(task, employee, {
    skipPermissions: options.skipPermissions
  }).args;

  return {
    employee,
    task,
    taskPath,
    profile,
    prompt,
    launchArgs,
    launchCommand: buildLaunchCommand(employee, launchArgs),
    wakeCommand: buildLaunchCommand(employee, wakeArgs),
    employeeTaskPath,
    submittedPath,
    employeeTaskRelativePath: relativeFrom(root, employeeTaskPath),
    submittedRelativePath: relativeFrom(root, submittedPath)
  };
}

export function writeDispatch(root, dispatch, options = {}) {
  if (pathExists(dispatch.employeeTaskPath) && !options.force) {
    throw new Error(`employee task already exists: ${dispatch.employeeTaskRelativePath}; pass --force to overwrite`);
  }
  if (pathExists(dispatch.submittedPath) && !options.force) {
    throw new Error(`submission record already exists: ${dispatch.submittedRelativePath}; pass --force to overwrite`);
  }

  ensureDir(path.dirname(dispatch.employeeTaskPath));
  ensureDir(path.dirname(dispatch.submittedPath));
  writeJson(dispatch.employeeTaskPath, dispatch.task);
  writeJson(dispatch.submittedPath, {
    schema_version: 'pm-submission.v1',
    task_id: dispatch.task.task_id,
    employee_id: dispatch.employee.employee_id,
    employee_alias: dispatch.employee.alias,
    employee_path: dispatch.employee.path,
    submitted_at: new Date().toISOString(),
    task_source: relativeFrom(root, dispatch.taskPath),
    employee_task_path: dispatch.employeeTaskRelativePath,
    wake_command: dispatch.wakeCommand,
    launch_command: dispatch.launchCommand,
    task_snapshot: dispatch.task
  });
}
