# OpenCode NInfer tool-error recovery

OpenCode 2.0.16 local extension for this fork's explicit `tool_call_parse_error`.
Install this directory as a local extension through OpenCode configuration, then reload the
location while its sessions are idle. The extension targets provider `ninfer`, model
`qwen3.8-27b-quasar-w4a4`; it does not change inference settings or replace the Ollama
length-continuation extension.

The retry hook vetoes OpenCode's blind transport retries for this exact error (other failures keep
their existing retry policy). After execution has failed, it checks the actual assistant error, sends a corrective synthetic
prompt, and resumes. Each genuine prompt has a durable two-attempt budget shared across tool
progress and extension reloads. A third matching error creates a visible non-resuming notice.
Ordinary final answers, malformed examples in assistant text, unrelated provider errors, completed
tool calls, different models, user interruption, stale messages and new user input do not trigger
recovery. It never executes generated text directly. Audits contain only IDs and counters under
`~/.local/state/opencode/ninfer-tool-recovery`.

Run the contract tests with `node --test recovery.test.js`.
