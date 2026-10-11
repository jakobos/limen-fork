# Frame: app sandbox

## Problem

A worker cannot run the app it is changing: there is no place to start it, call it, read its logs, or run its tests in its own environment, and running it on the host would expose the owner's credentials to dependency install scripts.

## Who it affects

Workers and the coordinator on the seat. Each job gets its own sandbox, so two jobs can run the same app with the same ports at once.

## Chosen approach

`limen app up|exec|logs|url|status|down` wraps the `sbx` CLI: one `shell` sandbox per job, the job worktree mounted at its own path, setup and start commands from `.agents/limen/sandbox.json`, ports published to OS-chosen host ports and recorded in the job folder. Agents stay on the host.

Alternatives weighed: plain Docker on the host (no isolation from `~/.ssh` or the `gh` token); a fallback to host Docker when `sbx` is missing (silently removes the isolation, so `up` refuses instead).

## Out of scope

- Running agents inside the sandbox.
- Changing `sbx` network policy or secrets; the owner manages those with `sbx policy` and `sbx secret`.
- Cloud sandboxes (`sbx --cloud`).
- Sharing images or layers between sandboxes.
