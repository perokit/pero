// Isolated process: the caller bounds preview time and always kills it on timeout.
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { chromium } from 'playwright';

const [source, output, original] = process.argv.slice(2);
if (source === undefined || output === undefined || original === undefined)
  throw new Error('Missing preview paths');
const root = await realpath(dirname(original));
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
    acceptDownloads: false,
    javaScriptEnabled: false,
  });
  await context.route('**/*', async (route) => {
    try {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://pero-preview.invalid')
        return await route.abort();
      if (url.pathname === '/__source__')
        return await route.fulfill({
          body: await readFile(source),
          contentType: source.endsWith('.svg') ? 'image/svg+xml' : 'text/html',
        });
      const asset = await realpath(
        resolve(root, '.' + decodeURIComponent(url.pathname)),
      );
      const within = relative(root, asset);
      if (
        isAbsolute(within) ||
        within
          .split(/[\\/]/)
          .some((part) => part === '..' || part.startsWith('.')) ||
        /(?:^|[\\/])(?:credentials|auth|secrets)(?:[.\\/]|$)/i.test(within) ||
        (await stat(asset)).size > 8 * 1024 * 1024
      )
        return await route.abort();
      await route.fulfill({ path: asset });
    } catch {
      await route.abort();
    }
  });
  const page = await context.newPage();
  await page.goto('https://pero-preview.invalid/__source__', {
    waitUntil: 'load',
    timeout: 20_000,
  });
  await page.screenshot({
    path: output,
    animations: 'disabled',
    timeout: 10_000,
  });
} finally {
  await browser.close();
}
