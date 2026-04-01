# @lionad/bin-timeout-wrapper

One-command timeout protection for any binary. Transparent, reversible, zero config.

```bash
npx @lionad/bin-timeout-wrapper -- /path/to/unstable-binary
```

**important**: Mac only, relies on `perl alarm` for timeouts.

## Why

主要用来修复我的 Mac 的一个异常问题。

VSCode 曾有个困扰我许久的问题，他会调用 rg（ripgrep）来做全局搜索，但似乎偶尔会死循环，吃满我的 CPU。

但通过设置 followSymlink 设置没有效果，而 rg 死循环出现得很随机，所以我不想花大量时间做插件的二分排查。

鉴于没有操作系统级别的 debug 技能，所以我才使用这种“兽医手术”的下策：在 rg 上套一层超时保护，超时后自动 kill。

## Usage

### Wrap（加超时）

```bash
npx @lionad/bin-timeout-wrapper --timeout 5 -- /path/to/binary
```

This creates a shell wrapper at the original path and moves the real binary to `{binary}_backup`. The wrapper uses `perl alarm` to enforce the timeout — no extra dependencies on macOS.

Output:

```
Wrapped: /path/to/binary
  Backup: /path/to/binary_backup
  Timeout: 5s (override with BIN_TIMEOUT env var)
```

### Restore（还原）

```bash
npx @lionad/bin-timeout-wrapper --restore -- /path/to/binary
```

Removes the wrapper and restores the original binary from backup.

### Status（查看状态）

```bash
npx @lionad/bin-timeout-wrapper --status -- /path/to/binary
```

Checks whether a binary is currently wrapped.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `BIN_TIMEOUT` | `5` | Timeout in seconds. Set at runtime to override the wrap-time default. |

```bash
# Use 10s timeout for a specific invocation
BIN_TIMEOUT=10 rg "search pattern"
```

## Real-World Example

```bash
# working too long...
rg -j12 -uuu --max-depth 999 "." ~/Library

# so wrap it with a timeout 5s for testing
npx @lionad/bin-timeout-wrapper --timeout 1 -- $(which rg)

# now it died after 5s instead of "working forever"
rg -j12 -uuu --max-depth 999 "." ~/Library

# restore it back to normal if you want
npx @lionad/bin-timeout-wrapper --restore -- $(which rg)
```

## How It Works

1. **Backup**: Moves the original binary to `{name}_backup`
2. **Replace**: Creates a shell script at the original path that wraps execution with `perl alarm`
3. **Proxy**: The wrapper forwards all arguments and I/O to the real binary
4. **Timeout**: If execution exceeds the limit, `perl` sends SIGKILL (exit code 137)

The wrapper script itself is ~10 lines of POSIX sh + perl — both standard on macOS.

## Options

```
--timeout N    Timeout in seconds (default: 5)
--restore      Restore the original binary
--status       Check wrap status
--help         Show usage information
```

## License

MIT
