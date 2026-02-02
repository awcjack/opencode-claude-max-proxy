# Changelog

## [1.1.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.0.2...v1.1.0) (2026-02-01)

### Features

* **session-resumption**: Add conversation continuity support via X-Claude-Session-ID headers
  - Sessions are now tracked and can be resumed across multiple requests
  - Session IDs automatically returned in response headers
  - Supports both streaming and non-streaming modes
  - Graceful fallback when invalid/expired session IDs are provided
  - Detailed logging for session creation and resumption
  - Full documentation in [SESSION_RESUMPTION.md](./SESSION_RESUMPTION.md)

### Documentation

* Add comprehensive session resumption guide with examples
* Update README.md with session resumption feature
* Add design document for implementation

## [1.0.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.0.1...v1.0.2) (2026-01-26)


### Bug Fixes

* remove bun install from publish job ([966b2ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/opencode-claude-max-proxy/commit/cd36411193af22e779638232427dd8c49f8926e0))

## [1.0.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.0.0...v1.0.1) (2026-01-26)


### Bug Fixes

* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/opencode-claude-max-proxy/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))

## 1.0.0 (2026-01-26)


### Features

* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/opencode-claude-max-proxy/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))


### Bug Fixes

* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/opencode-claude-max-proxy/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/opencode-claude-max-proxy/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/opencode-claude-max-proxy/issues/1)
