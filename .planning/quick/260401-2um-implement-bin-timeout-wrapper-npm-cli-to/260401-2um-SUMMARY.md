---
phase: quick
plan: 260401-2um
subsystem: cli-tooling
tags: [node.js, perl, shell, cli, npx, timeout, process-management]

# Dependency graph
requires: []
provides:
  - "@lionad/bin-timeout-wrapper npm CLI tool"
  - "Binary wrap/restore/status operations"
  - "Perl alarm-based timeout wrapper with SIGKILL exit 137"
affects: [binary-timeout]

# Tech tracking
tech-stack:
  added: [vitest, node.js-esm]
  patterns: [perl-fork-exec-alarm, process-group-kill, backup-rename-wrapper]

key-files:
  created:
    - package.json
    - bin/cli.mjs
    - lib/wrap.js
    - lib/restore.js
    - lib/status.js
    - lib/utils.js
    - tests/e2e.test.mjs
  modified: []

key-decisions:
  - "Used setpgrp + kill(-$pid) for process group kill to ensure shell script children are also terminated"
  - "Used exec { $cmd[0] } @cmd perl syntax to prevent indirect shell interpretation for paths with spaces"
  - "Used buffer scan instead of first-line check for isWrapped detection (marker is on line 2)"

patterns-established:
  - "Backup-rename pattern: rename original to _backup, write wrapper to original path"
  - "Perl fork/exec/alarm pattern: fork child in new process group, parent sets alarm and kills group on timeout"

requirements-completed: [CORE-01, CORE-02, CORE-03]

# Metrics
duration: 15min
completed: 2026-03-31
---

# Quick Task 260401-2um: bin-timeout-wrapper Implementation Summary

**Perl alarm-based binary timeout wrapper CLI with fork/exec process group kill, wrap/restore/status commands, and 22 passing E2E tests**

## Performance

- **Duration:** 15 min
- **Started:** 2026-03-31T18:07:51Z
- **Completed:** 2026-03-31T18:22:57Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Complete npm CLI tool `@lionad/bin-timeout-wrapper` with wrap, restore, and status commands
- Perl alarm wrapper template that kills entire process group (exit code 137) on timeout
- BIN_TIMEOUT env var support for runtime timeout override and BIN_TIMEOUT=0 to disable
- 22 rigorous E2E tests covering all critical paths and edge cases

## Task Commits

Each task was committed atomically:

1. **Task 1: Create package scaffold and CLI entry point** - `724010e` (feat)
2. **Task 2: Implement fork/exec perl template for correct exit code 137** - `bf35df7` (feat)
3. **Task 3: Add comprehensive E2E tests and fix process group handling** - `60029b9` (test)

## Files Created/Modified
- `package.json` - npm package with @lionad/bin-timeout-wrapper, vitest devDep
- `bin/cli.mjs` - CLI entry point parsing --timeout, --restore, --status, and -- separator
- `lib/wrap.js` - Binary wrapping logic with perl fork/exec/alarm template
- `lib/restore.js` - Binary restore logic (delete wrapper, rename backup)
- `lib/status.js` - Wrap status check extracting timeout from wrapper comments
- `lib/utils.js` - Shared helpers: isWrapped, resolveBinPath, parseTimeout
- `tests/e2e.test.mjs` - 22 E2E tests using child_process.spawn

## Decisions Made
- Used `setpgrp(0, 0)` in child + `kill 9, -$pid` in parent to kill entire process group, ensuring shell script sub-children are also terminated on timeout
- Used `exec { $cmd[0] } @cmd` perl syntax to force direct execution, preventing perl's indirect shell interpretation that breaks paths with spaces
- Changed `isWrapped` to scan the first 500 bytes for marker comment instead of checking only the first line (marker is on line 2 after `#!/bin/sh`)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed perl exec losing SIGALRM handler**
- **Found during:** Task 2 (smoke test of wrapper template)
- **Issue:** Original template used `exec @ARGV` which replaces the perl process with the binary, losing the $SIG{ALRM} handler so alarm never fires
- **Fix:** Switched to fork/exec pattern where parent perl process stays alive to handle SIGALRM and kill child
- **Files modified:** lib/wrap.js
- **Verification:** Smoke test confirmed exit code 137 after timeout
- **Committed in:** bf35df7

**2. [Rule 1 - Bug] Fixed process group kill for shell script children**
- **Found during:** Task 3 (E2E test debugging)
- **Issue:** When wrapping a shell script that spawns children (e.g., `#!/bin/sh\nsleep 30`), killing only the direct child PID leaves orphaned grandchildren. The perl alarm fires but `waitpid` hangs because the grandchild keeps the process tree alive.
- **Fix:** Added `setpgrp(0, 0)` in child process and `kill 9, -$pid` (negative PID = process group kill) in parent
- **Files modified:** lib/wrap.js
- **Verification:** All 22 E2E tests pass including timeout kill from Node.js spawn
- **Committed in:** 60029b9

**3. [Rule 1 - Bug] Fixed perl indirect exec breaking paths with spaces**
- **Found during:** Task 3 (E2E test debugging)
- **Issue:** Perl's `exec @cmd` with single-element list falls back to shell interpretation, splitting paths at spaces
- **Fix:** Used `exec { $cmd[0] } @cmd` to force direct execution bypassing shell
- **Files modified:** lib/wrap.js
- **Verification:** "path with spaces" test passes
- **Committed in:** 60029b9

**4. [Rule 1 - Bug] Fixed isWrapped checking only first line instead of scanning buffer**
- **Found during:** Task 3 (E2E test debugging)
- **Issue:** Marker comment `# Auto-generated by @lionad/bin-timeout-wrapper` is on line 2 (after `#!/bin/sh`), but isWrapped only checked line 1
- **Fix:** Changed to scan first 500 bytes using `includes()` instead of comparing first line
- **Files modified:** lib/utils.js
- **Verification:** All status/duplicate-wrap/restore tests pass
- **Committed in:** 60029b9

---

**Total deviations:** 4 auto-fixed (4 bugs)
**Impact on plan:** All auto-fixes necessary for correctness. No scope creep. The plan's template design was a starting point; real process behavior on macOS required the fork/exec + process group pattern.

## Issues Encountered
- Original plan template used `exec @ARGV` which replaces perl process, losing SIGALRM handler. Required redesign to fork/exec pattern.
- Shell script children are not killed by targeting only the direct child PID. Required process group management (setpgrp + kill with negative PID).
- Perl's `exec LIST` with single element uses shell indirection on macOS, breaking paths with spaces. Required `exec { $cmd[0] } @cmd` syntax.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Core CLI tool is complete and ready for npm publish
- All critical paths tested and passing
- Potential future work: Windows support, log recording for timeout events, npm publish

## Self-Check: PASSED

- All 8 source files verified present
- All 3 task commits verified in git log (724010e, bf35df7, 60029b9)
- All 22 E2E tests passing

---
*Phase: quick-task*
*Completed: 2026-03-31*
