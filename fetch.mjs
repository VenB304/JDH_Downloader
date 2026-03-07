import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load config
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf-8'));

// Parse arguments: node fetch.mjs <codename> [--output-dir <path>]
let codename = null;
let outputBase = null;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output-dir' && i + 1 < args.length) {
    outputBase = args[++i];
  } else if (!codename && !args[i].startsWith('--')) {
    codename = args[i];
  }
}

if (!codename) {
  console.error('Usage: node fetch.mjs <codename> [--output-dir <path>]');
  console.error('Example: node fetch.mjs TemperatureALT');
  console.error('         node fetch.mjs TemperatureALT --output-dir ../MapDownloads');
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForLogin(page) {
  const textbox = page.locator(SEL.textbox);

  try {
    await textbox.waitFor({ timeout: 15000 });
    console.log('  Already logged in.');
  } catch {
    console.log('');
    console.log('  +------------------------------------------+');
    console.log('  |  Please log in to Discord in the browser |');
    console.log('  |  window. Waiting up to 5 minutes...      |');
    console.log('  +------------------------------------------+');
    console.log('');
    await textbox.waitFor({ timeout: 300000 });
    console.log('  Login detected.');
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
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {string} opts.command      - command name, e.g. "assets"
 * @param {string[]} opts.choices    - dropdown choices to select in order, e.g. ["jdu"]
 * @param {string} opts.codename     - the codename string parameter
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
    console.log(`  Selected /${command} command.`);
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
      console.log(`  Selected choice: ${choice}`);
    } catch {
      // If exact match fails, try a looser match
      const looseOption = page.locator(SEL.autocompleteOption)
        .filter({ hasText: choice })
        .first();
      try {
        await looseOption.waitFor({ timeout: 3000 });
        await looseOption.click();
        console.log(`  Selected choice: ${choice}`);
      } catch {
        throw new Error(
          `Could not find "${choice}" in the parameter options.`
        );
      }
    }

    await page.waitForTimeout(200);
  }

  // Type the codename into the current text parameter field
  await page.keyboard.type(codename, { delay: 20 });
  console.log(`  Typed codename: ${codename}`);
  await page.waitForTimeout(200);

  // Send the command
  await page.keyboard.press('Enter');
  console.log('  Command sent.');
}

/**
 * Poll for a new message-accessories element to appear (the bot's response).
 * Waits for the ID to stabilize (stop changing) before returning, since Discord
 * swaps the "Thinking..." placeholder ID with the real embed ID.
 */
async function waitForNewEmbed(page, previousLastId, timeoutMs = 60000) {
  console.log('  Waiting for bot response...');
  const start = Date.now();

  // Wait for the last message-accessories div to:
  //  1) have a different ID than before the command was sent
  //  2) actually contain child elements (the real embed, not "Thinking...")
  //  3) NOT contain "Loading..." placeholder text
  //  4) have stable ID and content for at least 1.5 seconds
  while (Date.now() - start < timeoutMs) {
    // Check the last accessories div in the page
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
      // Found a new accessories div with real content — wait for ID to stabilize
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
        console.log(`  Bot response detected (${stableId}).`);
        return stableId;
      }
      // Not stable yet, keep polling
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
      console.log(`  Retrying (attempt ${attempt + 1}/${maxRetries + 1})...`);
      await page.waitForTimeout(3000);
    }

    const preId = await getLastAccessoryId(page);
    await sendSlashCommand(page, opts);
    const embedId = await waitForNewEmbed(page, preId);
    const html = await extractHtml(page, embedId);

    if (hasValidLinks(html)) {
      console.log(`  Extracted ${label} embed HTML.`);
      return html;
    }

    console.log(`  Warning: ${label} response has no valid CDN links (bot may have returned an error).`);
  }

  throw new Error(
    `${label} response contained no valid download links after ${maxRetries + 1} attempts.\n` +
    '  The bot may not have data for this codename, or the track may not exist.'
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n  JDH Downloader - Fetching: ${codename}\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // Navigate to the Discord channel
    console.log('  Navigating to Discord channel...');
    await page.goto(CHANNEL_URL, { waitUntil: 'domcontentloaded' });

    await waitForLogin(page);

    // Wait for channel messages to actually load instead of a blind 3s wait
    await page.locator(SEL.messageAccessories).first().waitFor({ timeout: 15000 }).catch(() => {
      // Channel might be empty — that's okay, we'll continue
    });

    // ---- Step 1: /assets jdu <codename> ----
    console.log('\n  [1/2] /assets jdu ' + codename);

    const assetsHtml = await fetchCommandWithRetry(page, {
      command: 'assets',
      choices: ['jdu'],
      codename,
    }, 'assets');

    await page.waitForTimeout(500);

    // ---- Step 2: /nohud <codename> ----
    console.log('\n  [2/2] /nohud ' + codename);

    const nohudHtml = await fetchCommandWithRetry(page, {
      command: 'nohud',
      choices: [],   // nohud has no game dropdown
      codename,
    }, 'nohud');

    // ---- Save files ----
    const base = outputBase ? resolve(outputBase) : __dirname;
    const outputDir = join(base, codename);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(join(outputDir, 'assets.html'), assetsHtml, 'utf-8');
    writeFileSync(join(outputDir, 'nohud.html'), nohudHtml, 'utf-8');

    console.log(`\n  Saved to: ${outputDir}`);
    console.log(`  - assets.html`);
    console.log(`  - nohud.html`);
    console.log('  Done!\n');
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exit(1);
});
