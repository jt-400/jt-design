---
id: 20260513-unify-agent-runtime-abstraction
name: Unify Agent Runtime Abstraction
status: researched
created: '2026-05-13'
---

## Overview

### Problem Statement

- Agent runtime 差异目前仍暴露到上层调用路径中，上层模块仍可能需要感知具体 runtime 的协议、事件格式、parser、handler、stdout 形态或能力差异。
- 一个已知例子：`server.ts` 中对 `claude-stream-json`、`qoder-stream-json`、`copilot-stream-json`、`pi-rpc`、`acp-json-rpc`、`json-event-stream` 和 plain stdout 的显式处理。

### Goals

- 重构代码，统一 agent runtime 抽象 `RuntimeAdapter`。
- 将不同 agent runtime 的差异性封装到底层模块中。
- 让上层逻辑无需感知具体 runtime 的协议、parser、handler、事件格式或输出形态。
- 现有的文件结构、AgentRuntimeDef 等尽量不改动，避免大范围的文件搬迁或变量重命名，防止引发大量合并冲突。

### Success Criteria

- 上层入口基于统一 runtime 定义调度 agent。
- 新增或调整 agent runtime 时，主要改动集中在底层 runtime 定义或适配模块。
- `server.ts` 和其他上层模块不再承担按具体 runtime、协议、parser、handler 或输出格式分支的职责。

## Research

### Summary

- 当前最主要的上层耦合点在 `apps/daemon/src/server.ts`：chat spawn path 需要直接读取 `def.streamFormat` / `def.eventParser` / `def.promptViaStdin`，并按 Claude、Qoder、Copilot、Pi RPC、ACP、json-event-stream、plain stdout 分支接入不同 parser/session handler。Source: `apps/daemon/src/server.ts:3787-3867`, `apps/daemon/src/server.ts:4036-4176`
- `server.ts` 还需要理解不同 runtime 的 lifecycle 差异：哪些 structured stream 要启用 substantive-output tracking、Pi/ACP session 如何挂到 run 以支持 abort、ACP forced SIGTERM 何时算成功、Claude failure diagnostics 何时触发。Source: `apps/daemon/src/server.ts:4061-4078`, `apps/daemon/src/server.ts:4174-4176`, `apps/daemon/src/server.ts:4192-4264`
- Critique Theater 的 prompt 组合和 spawn routing 都感知 `streamFormat === 'plain'`，导致上层业务逻辑需要知道哪些 runtime 输出 wrapper protocol、哪些 runtime 可被 critique parser 直接消费。Source: `apps/daemon/src/server.ts:3060-3138`, `apps/daemon/src/server.ts:3923-4034`
- prompt/spawn 周边逻辑仍感知 runtime 传输形态：stdin mode 由 `promptViaStdin` 或 `acp-json-rpc` 决定，SSE start payload 暴露 `streamFormat`，json-event-stream handler 由 `def.eventParser || def.id` 选择 parser kind。Source: `apps/daemon/src/server.ts:3790-3799`, `apps/daemon/src/server.ts:3808-3841`, `apps/daemon/src/server.ts:4155-4167`
- 已有 parser/session 模块本身相对独立，但统一入口尚未把“如何 attach stdout/stdin、如何 emit agent events、如何报告 fatal/abort/completion”封装为 runtime-level adapter contract。Source: `apps/daemon/src/claude-stream.ts:1-30`, `apps/daemon/src/json-event-stream.ts:376-421`, `apps/daemon/src/acp.ts:398-569`, `apps/daemon/src/pi-rpc.ts:315-529`

### Existing System

