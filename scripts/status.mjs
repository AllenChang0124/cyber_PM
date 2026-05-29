#!/usr/bin/env node
import { discoverEmployees } from './lib/protocol.mjs';
import { parseArgs, printTable } from './lib/project.mjs';

const root = process.cwd();
const args = parseArgs();
const index = discoverEmployees(root, { writeIndex: Boolean(args.refresh) });

const rows = index.employees.map((employee) => ({
  alias: employee.alias,
  employee_id: employee.employee_id || '(missing)',
  level: employee.level || '(missing)',
  state: employee.status?.state || (employee.discovered ? '(unknown)' : '(not found)'),
  active_task: employee.status?.active_task_id || '',
  model: employee.status?.model_profile || employee.default_model_profile || '',
  updated_at: employee.status?.updated_at || ''
}));

printTable(rows, [
  { key: 'alias', header: 'alias' },
  { key: 'employee_id', header: 'employee_id' },
  { key: 'level', header: 'level' },
  { key: 'state', header: 'state' },
  { key: 'active_task', header: 'active_task' },
  { key: 'model', header: 'model' },
  { key: 'updated_at', header: 'updated_at' }
]);

if (args.refresh) {
  console.log('refreshed state/employees.json');
}
