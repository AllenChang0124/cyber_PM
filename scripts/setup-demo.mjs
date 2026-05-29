#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, pathExists, runChecked, writeText } from './lib/project.mjs';

const root = process.cwd();
const templatePath = path.resolve(root, '../cyber_employee');
const employeesRoot = path.join(root, 'employees');

const demos = [
  {
    dir: 'senior-demo',
    id: 'senior-demo',
    name: 'Senior Demo Employee',
    level: 'senior',
    profile: 'senior-deepseek'
  },
  {
    dir: 'junior-demo',
    id: 'junior-demo',
    name: 'Junior Demo Employee',
    level: 'junior',
    profile: 'junior-deepseek'
  }
];

function employeeYaml(demo) {
  return [
    'employee:',
    `  id: ${demo.id}`,
    `  name: ${demo.name}`,
    `  level: ${demo.level}`,
    '  role: implementation_employee',
    `  default_model_profile: ${demo.profile}`,
    '',
    'capabilities:',
    '  - execute_json_task_packages',
    '  - produce_json_result_packages',
    '  - maintain_project_local_memory',
    '  - run_project_local_validation',
    '',
    'accepts_task_types:',
    '  - implementation',
    '  - testing',
    '  - documentation',
    '  - research',
    '',
    'responsibilities:',
    '  owns:',
    '    - Execute assigned task packages from inbox/tasks',
    '    - Produce result packages in outbox/results',
    '    - Keep state/status.json current while working',
    '  does_not_own:',
    '    - Product strategy',
    '    - Multi-employee scheduling',
    '    - Cross-repository PM coordination',
    ''
  ].join('\n');
}

if (!pathExists(path.join(templatePath, 'agent.json'))) {
  console.error('error - ../cyber_employee template not found or not initialized');
  process.exit(1);
}

ensureDir(employeesRoot);

for (const demo of demos) {
  const target = path.join(employeesRoot, demo.dir);
  if (pathExists(target)) {
    if (!pathExists(path.join(target, 'agent.json'))) {
      console.error(`error - ${target} already exists but does not look like an employee repo`);
      process.exit(1);
    }
    console.log(`skip - employees/${demo.dir} already exists`);
    continue;
  }

  console.log(`clone - ${demo.dir}`);
  runChecked('git', ['clone', '--local', templatePath, target]);
  writeText(path.join(target, 'config/employee.yaml'), employeeYaml(demo));
  runChecked('npm', ['run', 'sync'], { cwd: target });

  const gitDir = path.join(target, '.git');
  if (fs.existsSync(gitDir)) {
    console.log(`ok - employees/${demo.dir} initialized as local employee clone`);
  }
}

console.log('setup demo employees complete');
