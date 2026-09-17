import { readFileSync } from 'node:fs';
import { reduce } from './.router/objectives/reducer.mjs';
const filename = process.argv[2];
if (!filename) {
  console.error('Usage: node cli.mjs events.json (JSON array of objective events)');
  process.exitCode = 2;
} else {
  try {
    const events = JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(events)) throw new Error('Input must be a JSON array.');
    const ids = new Set(events.map(e => e?.objectiveId).filter(Boolean));
    if (ids.size > 1) throw new Error('Supply events for one objective at a time.');
    process.stdout.write(JSON.stringify(reduce(events), null, 2) + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
