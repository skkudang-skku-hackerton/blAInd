import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

let server: Server;
let directory: string;
let url: string;
let entry: string;

test.beforeAll(async () => {
  directory = await mkdtemp('/tmp/opencode/firefox-upload-');
  await build({ configFile: false, logLevel: 'error', build: {
    target: 'esnext', outDir: directory, minify: false,
    rollupOptions: {
      input: 'src/modules/sites/chatgpt/file-upload/index.ts',
      preserveEntrySignatures: 'strict',
    },
  } });
  entry = (await readdir(join(directory, 'assets'))).find((name) => name.startsWith('index-'))!;
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url!, 'http://localhost').pathname;
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Content-Security-Policy', "script-src 'self'; worker-src 'self'; object-src 'self'");
        response.end('<html><body><form id="composer"><input type="file" accept="application/pdf"></form></body></html>');
        return;
      }
      response.setHeader('Content-Type', 'text/javascript');
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

test('Firefox file input interception reinjects only the processor result', async ({ page }) => {
  const result = await page.goto(url);
  expect(result?.ok()).toBe(true);
  const outcome = await page.evaluate(async ({ entry }) => {
    const { createFileUploadInterceptor } = await import(`/assets/${entry}`) as typeof import('../../src/modules/sites/chatgpt/file-upload');
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    let resolveProcessor!: (file: File | null) => void;
    const processorStarted = new Promise<void>((resolve) => {
      const interceptor = createFileUploadInterceptor({
        indicator: false,
        processors: { pdf: () => new Promise<File | null>((resolveFile) => {
          resolveProcessor = resolveFile;
          resolve();
        }) },
      });
      interceptor.start();
      (window as Window & { __uploadInterceptor?: typeof interceptor }).__uploadInterceptor = interceptor;
    });
    const attached = new Promise<string>((resolve) => {
      input.addEventListener('change', () => resolve(input.files?.[0]?.name ?? 'missing'));
    });
    const transfer = new DataTransfer();
    transfer.items.add(new File(['original'], 'original.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await processorStarted;
    const sourceWasCleared = input.files?.length === 0;
    resolveProcessor(new File(['masked'], 'masked.pdf', { type: 'application/pdf' }));
    const attachedName = await attached;
    (window as Window & { __uploadInterceptor?: { stop(): void } }).__uploadInterceptor?.stop();
    return { sourceWasCleared, attachedName };
  }, { entry });
  expect(outcome).toEqual({ sourceWasCleared: true, attachedName: 'masked.pdf' });
});
