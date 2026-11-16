// Driver for the markdown-render-speed-02 entry: reads the case file the
// grader mounts at /input/cases.json, renders every case with the local
// dependency-free parser, and writes the results to /output/html.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const cases = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const html = {};
for (const c of cases) {
  html[c.id] = parse(c.markdown);
}
mkdirSync('/output', { recursive: true });
writeFileSync('/output/html.json', JSON.stringify(html));
