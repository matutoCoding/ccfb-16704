import { chromium } from 'playwright-core';
import fs from 'node:fs';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', e => errors.push(e.stack || e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text()); });
await page.goto('http://127.0.0.1:4173/#/export', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=出版导出设置', { timeout: 180000 });
const dpi = process.env.EXPORT_DPI || '96';
await page.locator('input[type=number]').first().fill(dpi);
await page.keyboard.press('Tab');
await page.waitForTimeout(300);
const downloadPromise = page.waitForEvent('download', { timeout: 600000 });
const started = Date.now();
await page.getByRole('button', { name: /导出整张 TIFF/ }).click();
const download = await downloadPromise;
await download.saveAs('export-smoke.tif');
const elapsed = Date.now() - started;
const stat = fs.statSync('export-smoke.tif');
const fd = fs.openSync('export-smoke.tif', 'r');
const header = Buffer.alloc(8);
fs.readSync(fd, header, 0, 8, 0);
fs.closeSync(fd);
console.log({ suggested: download.suggestedFilename(), elapsedMs: elapsed, bytes: stat.size, header: header.toString('hex') });

if (!process.env.SKIP_ZIP) {
  const zipDownloadPromise = page.waitForEvent('download', { timeout: 600000 });
  await page.getByRole('button', { name: /批量单字 PNG/ }).click();
  const zipDownload = await zipDownloadPromise;
  await zipDownload.saveAs('characters-smoke.zip');
  const zipStat = fs.statSync('characters-smoke.zip');
  console.log({ zip: zipDownload.suggestedFilename(), zipBytes: zipStat.size });
}

if (errors.length) {
  console.error(errors.join('\n'));
  await browser.close();
  process.exit(1);
}
await browser.close();
console.log('EXPORT_OK');
