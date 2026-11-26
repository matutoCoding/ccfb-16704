import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
page.on('pageerror', e => console.error('PAGEERROR', e.stack || e.message));
page.on('console', m => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
await page.goto('http://127.0.0.1:4173/#/rubbing', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#rubbing-display', { timeout: 180000 });
await page.waitForTimeout(8000);
const stats = await page.evaluate(() => {
  const c = document.querySelector('#rubbing-display');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0,0,c.width,c.height).data;
  let sum=0,n=0,alpha=0,light=0,dark=0,min=255,max=0; const vals=[];
  for(let i=0;i<d.length;i+=4){const v=(d[i]+d[i+1]+d[i+2])/3; sum+=v;n++; vals.push(v); if(d[i+3]>0)alpha++; if(v>180)light++; if(v<60)dark++; if(v<min)min=v; if(v>max)max=v;}
  vals.sort((a,b)=>a-b);
  return {w:c.width,h:c.height,mean:sum/n,min,max,p10:vals[Math.floor(n*.1)],p50:vals[Math.floor(n*.5)],p90:vals[Math.floor(n * 0.9)],alphaPct:alpha/n,lightPct:light/n,darkPct:dark/n};
});
console.log(stats);
await page.screenshot({ path: 'rubbing-smoke.png', fullPage: false });
await browser.close();