- Web/daemon 的架构边界已经把 agent CLI 调度放在 daemon：web 负责 UI 且保持 stateless，daemon 检测 agents、注册 skills、管理 artifacts 并 broker REST/SSE。Source: `docs/spec.md:85-90`, `apps/AGENTS.md:7-18`
- 架构文档描述的目标形态是 daemon 维护 agent adapter pool，并在生成流程中以 `system/user/cwd` 调用 agent adapter、再把 agent events 流回 web。Source: `docs/architecture.md:113-129`, `docs/architecture.md:187-226`
- 设计文档中的 adapter 接口目标是 `detect()`、`capabilities()`、`run(params): AsyncIterable<AgentEvent>`、`cancel()`，并把事件统一为 thinking/tool/text/error/done 等形态。Source: `docs/agent-adapters.md:13-69`
- 当前实现中的 runtime 定义集中在 `RuntimeAgentDef`，包含 CLI 二进制、版本参数、`buildArgs(...)`、`streamFormat`、`promptViaStdin`、`eventParser`、模型发现、能力和 prompt 预算字段。Source: `apps/daemon/src/runtimes/types.ts:37-68`
- 当前 registry 只是聚合各 runtime definition 并提供 `getAgentDef(id)`；新增 runtime 需要在 registry import 并加入 `AGENT_DEFS`。Source: `apps/daemon/src/runtimes/registry.ts:1-48`
- runtime definition 已承载部分底层差异：Claude 使用 stdin prompt 和 `claude-stream-json`；Codex 使用 stdin prompt、`json-event-stream` 和 `eventParser: 'codex'`；Pi 使用 RPC mode、stdin prompt、`pi-rpc` 和 image 支持。Source: `apps/daemon/src/runtimes/defs/claude.ts:38-70`, `apps/daemon/src/runtimes/defs/codex.ts:33-82`, `apps/daemon/src/runtimes/defs/pi.ts:50-95`
- agent spawn 路径仍在 `server.ts` 中基于 `def.streamFormat` 决定 stdin mode、spawn env、SSE start payload、stdout/stderr handlers、structured parser/session attachment 和 close-status 处理。Source: `apps/daemon/src/server.ts:3787-3867`, `apps/daemon/src/server.ts:4036-4176`, `apps/daemon/src/server.ts:4192-4268`
- Critique Theater eligibility 目前在 prompt composer 和 spawn path 都显式基于 `streamFormat === 'plain'`；非 plain adapters 会跳过 orchestrator 并走 legacy generation。Source: `apps/daemon/src/server.ts:3060-3138`, `apps/daemon/src/server.ts:3923-4034`

### Design Inputs

- parser/handler 已按协议拆成独立模块：Claude JSONL parser 将 Claude stream-json 映射为 UI-friendly events；Qoder parser 独立处理 adapter-specific wrapper objects；Copilot parser 把 dotted top-level types 映射为相同 UI 事件。Source: `apps/daemon/src/claude-stream.ts:1-30`, `apps/daemon/src/qoder-stream.ts:1-12`, `apps/daemon/src/copilot-stream.ts:1-31`
- `json-event-stream` 已经是多 parser-kind 分发器，支持 `opencode`、`gemini`、`cursor-agent`、`codex`，并输出统一 event sink；`server.ts` 仍负责传入 `def.eventParser || def.id`。Source: `apps/daemon/src/json-event-stream.ts:376-421`, `apps/daemon/src/server.ts:4155-4167`
- ACP 和 Pi 不是简单 stdout parser：ACP session 通过 JSON-RPC 初始化/session/prompt、处理权限请求和 model selection；Pi session 发送 `prompt` RPC、映射 agent events，并返回 `hasFatalError()`/`abort()` 给 run lifecycle。Source: `apps/daemon/src/acp.ts:398-569`, `apps/daemon/src/pi-rpc.ts:315-529`
- spawn command invocation 已有通用 helper：`resolveAgentLaunch` 处理 executable resolution 和 Codex native binary 特例；`execAgentFile` 通过 `@open-design/platform` 的 `createCommandInvocation` 执行 agent 文件。Source: `apps/daemon/src/runtimes/launch.ts:15-49`, `apps/daemon/src/runtimes/invocation.ts:8-29`
- runtime tests 已覆盖 adapter-specific argv 和 protocol fields，例如 ACP runtimes 声明 `acp-json-rpc`，Pi 声明 `pi-rpc`、stdin prompt 和 image support。Source: `apps/daemon/tests/runtimes/agent-args.test.ts:148-175`
- prompt budget tests 依赖 runtime definition 的 `streamFormat` 和 `maxPromptArgBytes`；DeepSeek 作为 plain runtime 仍必须保留 prompt argv budget guard。Source: `apps/daemon/tests/runtimes/prompt-budget.test.ts:7-17`, `apps/daemon/tests/runtimes/prompt-budget.test.ts:37-68`
- Critique spawn wiring tests 固化了当前 `streamFormat === 'plain'` gating，并列出非 plain formats：`claude-stream-json`、`qoder-stream-json`、`copilot-stream-json`、`json-event-stream`、`acp-json-rpc`。Source: `apps/daemon/tests/critique-spawn-wiring.test.ts:174-214`

### Constraints & Dependencies

