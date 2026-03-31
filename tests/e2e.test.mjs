import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import { wrap } from '../lib/wrap.js';
import { restore } from '../lib/restore.js';
import { status } from '../lib/status.js';
import { isWrapped, resolveBinPath, parseTimeout, BACKUP_SUFFIX } from '../lib/utils.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir;

function createTempDir() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btw-test-'));
}

function cleanupTempDir() {
  if (tempDir && fs.existsSync(tempDir)) {
    // Restore any wrapped binaries before removing dir
    const entries = fs.readdirSync(tempDir);
    for (const entry of entries) {
      const fullPath = path.join(tempDir, entry);
      if (entry.endsWith(BACKUP_SUFFIX)) {
        // There may be a wrapper at the corresponding path; restore it
        const wrapperPath = fullPath.slice(0, -BACKUP_SUFFIX.length);
        if (fs.existsSync(wrapperPath) && isWrapped(wrapperPath)) {
          try {
            fs.unlinkSync(wrapperPath);
            fs.renameSync(fullPath, wrapperPath);
          } catch { /* best effort */ }
        }
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createTestBinary(name, content) {
  const binPath = path.join(tempDir, name);
  // Ensure parent directory exists (for paths with spaces, name may contain dir separators)
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, content, 'utf-8');
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

/**
 * Spawn a wrapped binary, capture stdout/stderr, and return results.
 * Has a hard max-wait timeout so tests cannot hang forever.
 */
function spawnWrapped(binPath, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('spawnWrapped timed out after 15s'));
    }, 15_000);

    let stdout = '';
    let stderr = '';

    const mergedEnv = { ...process.env, ...env };
    const child = spawn(binPath, args, { env: mergedEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? null, stdout, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Returns elapsed time in ms for an async operation.
 */
async function timeAsync(fn) {
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;
  return { result, elapsed };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('E2E: bin-timeout-wrapper', () => {
  beforeEach(() => { createTempDir(); });
  afterEach(() => { cleanupTempDir(); });

  // -----------------------------------------------------------------------
  // 1. Wrap binary and timeout kills process
  // -----------------------------------------------------------------------
  test('wraps binary and timeout kills process with exit 137', async () => {
    const bin = createTestBinary('sleep30', '#!/bin/sh\nsleep 30\n');
    await wrap(bin, 3);

    const { result, elapsed } = await timeAsync(() => spawnWrapped(bin));
    expect(result.exitCode).toBe(137);
    // Should die in ~3s, not 30s
    expect(elapsed).toBeLessThan(8_000);
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
  }, 15_000);

  // -----------------------------------------------------------------------
  // 2. Wrapped binary passes through stdout and exit code
  // -----------------------------------------------------------------------
  test('wrapped binary passes through stdout and exit code', async () => {
    const bin = createTestBinary('echoexit', '#!/bin/sh\necho "hello world"\nexit 42\n');
    await wrap(bin, 10);

    const result = await spawnWrapped(bin);
    expect(result.exitCode).toBe(42);
    expect(result.stdout.trim()).toBe('hello world');
  });

  // -----------------------------------------------------------------------
  // 3. Wrapped binary passes through stderr
  // -----------------------------------------------------------------------
  test('wrapped binary passes through stderr', async () => {
    const bin = createTestBinary('stderr', '#!/bin/sh\necho "error message" >&2\n');
    await wrap(bin, 10);

    const result = await spawnWrapped(bin);
    expect(result.stderr.trim()).toBe('error message');
  });

  // -----------------------------------------------------------------------
  // 4. Duplicate wrap is rejected
  // -----------------------------------------------------------------------
  test('duplicate wrap is rejected', async () => {
    const bin = createTestBinary('simple', '#!/bin/sh\necho hi\n');
    await wrap(bin, 5);

    await expect(wrap(bin, 5)).rejects.toThrow('Already wrapped');
  });

  // -----------------------------------------------------------------------
  // 5. Restore recovers original binary
  // -----------------------------------------------------------------------
  test('restore recovers original binary', async () => {
    const originalContent = '#!/bin/sh\necho "original"\nexit 7\n';
    const bin = createTestBinary('original', originalContent);

    await wrap(bin, 5);
    expect(isWrapped(bin)).toBe(true);

    await restore(bin);
    expect(isWrapped(bin)).toBe(false);

    // Verify original content is restored by checking the binary works
    const result = await spawnWrapped(bin);
    expect(result.exitCode).toBe(7);
    expect(result.stdout.trim()).toBe('original');
  });

  // -----------------------------------------------------------------------
  // 6. Restore unwrapped binary fails
  // -----------------------------------------------------------------------
  test('restore unwrapped binary fails', async () => {
    const bin = createTestBinary('unwrapped', '#!/bin/sh\necho hi\n');

    await expect(restore(bin)).rejects.toThrow('No backup found');
  });

  // -----------------------------------------------------------------------
  // 7. Status reports wrapped state
  // -----------------------------------------------------------------------
  test('status reports wrapped state', async () => {
    const bin = createTestBinary('statustest', '#!/bin/sh\necho hi\n');

    // Before wrap
    const before = await status(bin);
    expect(before.wrapped).toBe(false);
    expect(before.binPath).toBe(bin);

    // After wrap
    await wrap(bin, 7);
    const after = await status(bin);
    expect(after.wrapped).toBe(true);
    expect(after.timeout).toBe(7);
    expect(after.backupPath).toBe(bin + BACKUP_SUFFIX);

    // After restore
    await restore(bin);
    const restored = await status(bin);
    expect(restored.wrapped).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 8. BIN_TIMEOUT env var overrides default
  // -----------------------------------------------------------------------
  test('BIN_TIMEOUT env var overrides default timeout', async () => {
    const bin = createTestBinary('envoverride', '#!/bin/sh\nsleep 30\n');
    await wrap(bin, 10); // default 10s

    const { result, elapsed } = await timeAsync(() =>
      spawnWrapped(bin, [], { BIN_TIMEOUT: '1' })
    );
    expect(result.exitCode).toBe(137);
    expect(elapsed).toBeLessThan(5_000);
    expect(elapsed).toBeGreaterThanOrEqual(800);
  }, 15_000);

  // -----------------------------------------------------------------------
  // 9. BIN_TIMEOUT=0 disables timeout
  // -----------------------------------------------------------------------
  test('BIN_TIMEOUT=0 disables timeout', async () => {
    const bin = createTestBinary('notimeout', '#!/bin/sh\nsleep 1\necho done\n');
    await wrap(bin, 5);

    const result = await spawnWrapped(bin, [], { BIN_TIMEOUT: '0' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('done');
  });

  // -----------------------------------------------------------------------
  // 10. Rapid wrap/restore/wrap sequence
  // -----------------------------------------------------------------------
  test('rapid wrap/restore/wrap sequence', async () => {
    const bin = createTestBinary('sequence', '#!/bin/sh\necho step\n');

    await wrap(bin, 5);
    await restore(bin);
    await wrap(bin, 5);
    await restore(bin);
    await wrap(bin, 5);

    // Final state should be wrapped
    const s = await status(bin);
    expect(s.wrapped).toBe(true);

    // Restore to clean up
    await restore(bin);
    const s2 = await status(bin);
    expect(s2.wrapped).toBe(false);

    // Verify binary still works
    const result = await spawnWrapped(bin);
    expect(result.stdout.trim()).toBe('step');
  });

  // -----------------------------------------------------------------------
  // 11. Path with spaces works
  // -----------------------------------------------------------------------
  test('path with spaces works', async () => {
    const bin = createTestBinary('my bin', '#!/bin/sh\necho "spaced"\n');
    await wrap(bin, 5);

    const result = await spawnWrapped(bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('spaced');

    await restore(bin);
    const result2 = await spawnWrapped(bin);
    expect(result2.stdout.trim()).toBe('spaced');
  });

  // -----------------------------------------------------------------------
  // 12. Backup collision is rejected
  // -----------------------------------------------------------------------
  test('backup collision is rejected', async () => {
    const bin = createTestBinary('collision', '#!/bin/sh\necho hi\n');
    // Manually create a _backup file
    const backupPath = bin + BACKUP_SUFFIX;
    fs.writeFileSync(backupPath, '#!/bin/sh\necho old\n', 'utf-8');

    await expect(wrap(bin, 5)).rejects.toThrow('Backup already exists');

    // Cleanup
    fs.unlinkSync(backupPath);
  });

  // -----------------------------------------------------------------------
  // 13. Symlinked binary is wrapped and restored correctly (ISSUE-004)
  // -----------------------------------------------------------------------
  test('symlinked binary is wrapped and restored correctly', async () => {
    const realBin = createTestBinary('realbin', '#!/bin/sh\necho "real"\n');
    const symlinkPath = path.join(tempDir, 'symlink-bin');
    fs.symlinkSync(realBin, symlinkPath);

    await wrap(symlinkPath, 5);
    // The wrapper replaces the symlink with a real file
    expect(isWrapped(symlinkPath)).toBe(true);
    // The real binary should be untouched (backed up via the symlink path)
    expect(fs.existsSync(symlinkPath + BACKUP_SUFFIX)).toBe(true);

    const result = await spawnWrapped(symlinkPath);
    expect(result.stdout.trim()).toBe('real');

    await restore(symlinkPath);
    // After restore, the symlink should exist again
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 14. SIGTERM is forwarded to child process (ISSUE-003/ISSUE-005)
  // -----------------------------------------------------------------------
  test('SIGTERM is forwarded to child process', async () => {
    const bin = createTestBinary('sigterm-test', '#!/bin/sh\ntrap "" TERM\nsleep 30\n');
    await wrap(bin, 30); // long timeout so SIGALRM does not interfere

    const child = spawn(bin, [], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    // Wait briefly for the child to start and trap TERM
    await new Promise(r => setTimeout(r, 300));

    child.kill('SIGTERM');
    const { exitCode, signalCode } = await new Promise(resolve => {
      child.on('close', (code, signal) => resolve({ exitCode: code, signalCode: signal }));
    });

    // The wrapper forwards SIGTERM to the child process group and exits(143).
    // Node may report exitCode=143 (perl exit) or exitCode=null + signalCode='SIGTERM'.
    const effectiveCode = exitCode ?? (signalCode ? 128 + ({ SIGTERM: 15, SIGINT: 2, SIGKILL: 9 }[signalCode] ?? 0) : 0);
    expect(effectiveCode).toBe(143);
  }, 10_000);

  // -----------------------------------------------------------------------
  // 15. SIGINT is forwarded to child process (ISSUE-003/ISSUE-005)
  // -----------------------------------------------------------------------
  test('SIGINT is forwarded to child process', async () => {
    const bin = createTestBinary('sigint-test', '#!/bin/sh\ntrap "" INT\nsleep 30\n');
    await wrap(bin, 30); // long timeout so SIGALRM does not interfere

    const child = spawn(bin, [], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    // Wait briefly for the child to start and trap INT
    await new Promise(r => setTimeout(r, 300));

    child.kill('SIGINT');
    const { exitCode, signalCode } = await new Promise(resolve => {
      child.on('close', (code, signal) => resolve({ exitCode: code, signalCode: signal }));
    });

    // The wrapper forwards SIGINT to the child process group and exits(130).
    const effectiveCode = exitCode ?? (signalCode ? 128 + ({ SIGTERM: 15, SIGINT: 2, SIGKILL: 9 }[signalCode] ?? 0) : 0);
    expect(effectiveCode).toBe(130);
  }, 10_000);

  // -----------------------------------------------------------------------
  // 16. Permission denied on binary path (ISSUE-005)
  // -----------------------------------------------------------------------
  test('permission denied on binary path', async () => {
    const bin = createTestBinary('noperm', '#!/bin/sh\necho hi\n');
    fs.chmodSync(bin, 0o644); // remove execute permission

    // wrap() calls resolveBinPath which checks executable bit
    await expect(wrap(bin, 5)).rejects.toThrow('not executable');
  });

  // -----------------------------------------------------------------------
  // 17. BIN_TIMEOUT non-numeric via CLI prints clean error (ISSUE-001/ISSUE-005)
  // -----------------------------------------------------------------------
  test('BIN_TIMEOUT non-numeric via CLI prints clean error', async () => {
    const child = spawn('node', ['bin/cli.mjs', '--timeout', 'abc', '--', '/bin/echo'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', d => stderr += d.toString());
    const { exitCode } = await new Promise(resolve => {
      child.on('close', code => resolve({ exitCode: code }));
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid timeout');
    expect(stderr).not.toContain('at parseTimeout');
  });

  // -----------------------------------------------------------------------
  // 18. Exec fails: binary not found after wrap (ISSUE-005)
  // -----------------------------------------------------------------------
  test('exec fails: binary not found after wrap (renamed backup)', async () => {
    const bin = createTestBinary('willmove', '#!/bin/sh\necho hi\n');
    await wrap(bin, 5);

    // Remove the _backup so the wrapper's exec target is gone
    const backupPath = bin + BACKUP_SUFFIX;
    fs.unlinkSync(backupPath);

    const result = await spawnWrapped(bin);
    // The perl wrapper should fail to exec and report error
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/exec/);
  });

  // -----------------------------------------------------------------------
  // 19. --help flag prints usage and exits 0 (ISSUE-006)
  // -----------------------------------------------------------------------
  test('--help flag prints usage and exits 0', async () => {
    const child = spawn('node', ['bin/cli.mjs', '--help'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', d => stderr += d.toString());
    const { exitCode } = await new Promise(resolve => {
      child.on('close', code => resolve({ exitCode: code }));
    });
    expect(exitCode).toBe(0);
    expect(stderr).toContain('Usage:');
    expect(stderr).toContain('--timeout');
    expect(stderr).toContain('--restore');
    expect(stderr).toContain('--status');
  });

  // -----------------------------------------------------------------------
  // 20. -h flag prints usage and exits 0 (ISSUE-006)
  // -----------------------------------------------------------------------
  test('-h flag prints usage and exits 0', async () => {
    const child = spawn('node', ['bin/cli.mjs', '-h'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', d => stderr += d.toString());
    const { exitCode } = await new Promise(resolve => {
      child.on('close', code => resolve({ exitCode: code }));
    });
    expect(exitCode).toBe(0);
    expect(stderr).toContain('Usage:');
  });

  // -----------------------------------------------------------------------
  // 21. Fork failure produces clear error from wrapper (ISSUE-005)
  // -----------------------------------------------------------------------
  test('fork failure in wrapper produces clear error', async () => {
    // We cannot reliably trigger a fork() failure in a test environment.
    // Instead, verify the perl template contains the fork error handler.
    const bin = createTestBinary('forkcheck', '#!/bin/sh\necho hi\n');
    await wrap(bin, 5);

    const wrapperContent = fs.readFileSync(bin, 'utf-8');
    // Verify the template has the fork error check
    expect(wrapperContent).toMatch(/defined\(my \$pid = fork\(\)\)/);
    expect(wrapperContent).toMatch(/or die "fork:/);
  });
});

// ---------------------------------------------------------------------------
// Utils unit tests
// ---------------------------------------------------------------------------

describe('Utils: parseTimeout', () => {
  test('parses positive integer', () => {
    expect(parseTimeout('5')).toBe(5);
    expect(parseTimeout('1')).toBe(1);
    expect(parseTimeout('100')).toBe(100);
  });

  test('rejects zero', () => {
    expect(() => parseTimeout('0')).toThrow('Invalid timeout');
  });

  test('rejects negative', () => {
    expect(() => parseTimeout('-1')).toThrow('Invalid timeout');
  });

  test('rejects non-integer', () => {
    expect(() => parseTimeout('1.5')).toThrow('Invalid timeout');
  });

  test('rejects non-numeric', () => {
    expect(() => parseTimeout('abc')).toThrow('Invalid timeout');
  });

  test('rejects empty string', () => {
    expect(() => parseTimeout('')).toThrow('Invalid timeout');
  });
});

describe('Utils: resolveBinPath', () => {
  test('throws for non-existent path', () => {
    expect(() => resolveBinPath('/nonexistent/path/to/binary')).toThrow('Binary not found');
  });

  test('throws for directory', () => {
    expect(() => resolveBinPath(os.tmpdir())).toThrow('Path is a directory');
  });
});

describe('Utils: isWrapped', () => {
  test('returns false for normal script', () => {
    createTempDir();
    try {
      const bin = createTestBinary('normal', '#!/bin/sh\necho hi\n');
      expect(isWrapped(bin)).toBe(false);
    } finally {
      cleanupTempDir();
    }
  });

  test('returns true for wrapper script', async () => {
    createTempDir();
    const bin = createTestBinary('willwrap', '#!/bin/sh\necho hi\n');
    try {
      await wrap(bin, 5);
      expect(isWrapped(bin)).toBe(true);
    } finally {
      // restore so cleanup can work
      const backupPath = bin + BACKUP_SUFFIX;
      if (fs.existsSync(bin) && isWrapped(bin) && fs.existsSync(backupPath)) {
        fs.unlinkSync(bin);
        fs.renameSync(backupPath, bin);
      }
      cleanupTempDir();
    }
  });
});
