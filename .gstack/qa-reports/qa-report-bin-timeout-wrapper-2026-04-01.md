# QA Report: @lionad/bin-timeout-wrapper

**Date:** 2026-04-01
**Branch:** feature
**Commits tested:** b325a88..139ce7b (5 commits)
**Test framework:** vitest (22 E2E + utils unit tests)
**Duration:** ~10 min

---

## Summary

| Category | Score | Weight | Weighted |
|----------|-------|--------|----------|
| Console | 100 | 15% | 15.0 |
| Functional | 55 | 20% | 11.0 |
| Tests | 70 | 15% | 10.5 |
| UX | 65 | 15% | 9.8 |
| Edge Cases | 70 | 15% | 10.5 |
| CLI Interface | 60 | 10% | 6.0 |
| Code Quality | 85 | 10% | 8.5 |
| **Total** | | **100%** | **71** |

**Health Score: 71/100**

22/22 tests pass. Core wrap/restore/status flow works. But CLI argument parsing has a design doc mismatch and stack traces leak on bad input.

---

## Issues Found: 6

### ISSUE-001 (HIGH): Stack traces leak on invalid --timeout values

**Category:** Functional | **Severity:** High

`parseTimeout()` is called OUTSIDE the try/catch in `cli.mjs`. Invalid timeout values produce raw Node.js stack traces.

```
$ node bin/cli.mjs --timeout abc -- /bin/echo
file:///...lib/utils.js:57
    throw new Error(`Invalid timeout: ${value}. Must be a positive integer.`);
          ^
Error: Invalid timeout: abc. Must be a positive integer.
    at parseTimeout (file:///...lib/utils.js:57:11)
    at main (file:///...bin/cli.mjs:61:17)
    ...
```

**Expected:** Clean error message like `Error: Invalid timeout: abc. Must be a positive integer.`

**Repro:**
1. `node bin/cli.mjs --timeout abc -- /bin/echo`
2. Observe raw stack trace

**Root cause:** `cli.mjs:61` calls `parseTimeout(next)` inside the arg-parsing loop, but the try/catch at line 77 only wraps the dispatch section (wrap/restore/status calls), not the argument parsing.

---

### ISSUE-002 (HIGH): --timeout after -- separator silently ignored

**Category:** Functional | **Severity:** High

Design doc shows this CLI order:
```bash
npx @lionad/bin-timeout-wrapper -- /path/to/bin --timeout 5
```

Implementation requires this order:
```bash
npx @lionad/bin-timeout-wrapper --timeout 5 -- /path/to/bin
```

When following the design doc order, `--timeout N` is silently ignored (everything after `--` is treated as the binary path and skipped). User gets the default 5s timeout, which masks the bug when N=5.

**Repro:**
1. `node bin/cli.mjs -- /tmp/testbin --timeout 10`
2. Check status: shows timeout 5 (default), not 10

**Impact:** User thinks they set a 10s timeout but got 5s. If the design doc order is intentional, the CLI must parse --timeout after --. If the implementation order is correct, update design.md.

---

### ISSUE-003 (MEDIUM): No explicit signal forwarding in wrapper template

**Category:** Functional | **Severity:** Medium

The perl wrapper only installs a SIGALRM handler. SIGTERM and SIGINT are NOT explicitly forwarded to the child process.

```perl
$SIG{ALRM} = sub { kill 9, -$pid };
alarm $timeout;
waitpid($pid, 0);
```

Manual test shows SIGTERM forwarding works via OS default behavior (perl dies, child in same session receives signal). But this is implicit, not guaranteed across all scenarios (e.g., detached processes, CI environments).

**Test plan requirement (engine-review.md):**
- SIGTERM to wrapper -> forwarded as SIGTERM to child
- SIGINT to wrapper -> forwarded as SIGINT to child

Both are untested.

---

### ISSUE-004 (MEDIUM): Missing test: symlinked binaries

**Category:** Tests | **Severity:** Medium

Engine review test plan specifies "Binary path is symlink -> works correctly" but no test covers this.

Manual verification: symlink wrapping works (symlink replaced with wrapper, real binary untouched, restore recovers symlink correctly). But no automated regression protection.

---

### ISSUE-005 (MEDIUM): Missing tests: signal forwarding, BIN_TIMEOUT non-numeric via CLI

**Category:** Tests | **Severity:** Medium

From engine-review.md, these test cases are untested:
- SIGTERM to wrapper -> forwarded to child
- SIGINT to wrapper -> forwarded to child
- Permission denied on binary path
- BIN_TIMEOUT=abc (non-numeric) via CLI (only tested as parseTimeout unit test)
- exec fails in child (binary not found after rename)
- fork() fails

---

### ISSUE-006 (LOW): No --help flag

**Category:** UX | **Severity:** Low

Users cannot run `--help` or `-h` to see usage info. Usage is only printed on error (unknown argument or missing binary path).

```bash
$ node bin/cli.mjs --help
Error: Unknown argument: --help
```

---

## Top 3 Things to Fix

1. **Move parseTimeout into try/catch** (ISSUE-001) - Wrap the entire argument parsing loop in try/catch so all errors produce clean messages instead of stack traces.

2. **Resolve CLI argument order ambiguity** (ISSUE-002) - Either: (a) parse --timeout after -- separator to match design doc, or (b) update design.md to match current implementation. Recommend (a).

3. **Add explicit signal forwarding to wrapper template** (ISSUE-003) - Install SIGTERM/SIGINT handlers in the perl parent that forward signals to the child process group.

---

## Test Coverage vs Engine Review

| Engine Review Requirement | Status |
|---------------------------|--------|
| Wrap binary with timeout | PASS |
| Restore original binary | PASS |
| Check wrap status | PASS |
| Normal execution within timeout | PASS |
| Timeout exceeds -> SIGKILL 137 | PASS |
| BIN_TIMEOUT env overrides default | PASS |
| BIN_TIMEOUT=0 disables timeout | PASS |
| SIGTERM forwarded to child | NOT TESTED (manual: works) |
| SIGINT forwarded to child | NOT TESTED |
| Duplicate wrap rejected | PASS |
| Path with spaces works | PASS |
| Symlink works | NOT TESTED (manual: works) |
| Binary not found -> clear error | PASS |
| Path is directory -> clear error | PASS |
| Permission denied -> clear error | NOT TESTED |
| _backup collision handled | PASS |
| BIN_TIMEOUT=abc -> graceful | PASS (unit only, CLI leaks trace) |
| Rapid wrap/restore sequence | PASS |

**Coverage: 13/18 requirements verified by tests, 2 more verified manually, 3 untested**

---

## Files Reviewed

| File | Lines | Role |
|------|-------|------|
| bin/cli.mjs | 108 | CLI entry point |
| lib/wrap.js | 52 | Wrap logic + perl template |
| lib/restore.js | 16 | Restore logic |
| lib/status.js | 19 | Status check |
| lib/utils.js | 61 | Shared helpers |
| tests/e2e.test.mjs | 354 | 22 E2E + utils tests |

---

*Report generated by /qa-only on 2026-04-01*
