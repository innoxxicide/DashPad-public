# DashPad

A wall dashboard for an Android tablet.

- Left half: clock, date, month calendar, weather for today and the next 7 days, the air-raid alert for your area, the power-outage schedule (DTEK).
- Right half: the «Ход работ» (work progress) page — your Claude Code tasks, published from your PC.
- The tablet runs in kiosk mode: the DashPad app is the Device Owner.

## What's inside

| Part | Folder | What it does |
|---|---|---|
| Backend | `worker/` | Cloudflare Worker (TypeScript, Hono, D1): data, settings, a copy of the «Ход работ» page |
| Dashboard | `dashboard/` | Vite + Preact; the Worker serves it as static assets |
| App | `android/` | Kotlin: a WebView with the dashboard, the ⚙ panel, kiosk mode, scheduled brightness |
| Publisher | `scripts/progress-publisher.py` | sends the «Ход работ» page from the PC to the Worker |
| Tablet setup | `scripts/provision.ps1` | installs the APK, makes the app the Device Owner, turns on kiosk mode |

## How to deploy

Step-by-step guide (in Russian): [docs/setup-ru.md](docs/setup-ru.md).

```
git clone https://github.com/innoxxicide/DashPad-public.git
```

## License

MIT, see [LICENSE](LICENSE).

The repository is archived: it is read-only, and issues and pull requests are not accepted.
