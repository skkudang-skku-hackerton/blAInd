import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

let directory: string, baseURL: string, entry: string;
let server: Server;
test.beforeAll(async () => {
  directory = await mkdtemp('/tmp/opencode/upload-context-');
  await build({ configFile: false, logLevel: 'error', build: {
    target: 'esnext', outDir: directory,
    rollupOptions: { input: 'src/modules/sites/chatgpt/file-upload/index.ts', preserveEntrySignatures: 'strict' },
  } });
  entry = (await readdir(join(directory, 'assets'))).find((name) => name.startsWith('index-'))!;
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url!, 'http://localhost').pathname;
      if (path.startsWith('/assets/')) {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(await readFile(join(directory, path)));
      } else {
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><body><form><input type="file" accept="application/pdf"></form></body></html>');
      }
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  baseURL = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const mode of ['navigate', 'away-and-back', 'rerender'] as const) {
  test(`native browser history and file events: ${mode}`, async ({ page }) => {
    await page.goto(`${baseURL}/c/old-chat`);
    const result = await page.evaluate(async ({ entry, mode }) => {
      const { createFileUploadInterceptor } = await import(`/assets/${entry}`) as typeof import('../../src/modules/sites/chatgpt/file-upload');
      let finish!: (file: File) => void;
      let signal!: AbortSignal;
      let attached = 0;
      const interceptor = createFileUploadInterceptor({ indicator: false, processors: {
        pdf: (_file, nextSignal) => {
          signal = nextSignal;
          return new Promise<File>((resolve) => { finish = resolve; });
        },
      } });
      interceptor.start();
      const input = document.querySelector('input')!;
      const transfer = new DataTransfer();
      transfer.items.add(new File(['original'], 'original.pdf', { type: 'application/pdf' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (mode !== 'rerender') {
        history.pushState({}, '', '/c/new-chat');
        if (mode === 'away-and-back') history.replaceState({}, '', '/c/old-chat');
      }
      input.remove();
      const next = document.createElement('input');
      next.type = 'file'; next.accept = 'application/pdf';
      next.addEventListener('change', () => { attached++; });
      document.querySelector('form')!.append(next);
      finish(new File(['masked'], 'masked.pdf', { type: 'application/pdf' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = { attached, aborted: signal.aborted, name: next.files?.[0]?.name };
      interceptor.stop();
      return result;
    }, { entry, mode });
    if (mode === 'rerender') {
      expect(result).toEqual({ attached: 1, aborted: false, name: 'masked.pdf' });
    } else {
      expect(result.attached).toBe(0);
      expect(result.aborted).toBe(true);
      expect(result.name).toBeUndefined();
    }
  });
}
