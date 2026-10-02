import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';

let server: Server;
let directory: string;
let url: string;
let entry: string;

test.beforeAll(async () => {
  directory = await mkdtemp('/tmp/opencode/docx-browser-');
  await build({ configFile: false, logLevel: 'error', worker: { format: 'es' }, build: {
    target: 'esnext', outDir: directory, minify: false,
    rollupOptions: { input: 'src/modules/documents/docx/index.ts', preserveEntrySignatures: 'strict' },
  } });
  entry = (await readdir(join(directory, 'assets'))).find((name) => name.startsWith('index-'))!;
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url!, 'http://localhost').pathname;
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Content-Security-Policy', "script-src 'self'; worker-src 'self'; object-src 'self'");
        response.end('<html><body>DOCX module harness</body></html>');
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

test('bundled DOCX Worker handles split runs through detector and Alert contracts', async ({ page }) => {
  test.setTimeout(60_000);
  const bytes = Array.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">김민수 010-</w:t></w:r><w:r><w:t>1234-5678</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'),
  }));
  await page.goto(url);
  const result = await page.evaluate(async ({ entry, bytes }) => {
    const module = await import(`/assets/${entry}`) as typeof import('../../src/modules/documents/docx');
    const stages: string[] = [], errors: string[] = [];
    const processor = module.createDocxProcessor({
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
    const output = await processor(new File([new Uint8Array(bytes)], 'input.docx'), new AbortController().signal);
    return { stages, errors, name: output?.name, type: output?.type,
      bytes: output ? Array.from(new Uint8Array(await output.arrayBuffer())) : null };
  }, { entry, bytes });
  expect(result.errors).toEqual([]);
  expect(result.stages).toEqual(['extracting', 'scanning', 'reviewing', 'rebuilding']);
  expect(result.name).toBe('masked-document.docx');
  expect(result.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  expect(result.bytes).not.toBeNull();
  const archive = unzipSync(new Uint8Array(result.bytes!));
  const xml = strFromU8(archive['word/document.xml']!);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const texts = Array.from(doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 't'));
  const text = texts.map((node) => node.textContent).join('');
  expect(text).toContain('김민수');
  expect(text).not.toContain('010-1234-5678');
  expect(text).not.toContain('1234-5678');
  expect(doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'b').length).toBe(1);
});
