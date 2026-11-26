import { chromium } from 'playwright-core';

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/';
const errors = [];
const warnings = [];

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (error) => errors.push(`pageerror: ${error.stack || error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  if (message.type() === 'warning') warnings.push(message.text());
});

console.log('goto', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForSelector('.stele-item', { timeout: 180000 });
console.log('archive ready');

await page.goto(`${url}#/scan`);
await page.waitForSelector('#view canvas', { timeout: 60000 });
await page.waitForTimeout(2500);
console.log('scan viewer ready');

await page.goto(`${url}#/rubbing`);
await page.waitForSelector('#rubbing-display', { timeout: 60000 });
await page.waitForFunction(() => {
  const canvas = document.querySelector('#rubbing-display');
  if (!canvas) return false;
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4 * 997) if (data[i] < 100) dark++;
  return dark > 20;
}, undefined, { timeout: 120000 });
const rubbingStats = await page.evaluate(() => {
  const canvas = document.querySelector('#rubbing-display');
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0, n = 0, dark = 0, light = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
    sum += v; n++;
    if (v < 80) dark++;
    if (v > 200) light++;
  }
  return { width: canvas.width, height: canvas.height, mean: sum / n, darkPct: dark / n, lightPct: light / n };
});
console.log('rubbing stats', rubbingStats);

await page.goto(`${url}#/settings`);
await page.getByRole('button', { name: /运行边界偏差检测/ }).click();
await page.waitForSelector('text=/600DPI 综合 P95/', { timeout: 120000 });
const edgeText = await page.locator('.card').filter({ hasText: '刻口几何精度验收' }).innerText();
console.log(edgeText.match(/[\d.]+ mm/g)?.slice(0, 6).join(' | '));

await page.goto(`${url}#/compare`);
await page.getByRole('button', { name: /生成示例老拓片/ }).click();
await page.waitForSelector('text=/自动配准与差异分析完成|配准相关度/', { timeout: 180000 });
await page.waitForTimeout(1000);
const compareText = await page.locator('#view').innerText();
console.log('compare contains score:', /配准分数/.test(compareText), 'regions:', (compareText.match(/新泐/g) || []).length);

console.log('errors:', errors.length);
if (warnings.length) console.log('warnings:', warnings.slice(0, 5));
if (errors.length) {
  console.error(errors.join('\n\n'));
  await browser.close();
  process.exit(1);
}
await browser.close();
console.log('SMOKE_OK');
