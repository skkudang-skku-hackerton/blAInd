import { PII_TYPES } from '../../core/pii/types';
import { PiiError } from '../../core/api/errors';
import type { Detection, DetectionConstituent, PiiDetectorStatus, PiiErrorCode, SegmentDetectionResult, TextSegment } from '../../core/api/types';

export const PII_CHANNEL = 'blaind:pii:v1';
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
export type PiiTarget = 'background' | 'offscreen' | 'worker';
export type PiiRequest = {
  channel: typeof PII_CHANNEL;
  target: PiiTarget;
  requestId: string;
  clientId: string;
  /** Set by background from browser-authenticated sender metadata, never trusted from a client. */
  ownerKey?: string;
  /** Propagated to the worker so longer client deadlines are honored end-to-end. */
  requestTimeoutMs?: number;
} & ({ type: 'pii:init' } | { type: 'pii:scan-text'; text: string } |
  { type: 'pii:scan-segments'; segments: TextSegment[] });
export type PiiResponse = { channel: typeof PII_CHANNEL; requestId: string; clientId?: string; ownerKey?: string } & (
  { type: 'pii:ready' } |
  { type: 'pii:result'; result: Detection[] | SegmentDetectionResult[] } |
  { type: 'pii:error'; error: { code: PiiErrorCode; message: string } }
);
export interface PiiStatusMessage {
  channel: typeof PII_CHANNEL;
  type: 'pii:status';
  target: 'background' | 'client';
  status: PiiDetectorStatus;
}
export interface PiiCancelMessage {
  channel: typeof PII_CHANNEL;
  type: 'pii:cancel';
  target: PiiTarget;
  clientId: string;
  requestId: string;
  ownerKey?: string;
}
export interface MessageSender {
  id?: string; url?: string; tab?: { id?: number }; frameId?: number;
  documentId?: string; contextId?: string;
}
export function senderOwnershipKey(sender: MessageSender): string {
  // History/hash navigation must not change ownership of the same browser document.
  return JSON.stringify([sender.id, sender.contextId, sender.tab?.id, sender.frameId, sender.documentId,
    sender.contextId || sender.documentId ? undefined : sender.url]);
}
export function requestKey(request: Pick<PiiRequest, 'clientId' | 'requestId' | 'ownerKey'>): string {
  return JSON.stringify([request.ownerKey ?? '', request.clientId, request.requestId]);
}
export function scopedResponse(request: PiiRequest, response: PiiResponse): PiiResponse {
  return { ...response, clientId: request.clientId, ownerKey: request.ownerKey };
}
export function cancelMessage(request: PiiRequest): PiiCancelMessage {
  return { channel: PII_CHANNEL, target: request.target, type: 'pii:cancel',
    clientId: request.clientId, ownerKey: request.ownerKey, requestId: request.requestId };
}
export function isCancelMessage(value: unknown, target: PiiTarget): value is PiiCancelMessage {
  return isRecord(value) && value.channel === PII_CHANNEL && value.target === target && value.type === 'pii:cancel' &&
    typeof value.clientId === 'string' && !!value.clientId && typeof value.requestId === 'string' && !!value.requestId &&
    (value.ownerKey === undefined || typeof value.ownerKey === 'string');
}
export type MessageListener = (message: unknown, sender: MessageSender,
  sendResponse: (response: unknown) => void) => boolean | void;
