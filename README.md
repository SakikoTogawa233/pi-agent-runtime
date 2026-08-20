# @sakiko233/pi-agent-runtime

Shared audited runtime mechanisms for child Pi processes used by `pi-subagent` and
`pi-agent-fusion`.

This is an ordinary ESM library. It is **not** a Pi package and declares no Pi resources,
extensions, tools, commands, prompts, skills, themes, renderers, task registry, or UI.

## Install

```bash
npm install @sakiko233/pi-agent-runtime
```

Consumers must also provide compatible Pi host peers:

```bash
npm install @earendil-works/pi-ai @earendil-works/pi-coding-agent
```

## Exports

- `@sakiko233/pi-agent-runtime/canonical` — canonical JSON and SHA-256 helpers.
- `@sakiko233/pi-agent-runtime/durable-fs` — private durable writes, atomic replacement, and path containment.
- `@sakiko233/pi-agent-runtime/launch` — Pi executable resolution, argv checks, and direct child launch capture.
- `@sakiko233/pi-agent-runtime/protocol` — strict JSONL and prefixed child-frame encoding/parsing.
- `@sakiko233/pi-agent-runtime/context` — parent session snapshots and visible-conversation projection.
- `@sakiko233/pi-agent-runtime/token-budget` — shared UTF-8 token-estimation mechanisms.
- `@sakiko233/pi-agent-runtime/oauth` — strict ModelRegistry OAuth observation.
- `@sakiko233/pi-agent-runtime/anthropic-attribution` — the single child-Agent Anthropic attribution and sanitization implementation.

The root export re-exports the complete public runtime surface.

## Strict runtime contracts

- Canonical JSON and JSONL encoders reject values JSON would omit or coerce.
- Anthropic callers must supply an explicit cache-retention policy and explicit cache capability flags.
- Anthropic timeout and retry options are enforced; malformed or incomplete SSE sequences settle as errors.
- Token-family resolution accepts only the frozen calibrated model set. Strict or provable estimation must be selected explicitly for other inputs.
- Child completion does not succeed until stdin finishes and the child closes; stdin failures reject completion.
- Parent active-tool exclusion requires the exact tool-call id.

## Ownership boundary

This package owns mechanisms only. Delegate and Fusion policies, artifact schemas, public tools,
commands, workflows, task lifecycle, notifications, and UI belong to their user-facing packages.

See `THIRD_PARTY_NOTICES.md` for extracted ISC code and sanitization-rule attribution.
