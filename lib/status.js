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

    // 获取备份文件的创建时间
    let createdAt = null;
    if (fs.existsSync(backupPath)) {
      try {
        const stat = fs.statSync(backupPath);
        // 使用 birthtime（创建时间）或 mtime（修改时间）作为后备
        createdAt = stat.birthtimeMs ? stat.birthtime : stat.mtime;
      } catch {
        // 忽略读取失败的情况
      }
    }

    return { wrapped: true, binPath: resolvedPath, timeout, backupPath, createdAt };
  }

  return { wrapped: false, binPath: resolvedPath, createdAt: null };
}
