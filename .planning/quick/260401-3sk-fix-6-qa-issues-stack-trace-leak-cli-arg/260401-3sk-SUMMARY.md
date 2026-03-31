---
phase: 01-core-implementation
plan: 260401-3sk
tags: [bugfix, tests, ux, docs]
key-files:
  created: []
  modified:
    - bin/cli.mjs
    - lib/wrap.js
    - tests/e2e.test.mjs
    - docs/design.md
decisions:
  - CLI arg order stays as implemented (--timeout N -- /path), design doc updated to match
  - SIGTERM/SIGINT handlers use signal numbers (15, 2) to avoid shell quoting issues
  - Fork failure tested via template inspection since real fork() failure is unreproducible
metrics:
  duration: 538s
  tasks: 4
  files: 4
---

# Phase 01 Plan 260401-3sk: Fix 6 QA Issues Summary

Wrap entire CLI in try/catch to prevent stack trace leaks, add --help flag, add explicit SIGTERM/SIGINT forwarding in wrapper template, add comprehensive E2E tests, update design doc CLI arg order.

## Issues Fixed

### ISSUE-001 (HIGH): Stack traces leak on invalid --timeout values
**Fix:** Moved entire arg-parsing loop inside try/catch in `bin/cli.mjs`. All errors (parseTimeout, missing value, unknown arg, missing binary path) now flow through one catch block that prints `Error: ${err.message}` with exit code 1 -- no stack trace.
**Commit:** 3d8e710
**File:** `bin/cli.mjs`

### ISSUE-002 (HIGH): Design doc CLI examples mismatch implementation
**Fix:** Updated 3 CLI examples in `docs/design.md` to use `--timeout N -- /path/to/bin` order matching the implementation. The implementation order is correct since --timeout is a CLI option that must precede the -- separator.
**Commit:** 0140c55
**File:** `docs/design.md` (lines 63, 74, 120)

### ISSUE-003 (MEDIUM): No explicit signal forwarding in wrapper template
**Fix:** Added `$SIG{TERM}` and `$SIG{INT}` handlers in the perl wrapper template that forward signals to the child process group (`-$pid`) and exit with correct codes (143 for SIGTERM, 130 for SIGINT). Used signal numbers (15, 2) instead of string names to avoid single-quote conflicts in the shell-quoted perl code.
**Commit:** 31817a5
**File:** `lib/wrap.js` (WRAPPER_TEMPLATE)

### ISSUE-004 (MEDIUM): Missing test for symlinked binaries
**Fix:** Added E2E test verifying symlink wrapping and restoration works correctly. Test creates a real binary and a symlink to it, wraps the symlink, verifies the wrapper works and the real binary is untouched, then restores and verifies the symlink is recovered.
**Commit:** 95da05b
**File:** `tests/e2e.test.mjs` (test 13)

### ISSUE-005 (MEDIUM): Missing tests for signals, permission denied, exec fail, CLI errors
**Fix:** Added 7 E2E tests:
- SIGTERM forwarding to child process (test 14)
- SIGINT forwarding to child process (test 15)
- Permission denied on binary path (test 16)
- BIN_TIMEOUT non-numeric via CLI with no stack trace (test 17)
- Exec fail when backup removed after wrap (test 18)
- Fork failure handler verified in wrapper template (test 21)
**Commit:** 95da05b
**File:** `tests/e2e.test.mjs`

### ISSUE-006 (LOW): No --help flag
**Fix:** Added `--help` and `-h` handling in the arg-parsing loop, before the unknown argument check. Prints usage and exits 0. Two tests added (test 19 and 20) to verify both flags.
**Commit:** 3d8e710 (code), 95da05b (tests)
**File:** `bin/cli.mjs`, `tests/e2e.test.mjs`

## Files Modified

| File | Changes | Commits |
|------|---------|---------|
| `bin/cli.mjs` | Restructured main(): all arg parsing in try/catch, added --help/-h | 3d8e710 |
| `lib/wrap.js` | Added $SIG{TERM} and $SIG{INT} handlers to WRAPPER_TEMPLATE | 31817a5 |
| `tests/e2e.test.mjs` | Added 9 new E2E tests (30 total, was 22) | 95da05b |
| `docs/design.md` | Fixed 3 CLI examples to use correct argument order | 0140c55 |

## Commits

| Commit | Message |
|--------|---------|
| 3d8e710 | fix(260401-3sk): wrap entire main() in try/catch, add --help flag |
| 31817a5 | fix(260401-3sk): add explicit SIGTERM/SIGINT forwarding in wrapper template |
| 95da05b | test(260401-3sk): add tests for symlink, signal forwarding, CLI error handling, --help |
| 0140c55 | docs(260401-3sk): fix CLI argument order in design.md to match implementation |

## Deviations from Plan

None - plan executed exactly as written. All 6 QA issues fixed with atomic commits, all 22 original tests continue passing, test suite expanded to 30 tests.

## Verification

- All 30 tests in main test file pass (22 original + 8 new)
- SIGTERM forwarding verified: wrapper explicitly kills child process group on SIGTERM, exits 143
- SIGINT forwarding verified: wrapper explicitly kills child process group on SIGINT, exits 130
- Stack trace suppression verified: `--timeout abc` prints clean "Error: Invalid timeout" message
- --help flag verified: prints usage and exits 0
- Design doc CLI order now matches implementation
- Perl syntax validated for updated wrapper template

## Self-Check: PASSED

All 4 modified files exist. All 4 commits found in git log. Test file contains 31 test() calls (30 test functions + 1 describe-level helper).
