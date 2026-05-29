#!/usr/bin/env node
import {
  parseArgs,
  pathExists,
  printTable
} from './lib/project.mjs';
import {
  buildLiveTaskRows,
  readLedger
} from './lib/ledger.mjs';

const root = process.cwd();
const args = parseArgs();

function rowsFromLedger(ledger) {
  return (ledger.tasks || []).map((task) => ({
    task_id: task.task_id,
    title: task.title,
    employee: task.employee_alias || task.employee_id,
    task_type: task.task_type,
    priority: task.priority,
    lifecycle: task.lifecycle,
    result_status: task.result_status,
    pm_status: task.pm_status,
    next_action: task.next_action,
    updated_at: task.updated_at
  }));
}

let rows = [];
let source = 'live';

if (!args.live && pathExists(`${root}/state/task-ledger.json`)) {
  const ledger = readLedger(root);
  rows = rowsFromLedger(ledger);
  source = 'ledger';
} else {
  rows = buildLiveTaskRows(root).map((row) => ({
    ...row,
    employee: row.employee_alias || row.employee_id,
    pm_status: '',
    next_action: ''
  }));
}

rows.sort((a, b) => `${a.task_id}:${a.employee || ''}`.localeCompare(`${b.task_id}:${b.employee || ''}`));

if (args.json) {
  console.log(JSON.stringify({
    schema_version: 'pm-tasks-view.v1',
    source,
    tasks: rows
  }, null, 2));
} else {
  printTable(rows, [
    { key: 'task_id', header: 'task_id' },
    { key: 'title', header: 'title' },
    { key: 'employee', header: 'employee' },
    { key: 'task_type', header: 'task_type' },
    { key: 'priority', header: 'priority' },
    { key: 'lifecycle', header: 'lifecycle' },
    { key: 'result_status', header: 'result_status' },
    { key: 'pm_status', header: 'pm_status' },
    { key: 'next_action', header: 'next_action' },
    { key: 'updated_at', header: 'updated_at' }
  ]);
}
