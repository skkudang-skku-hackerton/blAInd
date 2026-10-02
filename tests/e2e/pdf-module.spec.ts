import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as mupdf from 'mupdf';

let server: Server;
let directory: string;
let url: string;
let entry: string;

test.beforeAll(async () => {
  directory = await mkdtemp('/tmp/opencode/pdf-browser-');
  await build({ configFile: false, logLevel: 'error', worker: { format: 'es' }, build: {
    target: 'esnext', outDir: directory, minify: false,
    rollupOptions: { input: 'src/modules/documents/pdf/index.ts', preserveEntrySignatures: 'strict' },
  } });
  entry = (await readdir(join(directory, 'assets'))).find((name) => name.startsWith('index-'))!;
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url!, 'http://localhost').pathname;
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Content-Security-Policy', "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self'");
        response.end('<html><body>PDF module harness</body></html>');
        return;
      }
      response.setHeader('Content-Type', pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      response.end(await readFile(join(directory, pathname)));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  url = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('bundled PDF Worker loads WASM and completes the documented API flow', async ({ page }) => {
  test.setTimeout(60_000);
  const buffer = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buffer, 'pdf', '');
  const font = new mupdf.Font('ko');
  const text = new mupdf.Text();
  const device = writer.beginPage([0, 0, 400, 200]);
  let bytes: number[];
  try {
    text.showString(font, [14, 0, 0, -14, 20, 50], '김민수 010-1234-5678');
    device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
    device.close(); writer.endPage(); writer.close();
    bytes = Array.from(buffer.asUint8Array());
  } finally { device.destroy(); text.destroy(); font.destroy(); writer.destroy(); buffer.destroy(); }
  await page.goto(url);
  const result = await page.evaluate(async ({ entry, bytes }) => {
    const module = await import(`/assets/${entry}`) as typeof import('../../src/modules/documents/pdf');
    const stages: string[] = [], errors: string[] = [];
    const processor = module.createPdfProcessor({
      detector: {
        initialize: async () => {}, scanText: async () => [],
        scanSegments: async (segments) => segments.map(({ id, text }) => ({ segmentId: id, detections: [{
          type: 'PHONE', confidence: 1, span: { start: text.indexOf('010'), end: text.indexOf('010') + 13 },
        }] })),
      },
      review: async (request) => ({ status: 'approved',
        autoMask: request.segments.flatMap((segment) => segment.detections.map(({ type, span, word }) => ({
          segmentId: segment.id, type, span, word,
        }))), confirm: { masking: [], nonMasking: [] },
      }),
      onStage: (stage) => stages.push(stage), onError: (error) => errors.push(String(error)),
    });
    const output = await processor(new File([new Uint8Array(bytes)], 'input.pdf'), new AbortController().signal);
    return { stages, errors, name: output?.name, bytes: output ? Array.from(new Uint8Array(await output.arrayBuffer())) : null };
  }, { entry, bytes });
  expect(result.errors).toEqual([]);
  expect(result.stages).toEqual(['extracting', 'scanning', 'reviewing', 'rebuilding']);
  expect(result.name).toBe('masked-document.pdf');
  expect(result.bytes).not.toBeNull();
  const doc = mupdf.Document.openDocument(new Uint8Array(result.bytes!), 'application/pdf');
  const outputPage = doc.loadPage(0), outputText = outputPage.toStructuredText('');
  try {
    expect(outputText.asText()).toContain('김민수');
    expect(outputText.asText()).not.toContain('010-1234-5678');
  } finally { outputText.destroy(); outputPage.destroy(); doc.destroy(); }
});
