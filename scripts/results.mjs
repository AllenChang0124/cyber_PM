#!/usr/bin/env node
import path from 'node:path';
import {
  parseArgs,
  pathExists,
  printTable,
  readJson
} from './lib/project.mjs';
import { validateResultPackage } from './lib/protocol.mjs';

const root = process.cwd();
const args = parseArgs();
const collectionsPath = path.join(root, 'state/collections.json');
const errors = [];

const collections = pathExists(collectionsPath)
  ? readJson(collectionsPath)
  : { schema_version: 'pm-collections.v1', updated_at: '', items: [] };

const rows = [];
for (const item of collections.items || []) {
  if (args.employee && ![item.employee_id, item.employee_alias].includes(args.employee)) continue;
  if (!item.collected_json || !pathExists(path.join(root, item.collected_json))) continue;

  const result = readJson(path.join(root, item.collected_json));
  validateResultPackage(result, item.collected_json, errors);
  if (args.status && result.status !== args.status) continue;

  rows.push({
    employee: item.employee_alias || item.employee_id,
    task_id: item.task_id,
    status: result.status,
    model_used: result.model_used,
    summary: result.summary,
    collected_at: item.last_collected_at || item.first_collected_at || '',
    result_path: item.collected_json
  });
}

if (errors.length > 0) {
  for (const error of errors) console.error(`error - ${error}`);
  process.exit(1);
}

rows.sort((a, b) => `${a.employee}:${a.task_id}`.localeCompare(`${b.employee}:${b.task_id}`));

if (args.json) {
  console.log(JSON.stringify({
    schema_version: 'pm-results-view.v1',
    filters: {
      employee: args.employee || null,
      status: args.status || null
    },
    results: rows
  }, null, 2));
} else {
  printTable(rows, [
    { key: 'employee', header: 'employee' },
    { key: 'task_id', header: 'task_id' },
    { key: 'status', header: 'status' },
    { key: 'model_used', header: 'model_used' },
    { key: 'collected_at', header: 'collected_at' },
    { key: 'result_path', header: 'result_path' }
  ]);
}
