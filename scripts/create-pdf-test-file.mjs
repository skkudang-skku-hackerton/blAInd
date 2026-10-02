import * as mupdf from 'mupdf';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const buffer = new mupdf.Buffer();
const writer = new mupdf.DocumentWriter(buffer, 'pdf', '');
const font = new mupdf.Font('ko');
try {
  for (const lines of [
    ['PDF 마스킹 테스트 1페이지', '이름: 김민수', '전화번호: 010-1234-5678', '이메일: minsu@example.com'],
    ['PDF 마스킹 테스트 2페이지', '이름: 김민수', '전화번호: 010-9876-5432', '동일 이름의 페이지별 선택을 확인합니다.'],
  ]) {
    const device = writer.beginPage([0, 0, 595, 842]);
    const text = new mupdf.Text();
    try {
      lines.forEach((line, index) => text.showString(font, [16, 0, 0, -16, 40, 70 + index * 40], line));
      device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
      device.close(); writer.endPage();
    } finally { text.destroy(); device.destroy(); }
  }
  writer.close();
  const directory = new URL('../tests/fixtures/', import.meta.url);
  const destination = new URL('pdf-flow-sample.pdf', directory);
  await mkdir(directory, { recursive: true });
  await writeFile(destination, buffer.asUint8Array());
  console.log(fileURLToPath(destination));
} finally { font.destroy(); writer.destroy(); buffer.destroy(); }
