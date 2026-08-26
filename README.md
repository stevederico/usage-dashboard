<div align="center">
  <h1>Quota</h1>
  <h3>Local CLI usage on one page</h3>
</div>

<br />

Reads usage from the CLIs already signed in on this machine. Nothing is uploaded.

| Plan | Source |
|---|---|
| Cursor Ultra | Cursor app token in `state.vscdb` |
| SuperGrok Heavy | `grok` CLI billing (`~/.grok/auth.json`) |
| Claude Max 5x | Claude Code `~/.claude.json` (run `/usage` in `claude` to refresh) |
| OpenCode | `opencode db` (shown only if the binary is installed) |

## Run

```bash
cd ~/Desktop/projects/quota
bun run start
```

Frontend: http://localhost:5173
Backend: http://localhost:8000

If Grok shows expired, run `grok login`. If Claude is stale, open `claude` and run `/usage`.
