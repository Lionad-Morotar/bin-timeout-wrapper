---
phase: 01-core-implementation
phase: 01
plan: 01
quick task: 260401-3sk-fix-6 QA issues found in QA report
 each tied to 2 design decisions. Test coverage. E2e tests. cover all 18 engine-review test cases. E2e tests covering signal forwarding, --help flag. Update design doc to match implementation.

 order.

 No new files created. Tests must be rigorous. Do not simplify boilerplate or repetitive code. or add missing test coverage incrementally test suite to >18 tests. E2e tests covering symlink + signal forwarding, SIGTERM/SIGint to child, + --help flag. Update design doc to match implementation.

 order.

 `--timeout N` after `--` separator: matched by current implementation convention: the the design doc should be updated. This is > **ISSUE-003: Add explicit signal forwarding in wrapper template**: perl wrapper only installs `$SIG{ALRM} handler. Need to forward SIGTERM and SIGint to? child process group via setpgrp + kill process group kill. `$SIG{TERM} = sub { kill 9, -$pid; exit(15); };
  waitpid($pid, 0);
  exit($? >> 8);
 });

**ISSUE-004: Missing test: symlinked binaries.** verification: works. no automated test. Need a add tests for symlink wrapping and a restore logic. + additional test cases from engine review:

 These test cases are untested. | SIGTERM to wrapper -> forwarded to SIGTERM to child | - SIGINT to wrapper -> forwarded as SIGint to child | - Permission denied on binary path | - BIN_TIMEOUT=abc via CLI -> fails gracefully | - exec fails in child ( binary not found after rename) | - fork() fails |
 unlikely) possible)

| - BIN_TIMEOUT=abc via CLI: non-numeric `BIN_TIMEOUT=abc` produces stack trace | - `--help` flag: prints usage and exits 0 | `--timeout N` need to be a positive integer | - `--timeout 0` via CLI: 5 -> `10` wraps binary with 5s timeout |
 `--timeout 10` after `--` in design doc order) `--timeout 10 -- /path/to/bin` is more intuitive. The design doc:
 `--timeout 5 -- /path/to/bin`. Tests will verify all paths, the single commit.
 This is a a clean task. The no new test files needed to be created. All fixes are self-contained. in the modified files.
 Each modified file is annotated with the specific issue it the addresses.
 the specific issue it it the address, lines where the fix is applied. For the issue in `lib/wrap.js`, I the address lines in `lib/wrap.js:17-24` and the template - replace `{bin_path}_backup` placeholder with the actual backup path | Replace `{timeout}` placeholder with the actual timeout value.
 replace `{bin_path}_backup` in the entire template.

 Now the the wrapper content is just `WRAPPER_TEMPLATE.replaceAll('{bin_path}', resolvedPath).replaceAll('{timeout}', String(timeout));
  fs.writeFileSync(resolvedPath, wrapperContent, 'utf-8');
  fs.chmodSync(resolvedPath, 0o755);
  return { binPath: resolvedPath, backupPath, resolvedPath };
};