export interface MessagingRuntime {
  id: string;
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  onMessage: { addListener(listener: MessageListener): void; removeListener(listener: MessageListener): void };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isSegments(value: unknown): value is TextSegment[] {
  return Array.isArray(value) && Array.from(value).every(segment => isRecord(segment) &&
    typeof segment.id === 'string' && typeof segment.text === 'string');
}
export function isPiiRequest(value: unknown, target?: PiiTarget): value is PiiRequest {
  if (!isRecord(value) || value.channel !== PII_CHANNEL ||
    typeof value.requestId !== 'string' || !value.requestId ||
    typeof value.clientId !== 'string' || !value.clientId ||
    (value.ownerKey !== undefined && typeof value.ownerKey !== 'string') ||
    !['background', 'offscreen', 'worker'].includes(String(value.target)) ||
    (target && value.target !== target) ||
    (value.requestTimeoutMs !== undefined && (typeof value.requestTimeoutMs !== 'number' ||
      !Number.isFinite(value.requestTimeoutMs) || value.requestTimeoutMs <= 0 || value.requestTimeoutMs > 2_147_483_647))) return false;
  return value.type === 'pii:init' || (value.type === 'pii:scan-text' && typeof value.text === 'string') ||
    (value.type === 'pii:scan-segments' && isSegments(value.segments));
}
export function isStatus(value: unknown): value is PiiDetectorStatus {
  if (!isRecord(value)) return false;
  return value.state === 'idle' || value.state === 'loading' ||
    (value.state === 'downloading' && typeof value.progress === 'number' &&
      Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 1) ||
    (value.state === 'ready' && (value.backend === 'webgpu' || value.backend === 'wasm')) ||
    (value.state === 'error' && typeof value.message === 'string');
}
export function isStatusMessage(value: unknown, target: PiiStatusMessage['target']): value is PiiStatusMessage {
  return isRecord(value) && value.channel === PII_CHANNEL && value.type === 'pii:status' &&
    value.target === target && isStatus(value.status);
}
const ERROR_CODES: PiiErrorCode[] = ['MODEL_NOT_READY', 'MODEL_DOWNLOAD_FAILED', 'MODEL_LOAD_FAILED',
  'INFERENCE_FAILED', 'OUT_OF_MEMORY', 'INVALID_INPUT', 'CANCELLED'];
export function errorResponse(requestId: string, error: unknown, fallback: PiiErrorCode = 'INFERENCE_FAILED'): PiiResponse {
  // Only public PiiError fields cross the boundary; raw exceptions/cause/stack never do.
  const safe = error instanceof PiiError ? error : new PiiError(fallback, 'PII request failed.');
  return { channel: PII_CHANNEL, requestId, type: 'pii:error', error: { code: safe.code, message: safe.message } };
}
function isConstituent(detection: unknown, length: number): detection is DetectionConstituent {
  return isRecord(detection) &&
    PII_TYPES.includes(detection.type as typeof PII_TYPES[number]) &&
    typeof detection.confidence === 'number' && Number.isFinite(detection.confidence) &&
    detection.confidence >= 0 && detection.confidence <= 1 && isRecord(detection.span) &&
    Number.isInteger(detection.span.start) && Number.isInteger(detection.span.end) &&
    (detection.span.start as number) >= 0 && (detection.span.end as number) > (detection.span.start as number) &&
    (detection.span.end as number) <= length;
}
function isDetection(value: unknown, length: number): value is Detection {
  if (!isConstituent(value, length)) return false;
  const detection = value as Detection;
  if (detection.constituents === undefined) return true;
  const members: unknown = detection.constituents;
  if (!Array.isArray(members) || members.length < 2 || !Array.from(members).every(member =>
    isConstituent(member, length) && !('constituents' in member) &&
    member.span.start >= detection.span.start && member.span.end <= detection.span.end)) return false;
  const sorted = [...members as DetectionConstituent[]].sort((a, b) => a.span.start - b.span.start);
  if (sorted[0]!.span.start !== detection.span.start) return false;
  let end = sorted[0]!.span.end;
  for (const member of sorted.slice(1)) {
    if (member.span.start >= end) return false;
    end = Math.max(end, member.span.end);
  }
  return end === detection.span.end;
}
function isDetections(value: unknown, length: number): value is Detection[] {
  return Array.isArray(value) && Array.from(value).every(detection => isDetection(detection, length));
}
export function validateResponse(value: unknown, request: PiiRequest): PiiResponse {
  const invalid = () => new PiiError('INFERENCE_FAILED', 'Invalid PII RPC response.');
  if (!isRecord(value) || value.channel !== PII_CHANNEL || value.requestId !== request.requestId ||
    value.clientId !== request.clientId || (request.ownerKey !== undefined && value.ownerKey !== request.ownerKey)) throw invalid();
  if (value.type === 'pii:error') {
    if (!isRecord(value.error) || !ERROR_CODES.includes(value.error.code as PiiErrorCode) ||
      typeof value.error.message !== 'string') throw invalid();
  } else if (request.type === 'pii:init') {
    if (value.type !== 'pii:ready') throw invalid();
  } else {
    if (value.type !== 'pii:result') throw invalid();
    if (request.type === 'pii:scan-text') {
      if (!isDetections(value.result, request.text.length)) throw invalid();
    } else if (!Array.isArray(value.result) || value.result.length !== request.segments.length ||
      !Array.from(value.result).every((result, i) => {
        const segment = request.segments[i];
        return segment !== undefined && isRecord(result) && result.segmentId === segment.id &&
          isDetections(result.detections, segment.text.length);
      })) throw invalid();
  }
  return value as unknown as PiiResponse;
}
export function unwrapResponse(value: unknown, request: PiiRequest): Detection[] | SegmentDetectionResult[] | undefined {
  const response = validateResponse(value, request);
  if (response.type === 'pii:error') throw new PiiError(response.error.code, response.error.message);
  return response.type === 'pii:result' ? response.result : undefined;
}
export function ownsSender(runtime: MessagingRuntime, sender: MessageSender): boolean {
  // Content scripts have a web-page URL; runtime-assigned extension ID is authoritative.
  return sender.id === runtime.id;
}
export function requestTimeout(value = DEFAULT_REQUEST_TIMEOUT_MS): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new PiiError('INVALID_INPUT', 'requestTimeoutMs must be a positive finite timer duration.');
  }
  return value;
}
