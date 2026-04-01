import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import { wrap } from '../lib/wrap.js';
import { restore } from '../lib/restore.js';
import { status } from '../lib/status.js';
import { isWrapped, resolveBinPath, parseTimeout, BACKUP_SUFFIX } from '../lib/utils.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

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
 * Spawn the CLI with given arguments, capture stdout/stderr, return results.
 */
function spawnCLI(args) {
  return new Promise((resolve) => {
    const child = spawn('node', ['bin/cli.mjs', ...args], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ exitCode: code ?? null, stdout, stderr }));
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

// ---------------------------------------------------------------------------
// CLI integration tests
// ---------------------------------------------------------------------------

describe('CLI integration', () => {
  beforeEach(() => { createTempDir(); });
  afterEach(() => { cleanupTempDir(); });

  test('--restore via CLI restores wrapped binary', async () => {
    const bin = createTestBinary('clirestore', '#!/bin/sh\necho "original"\nexit 7\n');

    // Wrap via CLI
    const wrapResult = await spawnCLI(['--timeout', '5', '--', bin]);
    expect(wrapResult.exitCode).toBe(0);
    expect(wrapResult.stdout).toContain('Wrapped:');

    // Restore via CLI
    const restoreResult = await spawnCLI(['--restore', '--', bin]);
    expect(restoreResult.exitCode).toBe(0);
    expect(restoreResult.stdout).toContain('Restored:');
    expect(restoreResult.stdout).toContain('From backup:');

    // Verify binary works
    const result = await spawnWrapped(bin);
    expect(result.exitCode).toBe(7);
    expect(result.stdout.trim()).toBe('original');
  });

  test('--status via CLI reports wrapped and unwrapped state', async () => {
    const bin = createTestBinary('clistatus', '#!/bin/sh\necho hi\n');

    // Status before wrap
    const before = await spawnCLI(['--status', '--', bin]);
    expect(before.exitCode).toBe(0);
    expect(before.stdout).toContain('Status: not wrapped');

    // Wrap
    await spawnCLI(['--timeout', '7', '--', bin]);

    // Status after wrap
    const after = await spawnCLI(['--status', '--', bin]);
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toContain('Status: wrapped');
    expect(after.stdout).toContain('Timeout: 7s');
    expect(after.stdout).toContain('Backup:');

    // Restore
    await spawnCLI(['--restore', '--', bin]);

    // Status after restore
    const restored = await spawnCLI(['--status', '--', bin]);
    expect(restored.stdout).toContain('Status: not wrapped');
  });

  test('--timeout with valid value via CLI', async () => {
    const bin = createTestBinary('clitimeout', '#!/bin/sh\necho hi\n');
    const result = await spawnCLI(['--timeout', '3', '--', bin]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Timeout: 3s');
  });

  test('--timeout without value prints clean error', async () => {
    // When --timeout is last arg before --, "--" becomes the value
    const result = await spawnCLI(['--timeout', '--', '/bin/echo']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid timeout');
    expect(result.stderr).not.toContain('at main');
  });

  test('unknown argument prints clean error', async () => {
    const result = await spawnCLI(['--foobar', '--', '/bin/echo']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown argument: --foobar');
  });

  test('no binary path prints error with hint', async () => {
    const result = await spawnCLI([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No binary path specified');
    // Error message includes usage hint
    expect(result.stderr).toContain('-- /path/to/binary');
  });

  test('CLI wrap mode outputs formatted result', async () => {
    const bin = createTestBinary('cliwrap', '#!/bin/sh\necho hi\n');
    const result = await spawnCLI(['--timeout', '5', '--', bin]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Wrapped:');
    expect(result.stdout).toContain('Backup:');
    expect(result.stdout).toContain('Timeout: 5s');
  });

  test('--status on nonexistent binary prints clean error', async () => {
    const result = await spawnCLI(['--status', '--', '/nonexistent/binary']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Binary not found');
  });
});

// ---------------------------------------------------------------------------
// Edge case tests
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  beforeEach(() => { createTempDir(); });
  afterEach(() => { cleanupTempDir(); });

  test('status() with wrapper missing timeout comment returns null timeout', async () => {
    const bin = createTestBinary('notimeoutcomment', '#!/bin/sh\necho hi\n');

    // Wrap normally
    await wrap(bin, 5);

    // Remove the timeout comment line from the wrapper
    let content = fs.readFileSync(bin, 'utf-8');
    content = content.replace(/# Timeout: \d+s.*\n/, '');
    fs.writeFileSync(bin, content, 'utf-8');

    const result = await status(bin);
    expect(result.wrapped).toBe(true);
    expect(result.timeout).toBeNull();
  });

  test('isWrapped with unreadable file returns false', () => {
    const bin = createTestBinary('unreadable', '#!/bin/sh\necho hi\n');
    fs.chmodSync(bin, 0o000);

    // isWrapped should return false, not throw
    expect(isWrapped(bin)).toBe(false);

    // Restore permissions for cleanup
    fs.chmodSync(bin, 0o755);
  });

  test('parseTimeout accepts scientific notation as valid integer', () => {
    // Number('1e2') = 100, which is a valid positive integer
    expect(parseTimeout('1e2')).toBe(100);
  });

  test('parseTimeout accepts float-looking integer strings', () => {
    // Number('5.0') = 5, which is a valid positive integer
    expect(parseTimeout('5.0')).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// State transition edge cases
// ---------------------------------------------------------------------------

describe('State transitions', () => {
  beforeEach(() => { createTempDir(); });
  afterEach(() => { cleanupTempDir(); });

  // -----------------------------------------------------------------------
  // Re-wrap with different timeout: should be rejected
  // -----------------------------------------------------------------------
  test('wrap with timeout 5, then CLI wrap with timeout 10 is rejected', async () => {
    const bin = createTestBinary('rewrap', '#!/bin/sh\necho hi\n');

    // First wrap succeeds
    const first = await spawnCLI(['--timeout', '5', '--', bin]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('Timeout: 5s');

    // Second wrap with different timeout should fail
    const second = await spawnCLI(['--timeout', '10', '--', bin]);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain('Already wrapped');

    // Verify original timeout is unchanged
    const st = await spawnCLI(['--status', '--', bin]);
    expect(st.stdout).toContain('Timeout: 5s');
  });

  // -----------------------------------------------------------------------
  // Wrap → restore → re-wrap with different timeout: full cycle
  // -----------------------------------------------------------------------
  test('wrap → restore → re-wrap with different timeout works', async () => {
    const bin = createTestBinary('cycle', '#!/bin/sh\necho "v1"\n');

    // Wrap with timeout 3
    const w1 = await spawnCLI(['--timeout', '3', '--', bin]);
    expect(w1.exitCode).toBe(0);
    expect(w1.stdout).toContain('Timeout: 3s');

    // Restore
    const r1 = await spawnCLI(['--restore', '--', bin]);
    expect(r1.exitCode).toBe(0);

    // Re-wrap with timeout 10
    const w2 = await spawnCLI(['--timeout', '10', '--', bin]);
    expect(w2.exitCode).toBe(0);
    expect(w2.stdout).toContain('Timeout: 10s');

    // Verify new timeout is active
    const st = await spawnCLI(['--status', '--', bin]);
    expect(st.stdout).toContain('Timeout: 10s');

    // Binary still works after full cycle
    const result = await spawnWrapped(bin);
    expect(result.stdout.trim()).toBe('v1');
  });

  // -----------------------------------------------------------------------
  // Double restore: second restore fails cleanly
  // -----------------------------------------------------------------------
  test('double restore: second restore fails', async () => {
    const bin = createTestBinary('dblrestore', '#!/bin/sh\necho hi\n');

    await spawnCLI(['--timeout', '5', '--', bin]);

    // First restore succeeds
    const r1 = await spawnCLI(['--restore', '--', bin]);
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toContain('Restored:');

    // Second restore fails
    const r2 = await spawnCLI(['--restore', '--', bin]);
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toContain('No backup found');
  });

  // -----------------------------------------------------------------------
  // Restore on never-wrapped binary fails
  // -----------------------------------------------------------------------
  test('restore on never-wrapped binary fails', async () => {
    const bin = createTestBinary('neverwrap', '#!/bin/sh\necho hi\n');

    const result = await spawnCLI(['--restore', '--', bin]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No backup found');
  });

  // -----------------------------------------------------------------------
  // --restore combined with --timeout: restore wins, timeout ignored
  // -----------------------------------------------------------------------
  test('--restore --timeout 99: restore wins, timeout is ignored', async () => {
    const bin = createTestBinary('restoretimeout', '#!/bin/sh\necho "orig"\n');

    // Wrap first
    await spawnCLI(['--timeout', '5', '--', bin]);

    // Restore with --timeout (should just restore, timeout has no effect)
    const result = await spawnCLI(['--restore', '--timeout', '99', '--', bin]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Restored:');

    // Binary is restored
    const st = await spawnCLI(['--status', '--', bin]);
    expect(st.stdout).toContain('not wrapped');
  });

  // -----------------------------------------------------------------------
  // Wrap, delete backup, restore fails: partial corruption
  // -----------------------------------------------------------------------
  test('wrap then delete backup: restore fails, binary still wrapped', async () => {
    const bin = createTestBinary('nobackup', '#!/bin/sh\necho hi\n');
    await wrap(bin, 5);

    // Delete the backup file
    const backupPath = bin + BACKUP_SUFFIX;
    fs.unlinkSync(backupPath);

    // Restore should fail
    await expect(restore(bin)).rejects.toThrow('No backup found');

    // Binary is still wrapped (wrapper still in place)
    expect(isWrapped(bin)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Wrap, delete wrapper, wrap again: blocked by backup collision
  // -----------------------------------------------------------------------
  test('wrap then delete wrapper: second wrap blocked by existing backup', async () => {
    const bin = createTestBinary('delwrap', '#!/bin/sh\necho hi\n');
    await wrap(bin, 5);

    // Remove the wrapper but leave the backup
    fs.unlinkSync(bin);

    // The original binary content is in the backup, so the path no longer exists.
    // wrap() should fail because resolveBinPath can't find the file.
    // But if we recreate a file at that path...
    fs.writeFileSync(bin, '#!/bin/sh\necho new\n', 'utf-8');
    fs.chmodSync(bin, 0o755);

    // Now isWrapped(bin) is false (new file), but backup exists.
    // wrap() should reject with "Backup already exists".
    await expect(wrap(bin, 10)).rejects.toThrow('Backup already exists');
  });

  // -----------------------------------------------------------------------
  // Status on partially corrupted state (backup exists, wrapper missing)
  // -----------------------------------------------------------------------
  test('status on corrupted state: backup exists but wrapper deleted', async () => {
    const bin = createTestBinary('corrupt', '#!/bin/sh\necho hi\n');
    await wrap(bin, 5);

    // Delete the wrapper, keep backup
    fs.unlinkSync(bin);

    // status() calls resolveBinPath which fails if file doesn't exist
    const result = await spawnCLI(['--status', '--', bin]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Binary not found');
  });

  // -----------------------------------------------------------------------
  // Wrap with default timeout (no --timeout flag)
  // -----------------------------------------------------------------------
  test('CLI wrap without --timeout uses default 5s', async () => {
    const bin = createTestBinary('defaultt', '#!/bin/sh\necho hi\n');

    // No --timeout flag
    const result = await spawnCLI(['--', bin]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Timeout: 5s');

    // Verify via status
    const st = await spawnCLI(['--status', '--', bin]);
    expect(st.stdout).toContain('Timeout: 5s');
  });

  // -----------------------------------------------------------------------
  // Wrap → restore → wrap → restore: full double cycle
  // -----------------------------------------------------------------------
  test('wrap → restore → wrap → restore: double cycle preserves binary', async () => {
    const bin = createTestBinary('dblcycle', '#!/bin/sh\necho "persist"\nexit 33\n');

    // Cycle 1
    await wrap(bin, 3);
    await restore(bin);

    // Cycle 2 with different timeout
    await wrap(bin, 8);
    await restore(bin);

    // Binary content should be untouched
    const result = await spawnWrapped(bin);
    expect(result.exitCode).toBe(33);
    expect(result.stdout.trim()).toBe('persist');
  });

  // -----------------------------------------------------------------------
  // BIN_TIMEOUT invalid value via runtime: perl rejects it
  // -----------------------------------------------------------------------
  test('BIN_TIMEOUT with non-numeric value at runtime: wrapper exits with error', async () => {
    const bin = createTestBinary('badenv', '#!/bin/sh\necho hi\n');
    await wrap(bin, 5);

    const result = await spawnWrapped(bin, [], { BIN_TIMEOUT: 'not-a-number' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Invalid BIN_TIMEOUT');
  });

  // -----------------------------------------------------------------------
  // BIN_TIMEOUT negative value at runtime: perl rejects it
  // -----------------------------------------------------------------------
  test('BIN_TIMEOUT with negative value at runtime: wrapper exits with error', async () => {
    const bin = createTestBinary('negenv', '#!/bin/sh\necho hi\n');
    await wrap(bin, 5);

    const result = await spawnWrapped(bin, [], { BIN_TIMEOUT: '-1' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Invalid BIN_TIMEOUT');
  });

  // -----------------------------------------------------------------------
  // BIN_TIMEOUT very large value: wrapper still runs (no overflow)
  // -----------------------------------------------------------------------
  test('BIN_TIMEOUT with very large value: binary runs normally', async () => {
    const bin = createTestBinary('largeenv', '#!/bin/sh\necho "ok"\n');
    await wrap(bin, 5);

    const result = await spawnWrapped(bin, [], { BIN_TIMEOUT: '999999' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });
});

// -----------------------------------------------------------------------------
// New Feature Tests: --enable-log and createdAt
// -----------------------------------------------------------------------------

describe('New Features: --enable-log and createdAt', () => {
  beforeEach(() => { createTempDir(); });
  afterEach(() => { cleanupTempDir(); });

  // -----------------------------------------------------------------------
  // --enable-log: creates log file on execution
  // -----------------------------------------------------------------------
  test('wrap with --enable-log creates log file on execution', async () => {
    const bin = createTestBinary('loggedbin', '#!/bin/sh\necho "hello"\n');
    await wrap(bin, 5, true);  // enableLog = true

    // Execute the wrapped binary
    const result = await spawnWrapped(bin);
    expect(result.exitCode).toBe(0);

    // Check log file exists
    const logPath = path.join(tempDir, '.bin-timeout-wrapper.log');
    expect(fs.existsSync(logPath)).toBe(true);

    // Check log format (milliseconds timestamp)
    const logContent = fs.readFileSync(logPath, 'utf-8');
    expect(logContent).toMatch(/^\[\d{13}\] executed\n$/);
  });

  // -----------------------------------------------------------------------
  // --enable-log: multiple executions append to log
  // -----------------------------------------------------------------------
  test('multiple executions append to log file', async () => {
    const bin = createTestBinary('multiexec', '#!/bin/sh\necho "run"\n');
    await wrap(bin, 5, true);

    // Execute 3 times
    await spawnWrapped(bin);
    await spawnWrapped(bin);
    await spawnWrapped(bin);

    const logPath = path.join(tempDir, '.bin-timeout-wrapper.log');
    const logContent = fs.readFileSync(logPath, 'utf-8');
    const lines = logContent.trim().split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toMatch(/^\[\d{13}\] executed$/);
  });

  // -----------------------------------------------------------------------
  // without --enable-log: no log file created
  // -----------------------------------------------------------------------
  test('wrap without --enable-log does not create log file', async () => {
    const bin = createTestBinary('nologbin', '#!/bin/sh\necho "hello"\n');
    await wrap(bin, 5, false);  // enableLog = false (default)

    const result = await spawnWrapped(bin);
    expect(result.exitCode).toBe(0);

    const logPath = path.join(tempDir, '.bin-timeout-wrapper.log');
    expect(fs.existsSync(logPath)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // CLI: --enable-log flag works
  // -----------------------------------------------------------------------
  test('CLI --enable-log flag creates log file', async () => {
    const bin = createTestBinary('clilog', '#!/bin/sh\necho "cli"\n');

    const result = await spawnCLI(['--timeout', '5', '--enable-log', '--', bin]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Log: enabled');

    // Execute and check log
    await spawnWrapped(bin);
    const logPath = path.join(tempDir, '.bin-timeout-wrapper.log');
    expect(fs.existsSync(logPath)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // status: returns createdAt for wrapped binary
  // -----------------------------------------------------------------------
  test('status returns createdAt for wrapped binary', async () => {
    const bin = createTestBinary('withtime', '#!/bin/sh\necho "hi"\n');
    const beforeWrap = Date.now();
    await wrap(bin, 5);
    const afterWrap = Date.now();

    const st = await status(bin);
    expect(st.wrapped).toBe(true);
    expect(st.createdAt).toBeDefined();
    expect(st.createdAt).toBeInstanceOf(Date);

    // Verify the timestamp is reasonable (between before and after wrap)
    const createdTime = st.createdAt.getTime();
    expect(createdTime).toBeGreaterThanOrEqual(beforeWrap - 1000); // 1s buffer
    expect(createdTime).toBeLessThanOrEqual(afterWrap + 1000);
  });

  // -----------------------------------------------------------------------
  // status: createdAt is null for unwrapped binary
  // -----------------------------------------------------------------------
  test('status returns null createdAt for unwrapped binary', async () => {
    const bin = createTestBinary('notime', '#!/bin/sh\necho "hi"\n');

    const st = await status(bin);
    expect(st.wrapped).toBe(false);
    expect(st.createdAt).toBeNull();
  });

  // -----------------------------------------------------------------------
  // CLI status: shows createdAt in output
  // -----------------------------------------------------------------------
  test('CLI --status shows created at timestamp', async () => {
    const bin = createTestBinary('clitime', '#!/bin/sh\necho "hi"\n');
    await wrap(bin, 5);

    const result = await spawnCLI(['--status', '--', bin]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Created at:');
    expect(result.stdout).toMatch(/\d{4}\/\d{1,2}\/\d{1,2}/); // Date format like 2026/4/1
  });

  // -----------------------------------------------------------------------
  // wrapper header: contains log marker comment
  // -----------------------------------------------------------------------
  test('wrapper header contains log marker comment', async () => {
    const bin = createTestBinary('headercheck', '#!/bin/sh\necho "hi"\n');
    await wrap(bin, 5, true);

    const wrapperContent = fs.readFileSync(bin, 'utf-8');
    expect(wrapperContent).toContain('# Log: enabled');
  });

  // -----------------------------------------------------------------------
  // wrapper header: shows disabled when log is off
  // -----------------------------------------------------------------------
  test('wrapper header shows disabled when log is off', async () => {
    const bin = createTestBinary('headeroff', '#!/bin/sh\necho "hi"\n');
    await wrap(bin, 5, false);

    const wrapperContent = fs.readFileSync(bin, 'utf-8');
    expect(wrapperContent).toContain('# Log: disabled');
  });

  // -----------------------------------------------------------------------
  // --enable-log: timeout is recorded in log
  // -----------------------------------------------------------------------
  test('timeout is recorded in log with millisecond timestamp', async () => {
    const bin = createTestBinary('timeoutlog', '#!/bin/sh\nsleep 30\n');
    await wrap(bin, 2, true);  // 2 second timeout

    // Execute and let it timeout
    const { result, elapsed } = await timeAsync(() => spawnWrapped(bin));
    expect(result.exitCode).toBe(137);  // SIGKILL
    expect(elapsed).toBeLessThan(5_000);

    // Check log contains timeout entry
    const logPath = path.join(tempDir, '.bin-timeout-wrapper.log');
    expect(fs.existsSync(logPath)).toBe(true);

    const logContent = fs.readFileSync(logPath, 'utf-8');
    const lines = logContent.trim().split('\n');
    // Last line should be the timeout entry
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toMatch(/^\[\d{13}\] timeout$/);
  }, 10_000);
});
