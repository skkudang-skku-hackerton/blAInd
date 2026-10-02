import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { strToU8, unzipSync, strFromU8, zipSync } from 'fflate';

let server: Server;
let directory: string;
let url: string;
let entry: string;

test.beforeAll(async () => {
  directory = await mkdtemp('/tmp/opencode/hwpx-browser-');
  await build({ configFile: false, logLevel: 'error', worker: { format: 'es' }, build: {
    target: 'esnext', outDir: directory, minify: false,
    rollupOptions: { input: 'src/modules/documents/hwpx/index.ts', preserveEntrySignatures: 'strict' },
  } });
  entry = (await readdir(join(directory, 'assets'))).find((name) => name.startsWith('index-'))!;
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url!, 'http://localhost').pathname;
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Content-Security-Policy', "script-src 'self'; worker-src 'self'; object-src 'self'");
        response.end('<html><body>HWPX module harness</body></html>');
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

test('bundled HWPX Worker extracts, reviews and rebuilds a masked document', async ({ page }) => {
  const hp = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
  const bytes = Array.from(zipSync({
    mimetype: strToU8('application/hwp+zip'),
    'version.xml': strToU8('<HCFVersion version="1.5.0.0"/>'),
    'META-INF/manifest.xml': strToU8('<manifest/>'),
    'Contents/content.hpf': strToU8('<opf/>'),
    'Contents/section0.xml': strToU8(`<hp:sec xmlns:hp="${hp}"><hp:p><hp:run><hp:t>김민수 전화 010-</hp:t></hp:run><hp:run><hp:t>1234-5678입니다.</hp:t></hp:run></hp:p></hp:sec>`),
  }));
  await page.goto(url);
  const result = await page.evaluate(async ({ entry, bytes }) => {
    const module = await import(`/assets/${entry}`) as typeof import('../../src/modules/documents/hwpx');
    const stages: string[] = [], errors: string[] = [];
    const processor = module.createHwpxProcessor({
      detector: {
        initialize: async () => {}, scanText: async () => [],
        scanSegments: async (segments) => segments.map(({ id, text }) => ({ segmentId: id, detections: [
          { type: 'PERSON', confidence: 1, span: { start: text.indexOf('김민수'), end: text.indexOf('김민수') + 3 } },
          { type: 'PHONE', confidence: 1, span: { start: text.indexOf('010'), end: text.indexOf('010') + 13 } },
        ] })),
      },
      review: async (request) => ({ status: 'approved',
        autoMask: request.segments.flatMap((segment) => segment.detections.filter(({ type }) => type === 'PHONE').map(({ type, span, word }) => ({ segmentId: segment.id, type, span, word }))),
        confirm: { masking: request.segments.flatMap((segment) => segment.detections.filter(({ type }) => type === 'PERSON').map(({ type, span, word }) => ({ segmentId: segment.id, type, span, word }))), nonMasking: [] },
      }),
      onStage: (stage) => stages.push(stage), onError: (error) => errors.push(String(error)),
    });
    const output = await processor(new File([new Uint8Array(bytes)], 'demo.hwpx'), new AbortController().signal);
    return { stages, errors, name: output?.name, type: output?.type,
      bytes: output ? Array.from(new Uint8Array(await output.arrayBuffer())) : null };
  }, { entry, bytes });
  expect(result.errors).toEqual([]);
  expect(result.stages).toEqual(['extracting', 'scanning', 'reviewing', 'rebuilding']);
  expect(result.name).toBe('masked-document.hwpx');
  expect(result.type).toBe('application/hwp+zip');
  const archive = unzipSync(new Uint8Array(result.bytes!));
  const xml = strFromU8(archive['Contents/section0.xml']!);
  expect(xml).not.toContain('김민수');
  expect(xml).not.toContain('010-1234-5678');
  expect(strFromU8(archive.mimetype!)).toBe('application/hwp+zip');
});
