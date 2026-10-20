# Community Issue Triage

This document records which community concerns can be addressed in-repository and which require a maintainer or platform owner.

| Issue | Assessment | Repository action |
|---|---|---|
| #21, #86 | AI safety refusal for a particular target | Added authorization-first and defensive-use guidance; this cannot override a client safety policy. |
| #44, #61 | Installation and usage questions | Added `QUICKSTART_zh.md` and linked it from both READMEs. |
| #47 | Codex/plugin integration request | Added the optional `plugins/reverse-skill/` adapter; the routing core remains client-neutral. |
| #51 | Prefer uv over pip | Added correct guidance for `uv tool install` and `uv pip` without unsafe mechanical replacement. Bootstrap still uses pinned pipx. |
| #58 | Antivirus alert | Superseded by the evidence-backed review in `docs/SECURITY-REVIEW-2026-09-03.md` and Issue #125. |
| #28, #60 | Test/low-information reports | Closed without code changes because they contain no reproducible problem. |
| #62 | iOS workflow evidence threshold | Requires a maintainer decision about workflow policy and test data rather than a blind code change. |
| #63 | Account-ban concern | Depends on third-party platform policy; users should follow applicable terms. |
| #80 | radare2-skills contribution discussion | Contribution instructions are available in `skills/CONTRIBUTING.md`; maintainers must decide scope and ownership. |
| #82 | ZIP download security warning | Covered by `docs/UV-AND-DOWNLOAD-SECURITY.md` plus the quick-start archive checklist. |
| #83 | Codex synchronization failure | Added a diagnostic checklist; a client version and reproducible case are still required for a client-side fix. |
| #77 | Analysis decision/blind-spot rules | Implemented through PRs #84 and #85 with routing/coherence regression coverage. |
| #121 | Binary Ninja MCP/HTTP support | Added `binary-ninja-reverse`, route R45, manual tool discovery, and an explicit loopback community MCP boundary. |
| #125 | Repository/payload security review | Published `SECURITY.md`, the 2026-09-03 review, Git-blob CI gates, and Gradle Wrapper verification. |
| #127 | macOS installation refusal | Covered by `docs/platforms/macos.md`, the quick start, and client-policy guidance. |
| #128 | Grok API provenance | The repository contains no Grok/xAI API client, proxy, key, or reseller endpoint; model providers are configured outside this project. |
| #87, #95, #97, #99, #100, #101, #103, #104 | Feature proposals or existing work items | These require separate design review and should not be silently duplicated by a documentation PR. |

A Pull Request should close only issues that it actually resolves. Discussion items, third-party platform behavior, and reports without reproduction details should remain open for maintainer review.
