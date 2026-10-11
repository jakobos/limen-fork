---
kind: codebase
source: sbx v0.47.0 on the seat (WSL2, Ubuntu 24.04)
gathered: 2026-10-11
---

# sbx CLI as checked on this seat

Every line below was run on this machine. Use only this syntax.

- Global network policy is `balanced` (owner choice): package registries reach (`npm install` works); other hosts get 403 from the proxy. `limen app` never changes policy.
- Create (leaves the sandbox running, no session attached):
  `sbx create --name <N> --cpus <n> --memory <8g> -e K=V … shell <worktree> [<path>:ro …]`
  First create on a machine pulls the image (about 2 min). Later creates take about 5 s.
- Each workspace mounts at the same absolute path. `:ro` mounts read-only (`touch` → `Read-only file system`).
- Run a command: `sbx exec <N> bash -lc '<cmd>'`. It returns the command's exit code (`exit 7` → 7). `-d` is not supported.
- A background process outlives `exec`: `bash -lc 'nohup node server.js >/tmp/dev.log 2>&1 &'` keeps serving. `docker compose up -d` also works (Docker 29.8.1 inside; each sandbox has its own daemon).
- Publish: `sbx ports <N> --publish <port>` prints `Published 127.0.0.1:<host> -> <port>/tcp4`; the host port is chosen by the OS.
- Read ports: `sbx ports <N> --json` → `[{"host_ip","host_port","sandbox_port","protocol"}]`.
- List: `sbx ls --json` → `{"sandboxes":[{"name","id","agent","status","ports","workspaces","cpus","memory",…}]}`; `sbx ls -q` → names, one per line; "No sandboxes found." text only in the non-JSON form.
- Remove: `sbx rm -f <N>` (about 0.7 s).
- The `shell` image has `node`, `npm`, `git`, and `docker`.
- A service must listen on `0.0.0.0` inside the sandbox.
