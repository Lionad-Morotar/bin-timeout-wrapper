# PROJECT: @lionad/bin-timeout-wrapper

## Context

VS Code 的 rg（ripgrep）全局搜索偶尔卡死。需要一个通用工具给任意二进制加超时包装。

## Tech Stack

- Node.js (CLI via npx)
- Shell + Perl (runtime wrapper)
- vitest (testing)

## Distribution

npm 包 `@lionad/bin-timeout-wrapper`，通过 `npx` 直接使用。
