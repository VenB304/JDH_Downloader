import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MAP_DOWNLOADS_DIR = join(__dirname, 'output');

// Load config
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf-8'));

// Parse args
const args = process.argv.slice(2);
let useGui = false;
let batchFile = null;
const codenames = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--gui') {
    useGui = true;
  } else if (args[i] === '--batch') {
    if (i + 1 < args.length) {
      batchFile = args[i + 1];
      i++;
    } else {
      console.error('Error: --batch requires a file path');
      process.exit(1);
    }
  } else if (args[i] === '--output-dir' && i + 1 < args.length) {
    // Legacy flag used by gui_installer.py — ignored in standalone mode
    // (standalone always writes to MAP_DOWNLOADS_DIR)
    i++;
  } else {
    codenames.push(args[i]);
  }
}

if (batchFile) {
  try {
    const fileContent = readFileSync(batchFile, 'utf-8');
    const lines = fileContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    codenames.push(...lines);
  } catch (err) {
    console.error(`Error reading batch file: ${err.message}`);
    process.exit(1);
  }
}

if (!useGui && codenames.length === 0) {
  console.error('Usage: node fetch.mjs [options] <codename(s)>');
  console.error('Options:');
  console.error('  --gui             Launch the Graphical User Interface');
  console.error('  --batch <file>    Read a list of codenames from a text file');
  console.error('Example: node fetch.mjs TemperatureALT Circus');
  console.error('Example: node fetch.mjs --batch list.txt');
  console.error('Example: node fetch.mjs --gui');
  console.error(`Output folder: ${MAP_DOWNLOADS_DIR}\\<codename>\\`);
  process.exit(1);
}

const PROFILE_DIR = resolve(__dirname, config.profileDir);
const CHANNEL_URL = config.channelUrl;

// Discord DOM selectors - update these if Discord changes its UI
const SEL = {
  textbox: '[role="textbox"][data-slate-editor="true"]',
  autocompleteOption: '[role="option"]',
  messageAccessories: 'div[id^="message-accessories-"]',
};

let guiPage = null;

