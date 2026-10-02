import { test, expect, chromium } from '@playwright/test';
import { build } from 'vite';
import { createServer } from 'wxt';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as mupdf from 'mupdf';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';

function pdf() {
  const buffer = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buffer, 'pdf', '');
  const font = new mupdf.Font('ko');
  const text = new mupdf.Text();
  const device = writer.beginPage([0, 0, 400, 200]);
  try {
    text.showString(font, [14, 0, 0, -14, 20, 50], '김민수 010-1234-5678');
    device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
    device.close(); writer.endPage(); writer.close();
    return Buffer.from(buffer.asUint8Array());
  } finally { device.destroy(); text.destroy(); font.destroy(); writer.destroy(); buffer.destroy(); }
}
function docx() {
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>김민수 010-1234-5678</w:t></w:r></w:p></w:body></w:document>'),
  }));
}

test('built extension: intercept → offscreen document worker → modal → mask → reattach', async () => {
  test.setTimeout(240_000);
  const directory = await mkdtemp(join(tmpdir(), 'blaind-document-flow-'));
  const extension = join(directory, 'extension');
  let devServer: Awaited<ReturnType<typeof createServer>> | undefined;
  if (process.env.DOCUMENT_FLOW_DEV === '1') {
    devServer = await createServer({ outDir: join(directory, 'dev-output'),
      dev: { server: { port: 3001 } }, webExt: { disabled: true } });
    await devServer.start();
    await cp(join(directory, 'dev-output/chrome-mv3-dev'), extension, { recursive: true });
  } else await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  console.info('Document flow: extension copied');
  await build({ configFile: false, logLevel: 'error', worker: { format: 'es' }, build: {
    outDir: extension, emptyOutDir: false,
    lib: { entry: resolve('tests/e2e/document-flow-client.ts'), formats: ['iife'], name: 'DocumentFlow', fileName: () => 'document-flow.js' },
  } });
  await writeFile(join(extension, 'document-flow.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><form><input type="file"></form><script src="document-flow.js"></script></body></html>');
  console.info('Document flow: harness built');
  const context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    console.info('Document flow: browser launched');
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/document-flow.html`);
    console.info('Document flow: page ready');
    const state = () => page.evaluate(() => {
      const flow = (window as any).documentFlow;
      return { errors: flow.errors, uploads: flow.uploads.map((upload: { name: string }) => upload.name) };
    });
    for (const [name, buffer, mask] of [
      ['input.pdf', pdf(), true], ['input.pdf', pdf(), false], ['input.docx', docx(), true],
    ] as const) {
      const before = (await state()).uploads.length;
      await page.locator('input[type=file]').setInputFiles({ name, mimeType: name.endsWith('pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer });
      await expect(page.getByRole('dialog')).toBeVisible();
      console.info('Document flow: review visible', name, mask);
      expect((await state()).uploads).toHaveLength(before);
      await expect(page.getByText('김민수', { exact: true })).toBeVisible();
      console.info('Document flow: name visible');
      if (mask) {
        await page.getByRole('checkbox').check();
        console.info('Document flow: name selected');
        await page.getByRole('button', { name: '선택 항목 가리고 진행' }).click();
      } else await page.getByRole('button', { name: '선택 없이 진행' }).click();
      await expect.poll(async () => (await state()).uploads.length).toBe(before + 1);
      console.info('Document flow: masked file attached', name, mask);
      const upload = await page.evaluate(() => {
        const file = (window as any).documentFlow.uploads.at(-1);
        const bytes = new Uint8Array(file.bytes);
        let text = '';
        for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { name: file.name as string, data: btoa(text) };
      });
      const uploadBytes = Buffer.from(upload.data, 'base64');
      expect(upload.name).toBe(name.endsWith('pdf') ? 'masked-document.pdf' : 'masked-document.docx');
      let content: string;
      if (name.endsWith('pdf')) {
        const doc = mupdf.Document.openDocument(uploadBytes, 'application/pdf');
        const p = doc.loadPage(0), t = p.toStructuredText('');
        try { content = t.asText(); } finally { t.destroy(); p.destroy(); doc.destroy(); }
      } else content = strFromU8(unzipSync(uploadBytes)['word/document.xml']!);
      expect(content).not.toContain('010-1234-5678');
      if (mask) expect(content).not.toContain('김민수');
      else expect(content).toContain('김민수');
    }
    const before = (await state()).uploads.length;
    await page.locator('input[type=file]').setInputFiles({ name: 'cancel.pdf', mimeType: 'application/pdf', buffer: pdf() });
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await state()).uploads).toHaveLength(before);
    expect((await state()).errors).toEqual([]);
  } finally { await context.close(); await devServer?.stop(); await rm(directory, { recursive: true, force: true }); }
});
