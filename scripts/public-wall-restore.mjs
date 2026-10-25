import { restorePublicWall } from '../src/server/public-wall-restore.js';

const [directory, snapshot, ...extra] = process.argv.slice(2);
if (!directory || !snapshot || extra.length) {
  console.error('Usage: public-wall-restore.sh <public-data-directory> <snapshot.bin>');
  process.exitCode = 1;
} else {
  try {
    await restorePublicWall(directory, snapshot);
    console.log('Public wall restored into a new room. Restart only the public relay; writers re-enter automatically.');
  } catch {
    console.error('Restore refused or failed. Stop the public relay and use its marked data directory and a valid local snapshot.');
    process.exitCode = 1;
  }
}
