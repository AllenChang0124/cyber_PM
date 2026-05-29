#!/usr/bin/env node
import { discoverEmployees } from './lib/protocol.mjs';
import { printTable } from './lib/project.mjs';

const root = process.cwd();
const index = discoverEmployees(root, { writeIndex: true });

const rows = index.employees.map((employee) => ({
  alias: employee.alias,
  employee_id: employee.employee_id || '(missing)',
  level: employee.level || '(missing)',
  enabled: employee.enabled ? 'yes' : 'no',
  discovered: employee.discovered ? 'yes' : 'no',
  state: employee.status?.state || '(unknown)',
  model: employee.status?.model_profile || employee.default_model_profile || '(unknown)'
}));

printTable(rows, [
  { key: 'alias', header: 'alias' },
  { key: 'employee_id', header: 'employee_id' },
  { key: 'level', header: 'level' },
  { key: 'enabled', header: 'enabled' },
  { key: 'discovered', header: 'found' },
  { key: 'state', header: 'state' },
  { key: 'model', header: 'model' }
]);

console.log(`discovered ${index.employees.filter((employee) => employee.discovered).length} employee(s)`);
