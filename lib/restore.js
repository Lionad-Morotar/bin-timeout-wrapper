import fs from 'node:fs';
import { resolveBinPath, BACKUP_SUFFIX } from './utils.js';

export async function restore(binPath) {
  const resolvedPath = resolveBinPath(binPath);
  const backupPath = resolvedPath + BACKUP_SUFFIX;

  if (!fs.existsSync(backupPath)) {
    throw new Error(`No backup found at ${backupPath}`);
  }

  fs.unlinkSync(resolvedPath);
  fs.renameSync(backupPath, resolvedPath);

  return { binPath: resolvedPath, restoredFrom: backupPath };
}
