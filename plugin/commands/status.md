---
description: Show Supermemory authentication and connection status
allowed-tools: ["Bash", "Read"]
---

# Supermemory Status

Report the user's Supermemory status using the installed plugin's settings and API helpers:

1. Resolve the key through `hooks/lib/settings.js` (`getApiKey`) so environment, project configuration and this home's credentials use the same precedence as the hooks. Report the source without printing the key.
2. Resolve the namespace through `hooks/lib/container-tag.js` (`getContainerTag`) for the current repository. Keep its value unchanged.
3. Probe connectivity with `hooks/lib/api.js` (`getProfile`), using `getBaseUrl`, the resolved key and namespace, and no query. This sends one POST to `/ns/{URL-encoded namespace}/profile` with `{}`. Use the native Node runtime for this host. Print only HTTP status, whether the profile is readable, and the static/dynamic fact counts; do not print memory content or credentials.
4. A readable response means the API path works. For 401/403, report the HTTP status and authentication failure. For 429 or a quota error, report the service response and stop further calls to Supermemory. For timeout, connection errors, malformed profiles or 5xx responses, report the failure without describing the profile as empty. Never infer backend health from a stored key alone.
5. If the Supermemory MCP server is connected, use its available account-status tool to check that path too. Stop here if the API probe already reported a limit. Report API and MCP results separately.

Report authentication, key source, the current namespace, API connectivity and MCP connectivity. If no key is available, explain that a new session can start the official browser login, or the user can set `SUPERMEMORY_CC_API_KEY` in this home.
