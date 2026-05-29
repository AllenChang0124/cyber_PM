#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  parseArgs,
  pathExists,
  readJson,
  relativeFrom,
  safeFileName,
  writeJson
} from './lib/project.mjs';
import {
  discoverEmployees,
  employeeProtocolPath,
  employeeRoot,
  findEmployee,
  validateTaskPackage
} from './lib/protocol.mjs';

const root = process.cwd();
const args = parseArgs();
const errors = [];

if (!args.file || !args.employee) {
  console.error('usage: npm run submit -- --file tasks/drafts/task-0001.json --employee junior-demo');
  process.exit(1);
}

const taskPath = path.resolve(root, args.file);
if (!pathExists(taskPath)) {
  console.error(`error - task file not found: ${args.file}`);
  process.exit(1);
}

const index = discoverEmployees(root, { writeIndex: true });
const employee = findEmployee(index, args.employee);
if (!employee) {
  console.error(`error - enabled employee not found: ${args.employee}`);
  process.exit(1);
}

const task = readJson(taskPath);
validateTaskPackage(task, args.file, errors);

if (task.task_type && !employee.accepts_task_types.includes(task.task_type)) {
  errors.push(`${employee.alias} does not accept task_type ${task.task_type}`);
}

if (task.assignee_level && task.assignee_level !== employee.level) {
  errors.push(`task assignee_level ${task.assignee_level} does not match employee level ${employee.level}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`error - ${error}`);
  process.exit(1);
}

const inboxDir = employeeProtocolPath(root, employee, employee.paths.inbox);
const employeeTaskPath = path.join(inboxDir, `${task.task_id}.json`);
if (pathExists(employeeTaskPath) && !args.force) {
  console.error(`error - employee task already exists: ${relativeFrom(root, employeeTaskPath)}; pass --force to overwrite`);
  process.exit(1);
}

ensureDir(inboxDir);
writeJson(employeeTaskPath, task);

const profile = task.model_hint || employee.default_model_profile;
const wakeCommand = `cd ${employee.path} && npm run claude -- --profile ${profile} --task ${task.task_id}`;
const submittedPath = path.join(
  root,
  'tasks/submitted',
  `${safeFileName(employee.employee_id)}__${safeFileName(task.task_id)}.json`
);

if (pathExists(submittedPath) && !args.force) {
  fs.rmSync(employeeTaskPath);
  console.error(`error - submission record already exists: ${relativeFrom(root, submittedPath)}; pass --force to overwrite`);
  process.exit(1);
}

writeJson(submittedPath, {
  schema_version: 'pm-submission.v1',
  task_id: task.task_id,
  employee_id: employee.employee_id,
  employee_alias: employee.alias,
  employee_path: employee.path,
  submitted_at: new Date().toISOString(),
  task_source: relativeFrom(root, taskPath),
  employee_task_path: relativeFrom(root, employeeTaskPath),
  wake_command: wakeCommand,
  task_snapshot: task
});

console.log(`submitted ${task.task_id} to ${employee.alias}`);
console.log(`employee task: ${relativeFrom(root, employeeTaskPath)}`);
console.log('wake command:');
console.log(wakeCommand);
