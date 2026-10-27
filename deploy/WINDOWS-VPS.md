# Putting Instance Cashout on the Windows VPS

Instance Cashout runs on the same VPS as BUFFSQUAD, next to it:

| | BUFFSQUAD | Instance Cashout |
|---|---|---|
| Address | `https://aco.buffsquad.net` | `https://instance-cashout.buffsquad.net` |
| Folder | `C:\buffsquad` | `C:\instancecashout` |
| Port (on the VPS only) | 8000 | 8001 |
| Discord app | BUFFSQUAD | Instance Cashout (its own) |

It reuses BUFFSQUAD's Cloudflare tunnel, so set BUFFSQUAD up first (its `deploy\WINDOWS-VPS.md`).
Every minute the VPS checks GitHub; when there's a new version it tests it, switches to
it, and goes back to the old one if anything fails.

Your time: about 20 minutes.

## Part 1: Discord app (about 5 minutes)

1. Go to <https://discord.com/developers/applications> → **New Application** → name it `Instance Cashout` → **Create**.
2. **OAuth2** page:
   - Copy the **Client ID**.
   - Under **Redirects**, add both of these and **Save**:
     - `https://instance-cashout.buffsquad.net/`
     - `https://instance-cashout.buffsquad.net/index.html`
3. Paste the Client ID into `script.js` on the first line (`const DISCORD_CLIENT_ID = "...";`),
   commit and push. (The Client ID isn't a secret; it's fine in the code.)

No client secret or bot token is needed: the site signs in with Discord in the browser.

## Part 2: Cloudflare hostname (about 2 minutes)

1. In Cloudflare, open **Networking** → **Tunnels** → click the `buffsquad` tunnel.
2. In the **Routes** box, click **Add route** → **Published application**:
   - Subdomain: `instance-cashout` · Domain: `buffsquad.net` · Path: empty
   - Service type: `HTTP` · URL: `localhost:8001`
   - **Save**.

Cloudflare creates the DNS record for you. Use a single-level subdomain (a hyphen, not a dot):
Cloudflare's free certificate only covers `<name>.buffsquad.net`.

## Part 3: Set up the VPS (about 10 minutes, mostly waiting)

1. Connect to the VPS with Remote Desktop.
2. Open the Start menu, type **PowerShell**, right-click **Windows PowerShell** → **Run as administrator**.
3. Paste these three lines:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   irm https://raw.githubusercontent.com/sub7m19/InstanceCashout/main/deploy/windows/setup.ps1 -OutFile $env:TEMP\instancecashout-setup.ps1
   & $env:TEMP\instancecashout-setup.ps1
   ```

   It installs the app and the scheduled tasks, then prints **Setup finished**.
   It's safe to run again if something stops it.

## Part 4: Check it works

1. Open `https://instance-cashout.buffsquad.net` and sign in with Discord.
2. Submit tracking with photos for a test order, and check it shows on the dashboard.
3. `https://aco.buffsquad.net` should still work as before.

## Part 5: Turn off GitHub Pages

The old static copy on GitHub Pages can't save shipments. On GitHub: the InstanceCashout
repo → **Settings** → **Pages** → set **Source** to **None** (or unpublish the site).

## Day to day

| Task | How |
|---|---|
| Deploy a change | Push to `main` on GitHub. Live within about a minute |
| Restart | `C:\instancecashout\bin\restart.cmd` |
| See what happened with deploys | `C:\instancecashout\logs\deploy.log` |
| App log | `C:\instancecashout\logs\app.log` (startup crashes: `crash.log`) |
| Why a deploy was skipped | `C:\instancecashout\logs\last-tests.log` |
| Is it up, which version | `http://127.0.0.1:8001/api/health` on the VPS |
| Uploaded photos | `C:\instancecashout\data\uploads` |
| Backups | `C:\instancecashout\data\backups` (nightly at 4:30 AM, newest 14 kept) |

A version whose tests fail, or that doesn't start, is skipped and the site stays on the
previous one. Pushing a fix deploys normally.
