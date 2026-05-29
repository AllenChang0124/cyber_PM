#!/usr/bin/env node
import {
  parseArgs
} from './lib/project.mjs';
import {
  printRunsTable,
  readRuns,
  writeRunIndex
} from './lib/runs.mjs';

const root = process.cwd();
const args = parseArgs();
const index = args.refresh ? writeRunIndex(root) : null;

let runs = index?.runs || readRuns(root);
if (args.employee) {
  runs = runs.filter((run) => (
    run.employee_id === args.employee || run.employee_alias === args.employee
  ));
}
if (args.status) {
  runs = runs.filter((run) => run.status === args.status);
}

runs.sort((a, b) => `${a.started_at || ''}:${a.run_id}`.localeCompare(`${b.started_at || ''}:${b.run_id}`));

if (args.json) {
  console.log(JSON.stringify({
    schema_version: 'pm-runs-view.v1',
    filters: {
      employee: args.employee || null,
      status: args.status || null
    },
    refreshed: Boolean(args.refresh),
    runs
  }, null, 2));
} else {
  printRunsTable(runs);
}
