import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT, projectTests } from './project-files.mjs';

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...projectTests()], {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
