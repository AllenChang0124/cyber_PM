#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { commandAvailable, pathExists } from './lib/project.mjs';

const root = process.cwd();
const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
  console.error(`error - ${message}`);
}

function warn(message) {
  warnings.push(message);
  console.warn(`warning - ${message}`);
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) fail(`Node.js >= 18 required, current ${process.versions.node}`);
else console.log(`ok - Node.js ${process.versions.node}`);

if (!commandAvailable('git')) fail('git is not available');
else console.log('ok - git available');

for (const file of ['package.json', 'README.md', 'AGENTS.md', 'config/employees.json']) {
  if (!pathExists(path.join(root, file))) fail(`${file} missing`);
  else console.log(`ok - ${file}`);
}

for (const dir of ['employees', 'tasks/drafts', 'tasks/submitted', 'results/collected', 'state', 'logs', 'scripts']) {
  if (!pathExists(path.join(root, dir))) fail(`${dir} missing`);
  else console.log(`ok - ${dir}`);
}

const templatePath = path.resolve(root, '../cyber_employee');
if (!pathExists(path.join(templatePath, 'agent.json'))) {
  warn('../cyber_employee employee template not found; npm run setup:demo will not work until it exists');
} else {
  console.log('ok - ../cyber_employee template found');
}

const employeesRoot = path.join(root, 'employees');
const employeeDirs = fs.existsSync(employeesRoot)
  ? fs.readdirSync(employeesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  : [];
if (employeeDirs.length === 0) warn('no employee clones found yet; run npm run setup:demo for local acceptance');
else console.log(`ok - ${employeeDirs.length} employee folder(s) found`);

if (warnings.length > 0) console.warn(`doctor completed with ${warnings.length} warning(s)`);
if (errors.length > 0) {
  console.error(`doctor failed with ${errors.length} error(s)`);
  process.exit(1);
}

console.log('doctor passed');
