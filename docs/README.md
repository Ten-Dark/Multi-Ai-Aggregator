# Project Documentation

## Architecture and roadmap

- [Browser Integration Architecture](./BROWSER_INTEGRATION_ARCHITECTURE.md) — canonical user-browser-first design for browser discovery, multi-profile connectors, permissions, provider readiness, and safe self-healing.
- [Browser Integration Roadmap](./BROWSER_INTEGRATION_ROADMAP.md) — implementation phases, tasks, dependencies, and acceptance criteria.
- [ADR 0001 — User-Browser-First Integration](./adr/0001-user-browser-first-integration.md) — accepted decision and rejected alternatives.
- [Provider Runtime Architecture](./PROVIDER_RUNTIME_ARCHITECTURE.md) — legacy proposal for app-owned sessions and provider automation; its app-owned-session-first host decision is superseded by the Browser Integration Architecture.
- [Provider Runtime Roadmap](./PROVIDER_RUNTIME_ROADMAP.md) — legacy provider automation/session workstream; browser-host decisions are governed by the Browser Integration Roadmap.
- [Provider Runtime Readiness Baseline](./PROVIDER_RUNTIME_BASELINE.md) — current diagnostic evidence, readiness blockers, and go/no-go decision.
- [Zen Extension Packaging](./ZEN_EXTENSION_PACKAGING.md) — reproducible XPI build and manual update/pairing procedure.
- [Cancellation Protocol](./CANCELLATION_PROTOCOL.md) — current task cancellation contract across Main, Zen Bridge, Extension, Content Script, preload, and Renderer.

## Current implementation baseline

The Provider Runtime architecture and roadmap are planning documents. They do not indicate that app-owned sessions or the proposed automation improvements have already been implemented. The current cancellation protocol remains the implemented execution contract until a later phase explicitly migrates it.\n