- 仓库边界要求 CLI/agent argument definition changes 放在 `apps/daemon/src/runtimes/defs/`，stdout parser changes 放在匹配 runtime helpers 和 parser tests；app tests 必须在 `apps/daemon/tests/`。Source: `apps/AGENTS.md:12-18`, `apps/AGENTS.md:27-32`
- Adapter source layout 文档要求每个 adapter 独立模块，让社区新增 adapter 不需要触碰 core daemon code；当前代码还未达到该目录形态。Source: `docs/agent-adapters.md:298-319`
- daemon 不应提升 agent 权限；Codex/Cursor 由 workspace sandbox 限制，Qoder 由 cwd 和显式 absolute `--add-dir` 限制。Source: `docs/agent-adapters.md:291-297`
- ACP model detection 和 ACP session 包含明确的超时、错误和 recoverable model selection 分支；统一抽象需要保留这些协议级 lifecycle/failure semantics。Source: `apps/daemon/src/acp.ts:350-388`, `apps/daemon/src/acp.ts:492-528`
- Pi image forwarding 有文件类型、数量、总大小和 realpath upload-root 检查；统一抽象不能绕过这些 runtime-specific safety checks。Source: `apps/daemon/src/pi-rpc.ts:399-449`
- 当前 close handler 对 structured stream errors、empty-output guard、ACP forced SIGTERM clean completion 和 Claude failure diagnostics 有集中逻辑；抽象边界需要保留 run status 的 fail-fast/visible error 行为。Source: `apps/daemon/src/server.ts:4061-4078`, `apps/daemon/src/server.ts:4192-4264`

### Key References

- `apps/daemon/src/runtimes/types.ts:37-68` - 当前 runtime definition schema。
- `apps/daemon/src/runtimes/registry.ts:1-48` - runtime registry 聚合点。
- `apps/daemon/src/server.ts:3060-3138,3770-4268` - prompt eligibility、spawn、protocol branch、stream handling 和 close lifecycle 的上层耦合点。
- `apps/daemon/src/claude-stream.ts:1-30`, `apps/daemon/src/qoder-stream.ts:1-12`, `apps/daemon/src/copilot-stream.ts:1-31`, `apps/daemon/src/json-event-stream.ts:376-421`, `apps/daemon/src/acp.ts:398-569`, `apps/daemon/src/pi-rpc.ts:315-529` - 现有协议/parser/session 模块。
- `docs/agent-adapters.md:13-69,298-319` - 目标 adapter interface 和 source layout。
- `apps/daemon/tests/runtimes/agent-args.test.ts:148-175`, `apps/daemon/tests/runtimes/prompt-budget.test.ts:7-68`, `apps/daemon/tests/critique-spawn-wiring.test.ts:174-214` - 现有测试覆盖的 runtime/protocol invariants。

## Design

<!-- Technical approach, architecture decisions, and test strategy. Each design decision should cite a fact source. -->

## Plan

<!-- Optional: Step breakdown for complex features that need multiple implementation steps.
     Decided during Design. Checked off during Implement.
     Keep this section compact and step-based.
     Use markdown checkboxes for all step and substep items, for example:
     - [ ] Step 1: Foo
       - [ ] Substep 1.1 Implement: Foo foundation
       - [ ] Substep 1.2 Implement: Foo integration
       - [ ] Substep 1.3 Implement: Foo edge handling
       - [ ] Substep 1.4 Verify: Foo automated coverage
       - [ ] Substep 1.5 Verify: Foo manual workflow
     - [ ] Step 2: Bar
       - [ ] Substep 2.1 Implement: Bar
       - [ ] Substep 2.2 Verify: Bar
     - [ ] Step 3: Baz
       - [ ] Substep 3.1 Implement: Baz
       - [ ] Substep 3.2 Verify: Baz
     Use a capability-based step breakdown with reviewable, meaningful increments.
     Good boundaries align with one user-visible workflow, one subsystem/integration boundary, one migration/rollout step, or one stabilization milestone.
     Each step must include small, independent substeps for implementation and immediate testing/verification.
     Within each step, list implementation substeps before verification substeps.
     The final step may focus on overall testing/verification, edge cases, regression coverage, and coverage improvements.
     A step is complete only when relevant tests pass.
     Size steps so one coding agent can implement + validate in a single session.
     Write each substep as one small, independent task. -->

## Notes

<!-- Optional sections — add what's relevant. -->

### Implementation

<!-- Files created/modified, decisions made during coding, deviations from design -->

### Verification

<!-- How the feature was verified: tests written, manual testing steps, results -->
