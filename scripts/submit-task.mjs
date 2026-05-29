#!/usr/bin/env node
import {
  parseArgs
} from './lib/project.mjs';
import {
  discoverEmployees,
  findEmployee
} from './lib/protocol.mjs';
import {
  loadTask,
  prepareDispatch,
  writeDispatch
} from './lib/dispatch.mjs';

const root = process.cwd();
const args = parseArgs();

if (!args.file || !args.employee) {
  console.error('usage: npm run submit -- --file tasks/drafts/task-0001.json --employee junior-demo');
  process.exit(1);
}

const index = discoverEmployees(root, { writeIndex: true });
const employee = findEmployee(index, args.employee);
if (!employee) {
  console.error(`error - enabled employee not found: ${args.employee}`);
  process.exit(1);
}

let dispatch;
try {
  const { task, taskPath } = loadTask(root, args.file);
  if (task.task_type && !employee.accepts_task_types.includes(task.task_type)) {
    throw new Error(`${employee.alias} does not accept task_type ${task.task_type}`);
  }
  if (task.assignee_level && task.assignee_level !== employee.level) {
    throw new Error(`task assignee_level ${task.assignee_level} does not match employee level ${employee.level}`);
  }
  dispatch = prepareDispatch(root, taskPath, task, employee);
  writeDispatch(root, dispatch, { force: Boolean(args.force) });
} catch (error) {
  console.error(`error - ${error.message}`);
  process.exit(1);
}

console.log(`submitted ${dispatch.task.task_id} to ${employee.alias}`);
console.log(`employee task: ${dispatch.employeeTaskRelativePath}`);
console.log('wake command:');
console.log(dispatch.wakeCommand);
