# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

### Windows session coordinator

Managed work uses `prepare_managed_work` and a visible user-confirmed card before submitting through the original local-work Source and Engine. Only new live human master messages supply the model tool's instruction; no history import or model-side confirmation is available. Native composers expose an explicit register-work action alongside ordinary chat. Continuations preserve the original work ID, executor and native binding; unknown or busy unbound sessions are never acquired. V1 is text-only and read-only. The ledger is derived from Engine Tickets and reports, including ended work; prior completion is not proof that a new follow-up ran.

The local fork supports native Codex conversations alongside Engine Tickets. `CODEX_CLI_PATH` (then `CODEX_APP_SERVER_EXE`) explicitly selects a binary; a missing override fails rather than falling back. Without an override, the newest installed desktop-app binary is preferred over the npm shim. Existing native conversations retain their model and permissions; creating a native conversation is not Engine task admission.

New and existing Codex inputs accept up to four PNG/JPEG/GIF/WebP images, 10 MB each. New conversations send typed `localImage` inputs rather than filenames in text. `@` offers indexed project folders; the master uses native folder chips, while external Codex inputs insert quoted paths. Folder references contain metadata, not file contents or execution/write authority. Private state directories are excluded.

Disabled execution retains read-only project/session discovery, Engine binding, activity, deferred-input listing and knowledge tools. Empty Ticket lists do not describe all native work. The loopback, same-origin `POST /session-hub/api/diagnostics/vision` requires `{ "confirmed": true }` and performs one fixed synthetic image request to OpenAI Luna through the configured provider, without starting user Sessions or tools. It verifies image metadata and successful stream completion independently of Engine execution.

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