function logOut(msg) {
  console.log(msg);
  if (guiPage) {
    guiPage.evaluate((m) => {
      if (window.addLog) window.addLog(m);
    }, msg).catch(() => { });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForLogin(page) {
  const textbox = page.locator(SEL.textbox);

  try {
    await textbox.waitFor({ timeout: 15000 });
    logOut('  Already logged in.');
  } catch {
    logOut('');
    logOut('  +------------------------------------------+');
    logOut('  |  Please log in to Discord in the browser |');
    logOut('  |  window. Waiting up to 5 minutes...      |');
    logOut('  +------------------------------------------+');
    logOut('');
    await textbox.waitFor({ timeout: 300000 });
    logOut('  Login detected.');
    await page.waitForTimeout(3000);
  }
}

async function getLastAccessoryId(page) {
  const accessories = page.locator(SEL.messageAccessories);
  const count = await accessories.count();
  if (count === 0) return null;
  return await accessories.nth(count - 1).getAttribute('id');
}

/**
 * Send a Discord slash command by automating the command picker UI.
 */
async function sendSlashCommand(page, { command, choices = [], codename }) {
  const textbox = page.locator(SEL.textbox);

  // Focus the textbox
  await textbox.click();
  await page.waitForTimeout(200);

  // Type "/" to open the command picker, then immediately type the command name
  await page.keyboard.type('/' + command, { delay: 30 });

  // Wait for the matching command to appear in the autocomplete popup
  const cmdOption = page.locator(SEL.autocompleteOption)
    .filter({ hasText: new RegExp(command, 'i') })
    .first();

  try {
    await cmdOption.waitFor({ timeout: 8000 });
    await cmdOption.click();
    logOut(`  Selected /${command} command.`);
  } catch {
    throw new Error(
      `Could not find /${command} in the autocomplete. ` +
      'Make sure the bot is in this server and the command exists.'
    );
  }

  await page.waitForTimeout(300);

  // Handle dropdown/choice parameters (e.g. game = "jdu")
  for (const choice of choices) {
    const choiceOption = page.locator(SEL.autocompleteOption)
      .filter({ hasText: new RegExp(`^\\s*${choice}\\s*$`, 'i') })
      .first();

    try {
      await choiceOption.waitFor({ timeout: 8000 });
      await choiceOption.click();
      logOut(`  Selected choice: ${choice}`);
    } catch {
      // If exact match fails, try a looser match
      const looseOption = page.locator(SEL.autocompleteOption)
        .filter({ hasText: choice })
        .first();
      try {
        await looseOption.waitFor({ timeout: 3000 });
        await looseOption.click();
        logOut(`  Selected choice: ${choice}`);
      } catch {
        throw new Error(`Could not find "${choice}" in the parameter options.`);
      }
    }

    await page.waitForTimeout(200);
  }

  // Type the codename into the current text parameter field
  await page.keyboard.type(codename, { delay: 20 });
  logOut(`  Typed codename: ${codename}`);
  await page.waitForTimeout(200);

  // Send the command
  await page.keyboard.press('Enter');
  logOut('  Command sent.');
}

/**
 * Poll for a new message-accessories element to appear (the bot's response).
 */
async function waitForNewEmbed(page, previousLastId, timeoutMs = 60000) {
  logOut('  Waiting for bot response...');
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate((prevId) => {
      const all = document.querySelectorAll('div[id^="message-accessories-"]');
      if (all.length === 0) return null;
      const last = all[all.length - 1];
      const textContent = last.textContent || '';
      return {
        id: last.id,
        hasChildren: last.children.length > 0,
        isLoading: textContent.includes('Loading'),
      };
    }, previousLastId);

    if (result && result.id !== previousLastId && result.hasChildren && !result.isLoading) {
      let stableId = result.id;
      let stable = true;
      for (let i = 0; i < 3; i++) {
        await page.waitForTimeout(500);
        const latestResult = await page.evaluate(() => {
          const all = document.querySelectorAll('div[id^="message-accessories-"]');
          if (all.length === 0) return null;
          const last = all[all.length - 1];
          const textContent = last.textContent || '';
          return {
            id: last.id,
            hasChildren: last.children.length > 0,
            isLoading: textContent.includes('Loading'),
          };
        });
        if (!latestResult || latestResult.id !== stableId || !latestResult.hasChildren || latestResult.isLoading) {
          stable = false;
          break;
        }
      }
      if (stable) {
        logOut(`  Bot response detected (${stableId}).`);
        return stableId;
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error(
    'Timed out waiting for the bot response. ' +
    'The bot might be offline or the command may have failed.'
  );
}

async function extractHtml(page, accessoryId) {
  // Extra buffer to let any remaining embed content finish rendering
  await page.waitForTimeout(1500);

  const html = await page.evaluate((id) => {
    const el = document.getElementById(id);
    return el ? el.outerHTML : null;
  }, accessoryId);

  if (!html) {
    throw new Error(`Could not find element with id "${accessoryId}" in the DOM.`);
  }
  return html;
}

/**
 * Check if an embed HTML contains valid CDN links (jd-s3.cdn.ubi.com).
 * Returns true if valid, false if it looks like a bot error response.
 */
function hasValidLinks(html) {
  const cdnPattern = /href="https?:\/\/jd-s3\.cdn\.ubi\.com[^"]+"/i;
  return cdnPattern.test(html);
}

/**
 * Send a slash command, wait for the bot response, extract HTML, and validate.
 * Retries up to maxRetries times if the response has no valid CDN links.
 */
async function fetchCommandWithRetry(page, opts, label, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      logOut(`  Retrying ${label} (attempt ${attempt + 1}/${maxRetries + 1})...`);
      await page.waitForTimeout(3000);
    }

    const preId = await getLastAccessoryId(page);
    await sendSlashCommand(page, opts);
    const embedId = await waitForNewEmbed(page, preId);
    const html = await extractHtml(page, embedId);

    if (hasValidLinks(html)) {
      logOut(`  Extracted ${label} embed HTML.`);
      return html;
    }

    logOut(`  Warning: ${label} response has no valid CDN links (bot may have returned an error).`);
  }

  throw new Error(
    `${label} response contained no valid download links after ${maxRetries + 1} attempts.\n` +
    '  The bot may not have data for this codename, or the track may not exist.'
  );
}

async function processCodename(page, codename) {
  logOut(`\n  JDH Downloader - Fetching: ${codename}\n`);

  // Navigate to Discord channel
  logOut('  Navigating to Discord channel...');
  await page.goto(CHANNEL_URL, { waitUntil: 'domcontentloaded' });

  await waitForLogin(page);

  // Wait for channel messages to actually load instead of a blind 3s wait
  await page.locator(SEL.messageAccessories).first().waitFor({ timeout: 15000 }).catch(() => { });

  // ---- Step 1: /assets jdu <codename> ----
  logOut('\n  [1/2] /assets jdu ' + codename);

  const assetsHtml = await fetchCommandWithRetry(page, {
    command: 'assets',
    choices: ['jdu'],
    codename,
  }, 'assets');

  await page.waitForTimeout(500);

  // ---- Step 2: /nohud <codename> ----
  logOut('\n  [2/2] /nohud ' + codename);

  const nohudHtml = await fetchCommandWithRetry(page, {
    command: 'nohud',
    choices: [],   // nohud has no game dropdown
    codename,
  }, 'nohud');

  // ---- Save files ----
  if (!existsSync(MAP_DOWNLOADS_DIR)) {
    mkdirSync(MAP_DOWNLOADS_DIR, { recursive: true });
  }

  const outputDir = join(MAP_DOWNLOADS_DIR, codename);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(join(outputDir, 'assets.html'), assetsHtml, 'utf-8');
  writeFileSync(join(outputDir, 'nohud.html'), nohudHtml, 'utf-8');

  logOut(`\n  Saved ${outputDir}/assets.html`);
  logOut(`  Saved ${outputDir}/nohud.html`);
  logOut('  Done!\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();

  if (useGui) {
    logOut('Launching GUI mode...');
    guiPage = await context.newPage();
    const guiPath = 'file:///' + join(__dirname, 'gui.html').replace(/\\/g, '/');
    await guiPage.goto(guiPath);

    // Bring GUI to front
    await guiPage.bringToFront();

    // Expose function for the GUI to call
    await guiPage.exposeFunction('startFetch', async (codes) => {
      try {
        for (const code of codes) {
          await processCodename(page, code);
        }
        await guiPage.evaluate(() => {
          if (window.fetchComplete) window.fetchComplete();
        });
      } catch (err) {
        logOut(`Error during GUI fetch: ${err.message}`);
        await guiPage.evaluate(() => {
          if (window.fetchComplete) window.fetchComplete();
        });
      }
    });

    logOut('GUI ready. Waiting for user input in the GUI window...');

    // Keep alive as long as GUI page is open
    await new Promise(resolve => {
      guiPage.on('close', resolve);
      page.on('close', resolve);
    });
  } else {
    // CLI mode
    try {
      for (const code of codenames) {
        await processCodename(page, code);
      }
    } finally {
      await context.close();
    }
  }
}

main().catch((err) => {
  logOut(`\n  Error: ${err.message}\n`);
  process.exit(1);
});
