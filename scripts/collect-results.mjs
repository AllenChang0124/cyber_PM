#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  pathExists,
  readJson,
  readText,
  relativeFrom,
  safeFileName,
  sha256Text,
  writeJson
} from './lib/project.mjs';
import {
  discoverEmployees,
  employeeProtocolPath,
  validateResultPackage
} from './lib/protocol.mjs';

const root = process.cwd();
const index = discoverEmployees(root, { writeIndex: true });
const collectionsPath = path.join(root, 'state/collections.json');
const existing = pathExists(collectionsPath)
  ? readJson(collectionsPath)
  : { schema_version: 'pm-collections.v1', updated_at: '', items: [] };
const byKey = new Map((existing.items || []).map((item) => [item.key, item]));

let copied = 0;
let skipped = 0;
let warnings = 0;
const errors = [];

for (const employee of index.employees.filter((item) => item.enabled && item.discovered)) {
  const outboxDir = employeeProtocolPath(root, employee, employee.paths.outbox);
  if (!pathExists(outboxDir)) continue;

  for (const entry of fs.readdirSync(outboxDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const sourceJson = path.join(outboxDir, entry.name);
    const result = readJson(sourceJson);
    const label = relativeFrom(root, sourceJson);
    validateResultPackage(result, label, errors);
    if (errors.length > 0) continue;

    const taskId = result.task_id;
    const sourceMd = sourceJson.replace(/\.json$/, '.md');
    const jsonText = readText(sourceJson);
    const mdText = pathExists(sourceMd) ? readText(sourceMd) : '';
    if (!mdText) {
      warnings += 1;
      console.warn(`warning - missing Markdown companion for ${label}`);
    }

    const hash = sha256Text(`${jsonText}\n---markdown---\n${mdText}`);
    const key = `${employee.employee_id}__${taskId}`;
    const previous = byKey.get(key);
    const destDir = path.join(root, 'results/collected', safeFileName(employee.employee_id));
    const destJson = path.join(destDir, `${safeFileName(taskId)}.json`);
    const destMd = path.join(destDir, `${safeFileName(taskId)}.md`);

    if (previous?.sha256 === hash && pathExists(destJson)) {
      skipped += 1;
      continue;
    }

    ensureDir(destDir);
    fs.copyFileSync(sourceJson, destJson);
    if (mdText) fs.copyFileSync(sourceMd, destMd);

    const now = new Date().toISOString();
    byKey.set(key, {
      key,
      employee_id: employee.employee_id,
      employee_alias: employee.alias,
      task_id: taskId,
      status: result.status,
      source_json: relativeFrom(root, sourceJson),
      source_md: mdText ? relativeFrom(root, sourceMd) : null,
      collected_json: relativeFrom(root, destJson),
      collected_md: mdText ? relativeFrom(root, destMd) : null,
      sha256: hash,
      first_collected_at: previous?.first_collected_at || now,
      last_collected_at: now
    });
    copied += 1;
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`error - ${error}`);
  process.exit(1);
}

writeJson(collectionsPath, {
  schema_version: 'pm-collections.v1',
  updated_at: new Date().toISOString(),
  items: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
});

console.log(`collect complete: copied=${copied}, skipped=${skipped}, warnings=${warnings}`);
