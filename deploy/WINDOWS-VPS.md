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
   - Under **Redirects**, add `https://instance-cashout.buffsquad.net/auth/discord/callback`
     (and only that one) and **Save**.
   - Click **Reset Secret** and copy the **Client Secret**. Part 3 puts it in the settings file
     on the VPS. Never commit it or share it.
3. If the Client ID changes (a new Discord app), update `DISCORD_CLIENT_ID` in the settings
   file and the default in `deploy/windows/setup.ps1`.

Sign-in runs on the server: Discord sends a one-time code to `/auth/discord/callback`, the
server trades it for the profile using the secret, and the browser only gets our own session
cookie. No bot token is needed.

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
4. Open the settings file, paste the Discord client secret after `DISCORD_CLIENT_SECRET=`, save:

   ```powershell
   notepad C:\instancecashout\instancecashout.env
   ```

   Then restart: `C:\instancecashout\bin\restart.cmd`

## Part 4: Check it works

1. Open `https://instance-cashout.buffsquad.net` and sign in with Discord.
2. Submit tracking with photos for a test order, and check it shows on the dashboard.
3. `https://aco.buffsquad.net` should still work as before.

## Part 5: Turn off GitHub Pages

The old static copy on GitHub Pages can't save shipments. On GitHub: the InstanceCashout
repo → **Settings** → **Pages** → set **Source** to **None** (or unpublish the site).

## Admin dashboard

`https://instance-cashout.buffsquad.net/admin.html` manages the buy list members see on the
Sell tab: add, edit, hide or delete products, change cashout and quantity in the table, and
upload product images. To get access, open it while signed in: it shows your Discord ID. Add
that to `ADMIN_DISCORD_IDS=` in `C:\instancecashout\instancecashout.env` (comma-separated for
several people), then run `C:\instancecashout\bin\restart.cmd`. Admins also get an **Admin**
link in the dashboard header.

The **Orders** tab lists every sell order: who's sending it, items and total, tracking (linked
to the carrier) and packing photos. Mark an order received, then paid, or cancel it; each
change is recorded with who made it, and the member sees the new status on their dashboard.

### Live package tracking

The Orders tab can ask FedEx, UPS and USPS where each package is: **Update tracking** in an
order, **Update all tracking** for every package on its way, and an automatic check every 3
hours. Members see the same status on their Shipments tab. Each carrier needs its own keys in
`C:\instancecashout\instancecashout.env` (a carrier left blank just shows its tracking link):

```
FEDEX_TRACK_API_KEY=
FEDEX_TRACK_SECRET=
UPS_TRACK_CLIENT_ID=
UPS_TRACK_CLIENT_SECRET=
USPS_CLIENT_ID=
USPS_CLIENT_SECRET=
```

- FedEx: a developer.fedex.com project with **Basic Integrated Visibility**, production keys.
- UPS: a developer.ups.com app with a subscription tier (Free for Shippers includes Tracking).
- USPS: since April 2026 USPS only tracks packages under your own mailer ID unless you've
  signed their tracking access agreement (API Access Control helpdesk, 1-877-672-0007).

Restart after editing (`C:\instancecashout\bin\restart.cmd`). `C:\instancecashout\logs\app.log`
says at startup which carriers are on.

The buy list is saved in `C:\instancecashout\data\uploads\_catalog` and orders in
`C:\instancecashout\data\uploads\_orders`; both are in the nightly backup.

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
