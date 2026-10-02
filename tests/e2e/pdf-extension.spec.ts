import { chromium, expect, test } from '@playwright/test';
import { build } from 'vite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as mupdf from 'mupdf';

const extension = resolve('.output/chrome-mv3');
function fixture() {
  const buffer = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buffer, 'pdf', '');
  const font = new mupdf.Font('ko');
  try {
    for (let i = 0; i < 2; i++) {
      const device = writer.beginPage([0, 0, 400, 200]);
      const text = new mupdf.Text();
      text.showString(font, [14, 0, 0, -14, 20, 50], '김민수 010-1234-5678');
      device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
      device.close(); writer.endPage(); device.destroy(); text.destroy();
    }
    writer.close();
    return Buffer.from(buffer.asUint8Array());
  } finally { font.destroy(); writer.destroy(); buffer.destroy(); }
}

test('MV3 PDF upload → offscreen WASM → modal decisions → masked attachment; cancel holds original', async () => {
  await build({ configFile: false, logLevel: 'error', worker: { format: 'es' }, build: {
    outDir: extension, emptyOutDir: false, target: 'esnext',
    rollupOptions: { input: resolve('tests/e2e/pdf-extension-client.ts'), output: { entryFileNames: 'pdf-e2e-client.js' } },
  } });
  await writeFile(join(extension, 'pdf-e2e.html'), '<html><body><form><input type="file" accept="application/pdf"></form><script type="module" src="pdf-e2e-client.js"></script></body></html>');
  const profile = await mkdtemp(join(tmpdir(), 'blaind-pdf-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/pdf-e2e.html`);
    await page.locator('input').setInputFiles({ name: 'original.pdf', mimeType: 'application/pdf', buffer: fixture() });
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.evaluate(() => (window as any).uploaded)).toBeUndefined();
    const choices = page.getByRole('checkbox');
    await expect(choices).toHaveCount(2);
    await choices.nth(0).check();
    await page.getByRole('button', { name: '선택 항목 가리고 진행' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).uploaded?.name)).toBe('masked-document.pdf');
    const bytes = await page.evaluate(() => (window as any).uploaded.bytes as number[]);
    const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
    try {
      for (let i = 0; i < 2; i++) {
        const p = doc.loadPage(i), text = p.toStructuredText('');
        try {
          expect(text.asText()).not.toContain('010-1234-5678');
          if (i === 0) expect(text.asText()).not.toContain('김민수');
          else expect(text.asText()).toContain('김민수');
        } finally { text.destroy(); p.destroy(); }
      }
    } finally { doc.destroy(); }
    await page.evaluate(() => { delete (window as any).uploaded; });
    await page.locator('input[type=file]').setInputFiles({ name: 'cancel.pdf', mimeType: 'application/pdf', buffer: fixture() });
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).uploaded)).toBeUndefined();
  } finally {
    await context.close();
    if (!profile.startsWith(join(tmpdir(), 'blaind-pdf-'))) throw new Error('Unexpected test profile');
    await rm(profile, { recursive: true, force: true });
  }
});

test('production content script → real detector → PDF review → masked upload', async () => {
  test.skip(process.env.PDF_REAL_MODEL_E2E !== '1', 'Downloads the real PII model; opt in with PDF_REAL_MODEL_E2E=1.');
  const profile = await mkdtemp(join(tmpdir(), 'blaind-pdf-real-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body:
      '<html><body><form><input type="file" accept="application/pdf"><div id="prompt-textarea" contenteditable="true"></div></form><script>document.querySelector("input").addEventListener("change",async e=>{const f=e.target.files[0]; window.uploaded={name:f.name,bytes:Array.from(new Uint8Array(await f.arrayBuffer()))};});</script></body></html>' }));
    const page = await context.newPage();
    page.on('console', message => { if (message.text().startsWith('[blAInd:pdf]')) console.log(message.text()); });
    await page.goto('https://chatgpt.com/c/pdf-test');
    await page.locator('input').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: fixture() });
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 540_000 });
    expect(await page.evaluate(() => (window as any).uploaded)).toBeUndefined();
    await page.getByRole('button', { name: /선택 없이 진행|보호된 내용으로 진행/ }).click();
    await expect.poll(() => page.evaluate(() => (window as any).uploaded?.name)).toBe('masked-document.pdf');
    const bytes = await page.evaluate(() => (window as any).uploaded.bytes as number[]);
    const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
    try {
      const p = doc.loadPage(0), text = p.toStructuredText('');
      try { expect(text.asText()).not.toContain('010-1234-5678'); }
      finally { text.destroy(); p.destroy(); }
    } finally { doc.destroy(); }
  } finally {
    await context.close();
    if (!profile.startsWith(join(tmpdir(), 'blaind-pdf-real-'))) throw new Error('Unexpected test profile');
    await rm(profile, { recursive: true, force: true });
  }
});
