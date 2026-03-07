# JDH Downloader

Automates Discord slash commands to fetch Just Dance asset and no-HUD video HTML from the **JDH bot**. Uses [Playwright](https://playwright.dev/) to drive a real Chromium browser, so it works with your existing Discord login.

## ⚠️ Disclaimer

> **This tool automates a Discord client (self-botting), which violates [Discord's Terms of Service](https://discord.com/terms).** Your account could be suspended or banned. **Use a throwaway/alt Discord account** — do not use your main account. The developers are not responsible for any account actions taken by Discord.

## What It Does

For a given song codename (e.g. `TemperatureALT`), the tool:

1. Opens Discord in a Chromium browser window
2. Sends `/assets jdu <codename>` and captures the bot's embed response
3. Sends `/nohud <codename>` and captures that embed response
4. Saves both as HTML files in a `<codename>/` folder

## Prerequisites

- **Node.js** 18 or later — [download](https://nodejs.org/)
- **Discord account** with access to the JDH bot's server/channel

## Setup

```bash
# 1. Clone and install dependencies
git clone https://github.com/VenB304/JDH_Downloader.git
cd JDH_Downloader
npm install

# 2. Install Chromium for Playwright
npx playwright install chromium

# 3. Create your config file
cp config.example.json config.json
```

Edit `config.json` with your Discord channel URL:

```json
{
  "channelUrl": "https://discord.com/channels/YOUR_SERVER_ID/YOUR_CHANNEL_ID",
  "profileDir": "./.browser-profile"
}
```

> **Finding your channel URL:** Open Discord in a browser, navigate to the channel where the JDH bot lives, and copy the URL from the address bar.

## Usage

**Command line:**

```bash
node fetch.mjs <codename>
```

**Windows shortcut:**

Double-click `fetch.bat` — it will prompt you for the codename.

### First Run

On the first run there is no saved session, so the browser will show the Discord login page. Log in manually — after that, your session is saved in `.browser-profile/` and subsequent runs will skip the login step.

## Output

```
<codename>/
├── assets.html   # Bot response from /assets jdu <codename>
└── nohud.html    # Bot response from /nohud <codename>
```

## Troubleshooting

| Problem | Solution |
|---|---|
| `Could not find /assets in the autocomplete` | Make sure the JDH bot is in the server and the channel is correct in `config.json` |
| `Timed out waiting for the bot response` | The bot may be offline. Try again later. |
| Browser opens but nothing happens | Delete `.browser-profile/` and re-login |
| `npx playwright install` fails | Try running as administrator, or install Chromium manually |

## License

[MIT](LICENSE)
