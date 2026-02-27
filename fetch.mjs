import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load config
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf-8'));

// Get codename from args
const codename = process.argv[2];
if (!codename) {
  console.error('Usage: node fetch.mjs <codename>');
  console.error('Example: node fetch.mjs TemperatureALT');
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
async function waitForNewEmbed(page, previousLastId, timeoutMs = 30000) {
  console.log('  Waiting for bot response...');
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const currentId = await getLastAccessoryId(page);
    if (currentId && currentId !== previousLastId) {
      // New embed detected — now wait for the ID to stabilize (stop changing).
      // Discord swaps the "Thinking..." ID with the final embed ID after ~1s.
      let stableId = currentId;
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(500);
        const latestId = await getLastAccessoryId(page);
        if (latestId === stableId) {
          // ID hasn't changed — it's stable
          return stableId;
        }
        stableId = latestId;
      }
      return stableId;
    }
    await page.waitForTimeout(300);
  }

  throw new Error(
    'Timed out waiting for the bot response. ' +
    'The bot might be offline or the command may have failed.'
  );
}

async function extractHtml(page, accessoryId) {
  const el = page.locator(`div[id="${accessoryId}"]`);
  return await el.evaluate((node) => node.outerHTML);
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
    const preAssetsId = await getLastAccessoryId(page);

    await sendSlashCommand(page, {
      command: 'assets',
      choices: ['jdu'],
      codename,
    });

    const assetsId = await waitForNewEmbed(page, preAssetsId);
    const assetsHtml = await extractHtml(page, assetsId);
    console.log('  Extracted assets embed HTML.');

    await page.waitForTimeout(500);

    // ---- Step 2: /nohud <codename> ----
    console.log('\n  [2/2] /nohud ' + codename);
    const preNohudId = await getLastAccessoryId(page);

    await sendSlashCommand(page, {
      command: 'nohud',
      choices: [],   // nohud has no game dropdown
      codename,
    });

    const nohudId = await waitForNewEmbed(page, preNohudId);
    const nohudHtml = await extractHtml(page, nohudId);
    console.log('  Extracted nohud embed HTML.');

    // ---- Save files ----
    const outputDir = join(__dirname, codename);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(join(outputDir, 'assets.html'), assetsHtml, 'utf-8');
    writeFileSync(join(outputDir, 'nohud.html'), nohudHtml, 'utf-8');

    console.log(`\n  Saved ${codename}/assets.html`);
    console.log(`  Saved ${codename}/nohud.html`);
    console.log('  Done!\n');
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exit(1);
});
