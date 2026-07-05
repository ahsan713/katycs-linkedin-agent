# KATYCS Content Agent v2.0

Fully server-side LinkedIn content automation. Runs 24/7 on Coolify.
No browser tab needed. Every Saturday at 8:00 AM CST it auto-generates
posts and pushes them to Publer. Posts publish Mon/Wed/Fri automatically.

## Architecture

```
Coolify VPS
└── katycs-agent (Node.js, port 3100)
    ├── Express server → serves dashboard at agent.katycs.com
    ├── SQLite DB → stores all post history, settings, push logs
    ├── Cron scheduler → fires every Saturday 8:00 AM CST
    ├── Anthropic API → generates posts (server-side, no CORS)
    └── Publer API → pushes posts (server-side, no CORS)
```

## Coolify Deployment (20 minutes)

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Add: KATYCS Content Agent v2"
git remote add origin https://github.com/ahsan713/katycs-agent.git
git push -u origin main
```

### Step 2 — Create app in Coolify

1. Log into Coolify → New Resource → Application
2. Source: GitHub → select katycs-agent repo
3. Build pack: Dockerfile (auto-detected)
4. Port: 3100
5. Domain: agent.katycs.com
   - Add DNS A record → your VPS IP
   - Coolify handles SSL via Let's Encrypt automatically

### Step 3 — Set Environment Variable

In Coolify app settings → Environment Variables:
```
ANTHROPIC_API_KEY = sk-ant-your-actual-key
```

### Step 4 — Configure Persistent Storage

In Coolify app settings → Persistent Storage:
- Add volume: /app/data → stores SQLite database
- This ensures your post history survives container restarts

### Step 5 — Deploy

Click Deploy. Build takes ~2 minutes.

### Step 6 — Verify

Visit https://agent.katycs.com — dashboard should load.
Visit https://agent.katycs.com/api/health — should return {"status":"ok"}

### Step 7 — Connect Publer

In the dashboard → Setup tab:
1. Anthropic key is already set via env var
2. Enter your Publer Business API key → click Connect
3. Agent automatically fetches your workspace and LinkedIn account IDs
4. Saves everything to the database

### Step 8 — Enable Saturday Auto-Run

Dashboard → toggle "Saturday Auto-Run" to ON.
Done. The agent runs every week without any input.

---

## Manual Operations

**Push immediately:** Dashboard → "Generate & Push — 1 Week"

**Single post:** Dashboard → Generate tab → select pillar → Generate Post → Push to Publer

**View history:** Dashboard → History tab

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | /api/health | Health check |
| GET | /api/settings | Get current settings (no keys returned) |
| POST | /api/settings | Save settings |
| POST | /api/publer/connect | Connect Publer (fetches workspace/account IDs) |
| POST | /api/generate | Generate a single post |
| POST | /api/generate-and-push | Generate batch + push to Publer |
| GET | /api/history | Get post history |
| GET | /api/push-log | Get push run history |
| PATCH | /api/posts/:id | Update post status/impressions |

---

## Security Notes

- Anthropic key stored as environment variable (never in DB)
- Publer key stored in SQLite DB with no logging
- Dashboard has no authentication by default
- To add auth: set DASHBOARD_PASSWORD env var (basic auth will be enabled)
- All API calls to Anthropic and Publer are server-side — no CORS issues
