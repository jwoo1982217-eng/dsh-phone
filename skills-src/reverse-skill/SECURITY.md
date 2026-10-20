# Security policy and trust boundaries

## Reporting a vulnerability

Use a [private GitHub security advisory](https://github.com/zhaoxuya520/reverse-skill/security/advisories/new) for vulnerabilities in executable scripts, bootstrap/install paths, CI, MCP bridges, or credential handling. Do not include live credentials or third-party target data in a public issue.

## Repository trust model

The repository contains two different surfaces:

- **Executable surface:** scripts, CI workflows, the Burp bridge, and build tooling. These may create files, install explicitly selected tools, start local services, or update an explicitly selected MCP client configuration.
- **Passive research surface:** Markdown/JSON playbooks and payload corpora. These files are not invoked by bootstrap or routing scripts, but their exploit signatures may trigger antivirus products.

Repository instructions cannot technically prevent a user or external AI client from bypassing the provided entry scripts and calling a tool directly. The enforced boundary covers repository-owned route/case/bootstrap paths; external clients and MCP servers retain their own permission and policy controls.

## Payload corpus and antivirus detections

`skills/pentest-tools/src-hunter/references/payloader/` contains non-executable security research strings. In particular, `waf-bypass.md` includes PHP/image-polyglot and encoded web-shell examples that can match malware signatures. Do not disable antivirus protection merely to make a clone succeed.

Use Git object inspection when a working-tree file is quarantined, keep payload access explicit and scope-gated, and review any corpus hash change before release. The current investigation is documented in [the 2026-09-03 security review](docs/SECURITY-REVIEW-2026-09-03.md).

## Required checks

```text
python3 skills/scripts/verify-repository-security.py
python3 skills/scripts/verify-doc-links.py
powershell -File skills/scripts/verify-routing-coherence.ps1
powershell -File skills/scripts/smoke.ps1
```

CI additionally validates the Gradle Wrapper with the official Gradle action. Auto-install capabilities remain restricted to `bootstrap-manifest.json`; manual commercial tools are never downloaded automatically.
