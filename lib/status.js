import fs from 'node:fs';
import { isWrapped, resolveBinPath, BACKUP_SUFFIX } from './utils.js';

export async function status(binPath) {
  const resolvedPath = resolveBinPath(binPath);
  const backupPath = resolvedPath + BACKUP_SUFFIX;
  const wrapped = isWrapped(resolvedPath);

  if (wrapped) {
    // Extract timeout from the "# Timeout: Ns" comment line
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const match = content.match(/Timeout: (\d+)s/);
    const timeout = match ? parseInt(match[1], 10) : null;

    return { wrapped: true, binPath: resolvedPath, timeout, backupPath };
  }

  return { wrapped: false, binPath: resolvedPath };
}
