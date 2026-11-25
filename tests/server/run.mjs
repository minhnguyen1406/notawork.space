// Runs every server behaviour test, one at a time, against a running dev server (npm run dev).
// One at a time matters: they share the one room, so overlapping runs would see each other's players.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// fileURLToPath (not .pathname) so folders with spaces in their names work.
const dir = fileURLToPath(new URL('.', import.meta.url));
let failed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'run.mjs').sort()) {
  const run = spawnSync(process.execPath, [dir + file], { encoding: 'utf8' });
  const lines = run.stdout.split('\n');
  const fails = lines.filter((l) => l.startsWith('FAIL'));
  console.log(`${fails.length ? 'FAIL' : 'ok  '} ${file}: ${lines.filter((l) => l.startsWith('PASS')).length} passed, ${fails.length} failed`);
  for (const f of fails) console.log('     ' + f);
  if (run.stderr.trim()) console.log(run.stderr.trim());
  failed += fails.length + (run.status && !fails.length ? 1 : 0);
  await new Promise((r) => setTimeout(r, 3000)); // let the room empty before the next file
}
process.exit(failed ? 1 : 0);
