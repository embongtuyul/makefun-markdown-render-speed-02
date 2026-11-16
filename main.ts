import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const input = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const cases = input.cases ?? input;
const html = cases.map((c: { markdown: string }) => parse(c.markdown));
mkdirSync('/output', { recursive: true });
writeFileSync('/output/html.json', JSON.stringify(html));
