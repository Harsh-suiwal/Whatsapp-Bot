# WhatsApp Bot

A small self-hosted WhatsApp automation tool with a browser dashboard. It sends scheduled messages, auto-replies to keywords, runs custom commands from your "Message yourself" chat, and logs reactions. Everything runs on your own machine.

Built with Node.js, Express, [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) and node-cron.

> **Disclaimer:** This uses an unofficial WhatsApp Web library. It is not affiliated with WhatsApp or Meta, and automating an account can get the number restricted or banned. Use it at low volume, only with people who expect your messages, and test on a spare number first.

## Features

- **Contacts:** save names and numbers once, reuse them everywhere.
- **Scheduled messages:** pick a contact, time (IST) and days. Each schedule has an on/off toggle.
- **Auto-replies:** keyword rules per contact, or for any saved contact. Supports `|` for alternatives and `^ok$` for exact matches.
- **Commands:** type `/login` (or any command you define) in your "Message yourself" chat and the bot sends the matching message to the chosen contact. `{time}` inserts the current time, and `/cmds` lists all commands.
- **Reaction logging and replies:** logs when a saved contact reacts to your message, with an optional emoji-triggered text reply (set in `server.js`).
- **Send now:** one-off messages from the dashboard.
- **Pause today:** skips scheduled sends until midnight.
- **Random send delay:** scheduled sends go out a random number of seconds after the set time.
- **Activity log:** every send, skip, reply and failure.
- **Self-recovery:** restarts the process on browser/session errors (works with pm2).

## Requirements

- Node.js 18 or newer
- Google Chrome, Chromium or Brave installed
- A WhatsApp account you can link as a device

## Setup

```bash
git clone https://github.com/Harsh-suiwal/Whatsapp-Bot.git
cd Whatsapp-Bot
npm install
```

Create a `.env` file (see `.env.example`):

```
WA_PASSWORD=pick-a-long-random-password
```

Open `server.js` and set the browser path near the top:

```js
const BROWSER_PATH = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
```

Use your own Chrome or Brave path. The port (`7000`) and timezone (`Asia/Kolkata`) are in the same block.

## Run

```bash
node server.js
```

On the first run a QR code appears in the terminal. Scan it from WhatsApp > Linked Devices > Link a device. The session is saved in `.wwebjs_auth/`, so you only scan once.

Then open `http://localhost:7000`. The browser asks for a login: leave the username empty or type anything, and enter `WA_PASSWORD` as the password.

### Keep it running with pm2

```bash
npm i -g pm2
pm2 start server.js --name wa-bot
pm2 save
```

| Command | What it does |
| --- | --- |
| `pm2 stop wa-bot` | Stop |
| `pm2 restart wa-bot` | Restart (after editing `server.js`) |
| `pm2 logs wa-bot` | Live logs |
| `pm2 list` | Show status |
| `pm2 resurrect` | Bring back the saved process list after a reboot |

pm2's auto-start does not work on Windows. To start it at login, put a shortcut to a `.bat` file containing `cd /d <project folder>` and `call pm2 resurrect` in `shell:startup`.

Edits to `public/index.html` only need a page refresh. Edits to `server.js` need a restart.

## Using the dashboard

**Number format:** for an Indian number, type the 10 digits and `91` is added automatically. For any other country, type the full number with the country code. `+`, spaces and dashes are stripped. The number must be on WhatsApp.

**Auto-reply patterns:**

| Pattern | Matches |
| --- | --- |
| `thanks\|thank you` | a message containing either phrase |
| `^ok$\|^okay$` | a message that is exactly "ok" or "okay" |

Rules are checked top to bottom, and the first match wins. The bot only replies to saved contacts.

**Reaction replies:** edit the `REACTION_REPLIES` object in `server.js`, for example `{ '🙏': 'Welcome!' }`. Leave it empty to log reactions only. There is a per-contact cooldown so the bot cannot spam. Note that it applies to every saved contact.

## Project structure

```
.
├── server.js          # bot, scheduler and API
├── public/
│   └── index.html     # dashboard
├── .env.example       # copy to .env
├── data.json          # created at runtime (contacts, schedules, rules)
└── .wwebjs_auth/      # created at runtime (your WhatsApp session)
```

`data.json` and `.wwebjs_auth/` are created automatically and are listed in `.gitignore`.

## Security notes

- **Never commit `.env`, `data.json` or `.wwebjs_auth/`.** The auth folder is a live login to your WhatsApp account.
- The dashboard listens on `0.0.0.0` so a phone on the same network can open it. It uses HTTP Basic auth over plain HTTP, so use it only on a network you trust, and pick a unique password. To keep it laptop-only, change the listen address in `server.js` to `127.0.0.1`.
- If a session or password leaks, unlink the device under WhatsApp > Settings > Linked Devices and change the password.

## Limitations

- The machine must be on, awake and online at send time. Messages missed while it was off are not sent later.
- Open WhatsApp on your phone at least every two weeks, or the linked session expires.
- whatsapp-web.js can break when WhatsApp Web changes. If it stops working, run `npm update whatsapp-web.js` and restart.
- 1:1 chats only. Groups are ignored.

## License

See [LICENSE](LICENSE).