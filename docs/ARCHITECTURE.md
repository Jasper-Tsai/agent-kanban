# Architecture

Agent Kanban provides one shared work store to its browser, command-line, and agent clients. Every client reaches the same Hono API and SQLite database.

## System view

~~~mermaid
flowchart LR
  Browser[Web browser] -->|REST| API[Hono API]
  Browser -->|SSE updates| API
  CLI[kb CLI] -->|REST with actor token| API
  Agents[Codex and Claude Code] -->|Streamable HTTP MCP| API
  WebAgent[WebMCP-capable browser client] --> Browser
  Hook[SessionStart inbox hook] -->|session brief request| API
  Dispatcher[Optional local dispatcher] -->|SSE and comment polling| API
  Dispatcher -->|launches a configured client CLI| Agents
  API --> DB[(SQLite)]
  API -->|publishes events| Browser
~~~

The browser is built with React, Vite, and dnd-kit. The server is built with Hono and Node.js and serves both the REST API and the compiled browser application. SQLite stores projects, cards, comments, notes, and event records. Live changes are published over Server-Sent Events.

## Components

| Path | Responsibility |
| --- | --- |
| **server/** | HTTP routes, authentication, request validation, persistence, migrations, task briefs, seed import, MCP transport, and backups. |
| **shared/** | Types, status and actor definitions, ordering helpers, and shared WebMCP tool definitions. |
| **src/** | Browser application, routing, state, UI components, local time formatting, and WebMCP registration. |
| **cli/kb.mjs** | Dependency-free command-line client for cards, projects, comments, notes, and handoffs. |
| **scripts/hooks/** | SessionStart hook that requests the project brief and open comments for the current repository path. |
| **dispatcher/** | Optional local process that observes open comments and starts a configured agent CLI to prepare replies. |
| **scripts/** | Installers, secret-generation helpers, database backup, and hook utilities. |
| **test/** | Unit, integration, browser helper, MCP, and CLI tests. |

## Core records

- A project groups related cards and stores a project-level handoff note and repository path.
- A card tracks a title, description, status, assigned agent, priority, blocked state, owner question, tags, due date, and ordering position.
- A card note records progress or a handoff. A handoff note begins with **[handoff]**.
- A comment thread has an owner-authored root, an optional target of **codex**, **claude**, or **any**, and agent replies. Threads move through **open**, **answered**, and **resolved**.
- The core identities are **codex**, **claude**, **owner**, and **none**. Event records can also identify **webmcp** and **system** actors.

Card status values are **backlog**, **todo**, **in_progress**, **review**, and **done**. The blocked column is derived in the browser from the card's blocked flag; it is not an additional database status.

Timestamps are stored as UTC ISO 8601 values. The server timezone defaults to UTC and is configurable with **KANBAN_TIMEZONE**. The browser formats dates using the browser's local timezone.

## Request and event flow

1. The browser authenticates with the application password and receives a signed session cookie.
2. The browser uses the REST API for reads and writes. Successful changes are stored in SQLite and published through the SSE stream.
3. The **kb** client sends a Bearer token. The server maps the token hash to the **codex** or **claude** actor.
4. MCP clients send authenticated Streamable HTTP requests to **/mcp**. The server exposes the shared project, card, note, handoff, and comment tools.
5. A WebMCP-capable browser client can discover the public tool metadata and invoke tools from the active browser context. WebMCP uses the authenticated browser session and actor header instead of a separate API token.
6. A SessionStart hook sends the client identity and working directory to the session-brief endpoint. The server matches the directory to the longest registered project repository path and returns its handoff, active cards, and assigned open comments.
7. If enabled, the local dispatcher watches the event stream and polls the comment inbox, then launches the selected local client CLI for a constrained reply job. The web server does not start agent processes.

## Authentication boundaries

Browser sessions and agent tokens are separate.

- The browser login uses a scrypt password hash. The server signs a session token with **KANBAN_SESSION_SECRET**; the cookie is HTTP-only, Secure by default, and SameSite Lax.
- The browser cookie is issued for 400 days and refreshed after a day of use. The signed token does not have a server-side expiry. Rotating **KANBAN_SESSION_SECRET** invalidates all browser sessions.
- API token values are shown once by the token generator. The server stores SHA-256 hashes and maps each token to its **codex** or **claude** actor.
- MCP accepts Bearer authentication and uses a stateless POST transport. It does not use browser cookies.
- Cookie-authenticated writes require the application request header or a same-origin request.
- Forwarded client-address headers are used for login rate limiting only when **KANBAN_TRUST_PROXY=1**. Enable this only behind a trusted proxy.

Keep server secrets in the private environment file. Keep plain client tokens in access-controlled client configuration. Do not commit either.

## Storage and operations

The database file is **kanban.db** under **KANBAN_DATA_DIR**. Migrations are applied at startup. When the database contains no projects, the server imports the JSON file configured by **KANBAN_SEED_FILE**; the included file supplies fictional demo data.

The application also creates consistent SQLite backups under the data directory. The backup helper can be run manually in a container with:

~~~sh
docker compose exec agent-kanban node scripts/backup-db.mjs
~~~

Back up the database volume before upgrades or migrations. Restore the database while the app is stopped, then start the service and check **/api/v1/health**.

## Main routes and protocols

| Interface | Endpoint or route | Use |
| --- | --- | --- |
| Browser app | **/**, **/board**, **/p/:projectId**, **/activity** | Overview, board, project board, and activity timeline. |
| REST API | **/api/v1** | Browser and CLI reads and writes. |
| Event stream | **/api/v1/stream** | Live updates using Server-Sent Events. |
| Card brief | **/api/v1/cards/:id/brief** | Task context for a card. |
| Session brief | **/api/v1/session-brief** | Project context selected from a client identity and working directory. |
| MCP | **/mcp** | Stateless Streamable HTTP tools for connected clients. |
| WebMCP metadata | **/.well-known/webmcp** | Public tool metadata without application data. |
| Health | **/api/v1/health** | App and database health check. |

## Design principles

- Store task context with the task so another client or session can resume from a brief and handoff.
- Keep the browser, CLI, MCP, hook, and dispatcher on shared server validation and persistence rules.
- Keep public metadata separate from authenticated project data.
- Keep dispatcher execution local and optional. A deployment that only uses the browser, CLI, MCP, or WebMCP does not need the dispatcher.
- Use UTC for persisted timestamps, a configurable server timezone for scheduled work, and browser-local formatting for displayed dates.

