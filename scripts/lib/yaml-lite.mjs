import fs from 'node:fs';

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed === '{}') return {};
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseScalar(item.trim()));
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function nextSignificant(lines, index) {
  for (let i = index + 1; i < lines.length; i += 1) {
    const raw = stripComment(lines[i]);
    if (raw.trim() !== '') return raw;
  }
  return '';
}

function parseBlock(lines, startIndex, indent) {
  const next = nextSignificant(lines, startIndex - 1);
  const container = next.trimStart().startsWith('- ') ? [] : {};
  let i = startIndex;

  while (i < lines.length) {
    const raw = stripComment(lines[i]);
    if (raw.trim() === '') {
      i += 1;
      continue;
    }

    const currentIndent = raw.match(/^ */)[0].length;
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      i += 1;
      continue;
    }

    const trimmed = raw.trim();
    if (Array.isArray(container)) {
      if (!trimmed.startsWith('- ')) break;
      const body = trimmed.slice(2).trim();
      if (body === '') {
        const parsed = parseBlock(lines, i + 1, indent + 2);
        container.push(parsed.value);
        i = parsed.index;
        continue;
      }
      if (/^[A-Za-z0-9_-]+:\s*/.test(body)) {
        const [key, ...rest] = body.split(':');
        const restValue = rest.join(':').trim();
        const item = {};
        if (restValue) {
          item[key] = parseScalar(restValue);
          container.push(item);
          i += 1;
        } else {
          const parsed = parseBlock(lines, i + 1, indent + 2);
          item[key] = parsed.value;
          container.push(item);
          i = parsed.index;
        }
        continue;
      }
      container.push(parseScalar(body));
      i += 1;
      continue;
    }

    const separator = trimmed.indexOf(':');
    if (separator === -1) {
      i += 1;
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (value !== '') {
      container[key] = parseScalar(value);
      i += 1;
      continue;
    }

    const parsed = parseBlock(lines, i + 1, indent + 2);
    container[key] = parsed.value;
    i = parsed.index;
  }

  return { value: container, index: i };
}

export function parseYaml(source) {
  return parseBlock(source.split(/\r?\n/), 0, 0).value;
}

export function readYaml(filePath) {
  return parseYaml(fs.readFileSync(filePath, 'utf8'));
}
