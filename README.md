# cctm-agent

CCTokenManager agent: watches Claude Code JSONL logs and uploads usage events to a [cctm-server](https://github.com/) instance.

## Install (macOS / Linux)
```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/cctm-agent/main/install.sh | bash
```

## Pair with a server
```bash
cctm-agent pair https://your-server.example.com
```
Opens a browser for OAuth device approval.

## Commands
```bash
cctm-agent start      # run watcher daemon
cctm-agent status     # show daemon status
cctm-agent stop
cctm-agent backfill   # re-upload historical sessions
```

## Build from source
```bash
pnpm install
pnpm build
node dist/index.js --help
```
