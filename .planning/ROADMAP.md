# ROADMAP: @lionad/bin-timeout-wrapper

## Project Overview

通用二进制超时包装工具。通过 `npx` 一行命令给任意二进制加超时保护，超时后 SIGKILL 并返回 137。基于 perl alarm 实现，macOS/Linux 零依赖。

## Phases

### Phase 1: Core Implementation
- Status: pending
- Goal: 完整实现 CLI 工具，包含 wrap/restore/status 功能，通过所有测试
