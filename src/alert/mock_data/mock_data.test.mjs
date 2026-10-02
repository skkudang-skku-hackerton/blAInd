import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleDetections, sampleText } from './sample.ts';

import { analyzeDetections, buildReviewResult } from '../policy.ts';
import { EventEmitter } from 'node:events';
import { mockAlertTerminalPlugin } from './terminal-server.ts';

test('mock detections point to their expected source text using UTF-16 spans', () => {
  assert.equal(sampleDetections.length, 4);
  for (const detection of sampleDetections) {
    const { start, end } = detection.span;
    assert.ok(Number.isInteger(start) && Number.isInteger(end));
    assert.ok(start >= 0 && end > start && end <= sampleText.length);
  }

  assert.deepEqual(
    sampleDetections.map(({ span }) => sampleText.slice(span.start, span.end)),
    ['김민수', '010-1234-5678', 'minsu@example.com', 'AB-2048'],
  );
});

test('terminal middleware prints the same JSON returned by the alert', () => {
  const analysis = analyzeDetections(sampleText, sampleDetections);
  const decision = buildReviewResult(analysis, [analysis.confirmDetections[0]]);
  let middleware;
  mockAlertTerminalPlugin().configureServer({
    middlewares: { use(path, handler) {
      assert.equal(path, '/__blaind/mock-alert-result');
      middleware = handler;
    } },
  });
  const req = new EventEmitter();
  req.method = 'POST';
  req.setEncoding = () => {};
  const res = { writeHead(status) { assert.equal(status, 200); return this; }, end() {} };
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    middleware(req, res);
    req.emit('data', JSON.stringify(decision));
    req.emit('end');
  } finally { console.log = originalLog; }
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('최종 선택 결과'));
  assert.deepEqual(JSON.parse(lines[0].slice(lines[0].indexOf('{'))), decision);
});

test('proceeding without selections returns automatic and unselected items', () => {
  const analysis = analyzeDetections(sampleText, sampleDetections);
  assert.equal(analysis.autoMaskedDetections.length, 2);
  assert.equal(analysis.confirmDetections.length, 2);
  const result = buildReviewResult(analysis);
  assert.equal(result.status, 'approved');
  assert.deepEqual(result.autoMask.map(item => item.type), ['PHONE', 'EMAIL']);
  assert.deepEqual(result.confirm.masking, []);
  assert.deepEqual(result.confirm.nonMasking.map(item => item.word), ['김민수', 'AB-2048']);
  assert.deepEqual(Object.keys(result), ['status', 'autoMask', 'confirm']);
});

test('selecting a name produces the processor decision payload with source offsets', () => {
  const analysis = analyzeDetections(sampleText, sampleDetections);
  const selected = analysis.confirmDetections.filter(item => item.type === 'PERSON');
  const result = buildReviewResult(analysis, selected);
  assert.deepEqual(result.confirm.masking, [{
    segmentId: 'text', type: 'PERSON', span: { start: 7, end: 10 }, word: '김민수',
  }]);
  assert.deepEqual(result.confirm.nonMasking.map(item => item.type), ['GENERIC_ID']);
  for (const item of [...result.autoMask, ...result.confirm.masking, ...result.confirm.nonMasking]) {
    assert.equal(item.segmentId, 'text');
    assert.equal(sampleText.slice(item.span.start, item.span.end), item.word);
    assert.deepEqual(Object.keys(item), ['segmentId', 'type', 'span', 'word']);
  }
  assert.equal(analysis.originalText, sampleText);
});
