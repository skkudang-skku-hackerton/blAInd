import { test, expect, chromium } from '@playwright/test';
import { build } from 'vite';
import { createServer, type Server } from 'node:http';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

let directory: string, baseURL: string;
let server: Server;
test.beforeAll(async () => {
  directory = await mkdtemp('/tmp/opencode/document-review-');
  server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/page.js' ? 'text/javascript' : 'text/html');
    if (request.url === '/page.js') {
      response.end(`document.addEventListener('pointerdown', event => {
        const menu = document.querySelector('#upload-menu');
        if (menu && !event.composedPath().includes(menu) && event.target.id !== 'start') menu.remove();
      }, true);
      document.documentElement.dataset.pageEvents = '0';
      for (const type of ['click', 'keydown', 'keyup']) document.addEventListener(type, () => {
        document.documentElement.dataset.pageEvents = String(Number(document.documentElement.dataset.pageEvents) + 1);
      }, true);`);
    } else {
      response.setHeader('Content-Security-Policy', "script-src 'self'; object-src 'none'");
      response.end('<html><body><button id="start">Start review</button><div id="upload-menu"><input type="file"></div><script src="/page.js"></script></body></html>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  baseURL = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function extension(browser: 'chrome' | 'firefox') {
  const path = join(directory, browser);
  await cp(resolve(`.output/${browser}-${browser === 'chrome' ? 'mv3' : 'mv2'}`), path, { recursive: true });
  await build({ configFile: false, logLevel: 'error', build: {
    outDir: path, emptyOutDir: false,
    lib: { entry: 'tests/e2e/document-review-extension-client.ts', formats: ['iife'], name: 'ReviewTest', fileName: () => 'review-test.js' },
  } });
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  manifest.content_scripts = [{ matches: ['http://127.0.0.1/*'], js: ['review-test.js'], run_at: 'document_idle' }];
  if (browser === 'chrome') manifest.web_accessible_resources[0].matches.push('http://127.0.0.1/*');
  await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest));
  return path;
}

interface Driver {
  navigate(): Promise<void>;
  evaluate<T>(script: string): Promise<T>;
  click(selector: string, frame?: boolean): Promise<void>;
  press?(key: string): Promise<void>;
  reviewVisible(): Promise<boolean>;
  close(): Promise<void>;
}

async function chromeDriver(path: string): Promise<Driver> {
  const context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
  const page = await context.newPage();
  const frame = page.frameLocator('#blaind-document-review iframe');
  return {
    async navigate() { await page.goto(`${baseURL}/app/conversation`); },
    evaluate: script => page.evaluate(`(() => { ${script} })()`),
    async click(selector, inside) {
      if (inside) await frame.locator(selector).click();
      else await page.locator(selector.replaceAll(' >>> ', ' ')).click();
    },
    press: key => page.keyboard.press(key),
    reviewVisible: () => frame.locator('[role=dialog]').isVisible().catch(() => false),
    close: () => context.close(),
  };
}

/** Firefox Playwright cannot install add-ons. Use the real WebDriver add-on API,
 * so this regression runs in a content-script sandbox rather than page.evaluate. */
async function firefoxDriver(path: string): Promise<Driver> {
  let process: ChildProcess;
  const endpoint = await new Promise<string>((resolve, reject) => {
    process = spawn(globalThis.process.env.FIREFOX_WEBDRIVER!, ['--port', '0']);
    process.on('error', reject);
    const ready = (data: Buffer) => {
      const match = /Listening on (127\.0\.0\.1:\d+)/.exec(data.toString());
      if (match) resolve(`http://${match[1]}`);
    };
    process.stdout!.on('data', ready); process.stderr!.on('data', ready);
  });
  let sessionId = '';
  const command = async (route: string, body?: unknown, method = 'POST'): Promise<any> => {
    const response = await fetch(`${endpoint}${route}`, { method,
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const { value } = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    return value;
  };
  try {
    const session = await command('/session', { capabilities: { alwaysMatch: {
      browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'], prefs: { 'remote.active-protocols': 1 } },
    } } });
    sessionId = session.sessionId;
    await command(`/session/${sessionId}/moz/addon/install`, { path, temporary: true });
  } catch (error) { process!.kill(); throw error; }
  const run = (route: string, body?: unknown, method?: string) => command(`/session/${sessionId}${route}`, body, method);
  const evaluate = <T>(script: string): Promise<T> => run('/execute/sync', { script, args: [] });
  const enterFrame = async () => {
    const element = await evaluate('return document.querySelector("#blaind-document-review")?.shadowRoot.querySelector("iframe")');
    if (!element) throw new Error('Review frame missing');
    await run('/frame', { id: element });
  };
  return {
    async navigate() { await run('/url', { url: `${baseURL}/app/conversation` }); },
    evaluate,
    async click(selector, inside) {
      if (inside) await enterFrame();
      try {
        // WebDriver execute can locate shadow descendants, but the click itself
        // is a trusted native click, exercising Firefox capture and default actions.
        const parts = selector.split(' >>> ');
        const element = await evaluate<Record<string, string>>(`let root = document;
          for (const selector of ${JSON.stringify(parts.slice(0, -1))}) root = root.querySelector(selector).shadowRoot;
          return root.querySelector(${JSON.stringify(parts.at(-1))});`);
        const id = element['element-6066-11e4-a52e-4f735466cecf'];
        await run(`/element/${id}/click`, {});
      } finally { if (inside) await run('/frame', { id: null }); }
    },
    async reviewVisible() {
      try { await enterFrame(); return await evaluate('return !!document.querySelector("[role=dialog]")'); }
      catch { return false; }
      finally { await run('/frame', { id: null }); }
    },
    async close() {
      try { await run('', undefined, 'DELETE'); } finally { process!.kill(); }
    },
  };
}

test('real extension: status clicks, isolated review, approve and cancel', async ({}, info) => {
  test.setTimeout(90_000);
  const firefox = info.project.name === 'firefox';
  test.skip(firefox && !process.env.FIREFOX_WEBDRIVER, 'Set FIREFOX_WEBDRIVER to the geckodriver executable.');
  const path = await extension(firefox ? 'firefox' : 'chrome');
  const driver = await (firefox ? firefoxDriver(path) : chromeDriver(path));
  try {
    for (const action of ['approve', 'cancel', 'navigate']) {
      await driver.navigate();
      await expect.poll(() => driver.evaluate('return !!document.querySelector("[data-blaind-notice]")')).toBe(true);
      if (!firefox) {
        await expect.poll(() => driver.evaluate(`return !!document.querySelector('[data-blaind-notice]')
          ?.shadowRoot.querySelector('[role="dialog"][aria-modal="true"]')`)).toBe(true);
        const closeFocused = () => driver.evaluate(`const host = document.querySelector('[data-blaind-notice]');
          return !!host && document.activeElement === host && host.shadowRoot.activeElement === host.shadowRoot.querySelector('button');`);
        await expect.poll(closeFocused).toBe(true);
        for (const key of ['Tab', 'Shift+Tab']) {
          await driver.press!(key);
          await expect.poll(closeFocused).toBe(true);
        }
      }
      await driver.click('[data-blaind-notice] >>> strong');
      await expect.poll(() => driver.evaluate('return !!document.querySelector("#upload-menu")')).toBe(true);
      if (!firefox && action === 'cancel') await driver.press!('Escape');
      else if (!firefox && action === 'navigate') await driver.press!('Enter');
      else await driver.click('[data-blaind-notice] >>> button');
      await expect.poll(() => driver.evaluate('return !!document.querySelector("[data-blaind-notice]")')).toBe(false);
      if (!firefox) await expect.poll(() => driver.evaluate('return document.activeElement?.id')).toBe('start');
      await driver.click('#blaind-gemini-processing-indicator >>> .title');
      await expect.poll(() => driver.evaluate('return !!document.querySelector("#upload-menu")')).toBe(true);
      await expect.poll(() => driver.evaluate('return document.documentElement.dataset.pageEvents')).toBe('0');
      await driver.click('#start');
      await expect.poll(() => driver.reviewVisible()).toBe(true);
      await driver.click('.blaind-alert-header', true);
      await driver.click('input[aria-label="이름 가리기"]', true);
      await expect.poll(() => driver.evaluate('return !!document.querySelector("#upload-menu")')).toBe(true);
      if (action === 'navigate') await driver.evaluate('history.pushState({}, "", "/app/other")');
      else await driver.click(action === 'approve' ? '.blaind-alert-mask' : '.blaind-alert-cancel', true);
      await expect.poll(() => driver.evaluate('return document.documentElement.dataset.reviewState'))
        .toBe(action === 'approve' ? 'approved' : 'cancelled');
    }
  } finally { await driver.close(); }
});
