import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const uploadPath = path.join(repoRoot, 'tests', 'fixtures', 'sample-birth-cert.pdf');
const baseUrl = process.env.STATIC_TEST_URL || 'http://127.0.0.1:3314/index.html?storage=firebase';

async function waitForAutosave() {
  await new Promise((resolve) => setTimeout(resolve, 1800));
}

async function waitForFirebaseReady(page) {
  await page.waitForSelector('#storage-usage-text', { timeout: 60000 });
  await page.waitForFunction(() => {
    const text = document.querySelector('#storage-usage-text')?.textContent || '';
    return text.includes('Firebase encrypted vault active');
  }, null, { timeout: 60000 });
  await page.waitForFunction(() => {
    if (typeof window.__agsvaPersistenceState !== 'function') return false;
    const state = window.__agsvaPersistenceState();
    return state.backend === 'firebase' && state.ready === true && state.hydrating === false;
  }, null, { timeout: 60000 });
}

async function openApp(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForFirebaseReady(page);
}

async function expectNoFallbackMessage(page) {
  const bodyText = await page.locator('body').innerText();
  assert(!bodyText.includes('Server persistence unavailable'), 'server fallback toast is still visible');
  assert(!bodyText.includes('Cloud persistence unavailable'), 'cloud fallback toast is visible');
}

async function clearFirebaseVault(page) {
  await page.evaluate(() => {
    localStorage.removeItem('agsva-firebase-vault-v1');
    localStorage.removeItem('agsva-app-state-v3');
    sessionStorage.removeItem('agsva-app-state-v2');
  });
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await openApp(page);
    await clearFirebaseVault(page);
    await openApp(page);

    await expectNoFallbackMessage(page);
    await assert.doesNotMatch(
      await page.locator('#storage-usage-text').innerText(),
      /Browser fallback|SQLite \+ server/i
    );
    await assert.match(await page.locator('#storage-usage-text').innerText(), /Firebase encrypted vault active/i);

    await page.fill('#full-name', 'Vikram Deshpande');
    await page.fill('#dob', '1988-06-15');
    await page.selectOption('#citizenship', 'australian');
    await page.fill('#passport-no', 'N1234567');
    await page.fill('#current-addr', '100 Collins Street, Melbourne VIC 3000');
    await page.fill('#phone', '+61 400 123 456');
    await page.fill('#email', 'vikram@example.com');
    await page.click('button:has-text("Save Personal Information")');

    await page.fill('#ref-name', 'Alex Referee');
    await page.selectOption('#ref-citizenship', 'Australian');
    await page.fill('#ref-role', 'Engineering Director');
    await page.fill('#ref-employer', 'ATO Delivery Partner');
    await page.fill('#ref-from', '2025-01');
    await page.fill('#ref-phone', '+61 401 555 111');
    await page.fill('#ref-email', 'alex.referee@example.com');
    await page.click('button:has-text("Add Referee")');
    await page.waitForSelector('#referee-cards .referee-card');

    await page.selectOption('#upload-category', 'birth-cert');
    await page.setInputFiles('#file-input', uploadPath);
    await page.waitForSelector('#uploaded-docs .uploaded-doc-card');
    await waitForAutosave();

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForFirebaseReady(page);
    await expectNoFallbackMessage(page);
    assert.equal(await page.inputValue('#full-name'), 'Vikram Deshpande');
    assert.equal(await page.inputValue('#passport-no'), 'N1234567');
    assert.equal(await page.inputValue('#current-addr'), '100 Collins Street, Melbourne VIC 3000');
    await assert.match(await page.locator('#referee-cards').innerText(), /Alex Referee/);
    await assert.match(await page.locator('#uploaded-docs').innerText(), /sample-birth-cert\.pdf/);

    await page.fill('#passport-no', '12');
    await page.click('button:has-text("Save Personal Information")');
    assert.equal(await page.getAttribute('#passport-no', 'aria-invalid'), 'true');
    await page.fill('#passport-no', 'N1234567');
    await page.click('button:has-text("Save Personal Information")');

    await page.click('#referee-cards button:has-text("Generate Briefing")');
    await page.waitForFunction(
      () => document.body.innerText.includes('Referee briefing PDF downloaded successfully'),
      null,
      { timeout: 20000 }
    );

    await page.click('button[aria-label="Export application summary as PDF"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('Application summary PDF downloaded'),
      null,
      { timeout: 20000 }
    );

    const zipDownloadPromise = page.waitForEvent('download');
    await page.click('button[aria-label="Export document bundle as ZIP"]');
    const zipDownload = await zipDownloadPromise;
    assert.match(zipDownload.suggestedFilename(), /\.zip$/i);
    await page.waitForFunction(
      () => document.body.innerText.includes('Document bundle ZIP downloaded'),
      null,
      { timeout: 20000 }
    );

    console.log(JSON.stringify({
      ok: true,
      baseUrl
    }));
  } finally {
    await context.close();
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
