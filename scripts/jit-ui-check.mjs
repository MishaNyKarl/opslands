import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const origin = 'https://land.portalwiki.world';
const status = await (await fetch(origin + '/api/auth/me')).json();
assert.equal(status.ssoEnabled, true); assert.equal(status.ssoJitEnabled, true);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH, headless: true });
try {
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.getByRole('link', { name: 'Войти через OpsVault', exact: true }).waitFor();
  await page.getByText('Первый вход через OpsVault автоматически создаст аккаунт OPSLands, если вам выдан доступ.', { exact: true }).waitFor();
  const response = await page.request.get(origin + '/auth/opsvault/login', { maxRedirects: 0 });
  assert.equal(response.status(), 302);
  const redirect = new URL(response.headers().location);
  assert.equal(redirect.origin, 'https://portalwiki.world'); assert.equal(redirect.searchParams.get('client_id'), 'opslands');
  assert.deepEqual(errors, []);
  console.log('Live JIT flag, login UI and OpsVault authorization redirect verified. No real user login was performed.');
} finally { await browser.close(); }
