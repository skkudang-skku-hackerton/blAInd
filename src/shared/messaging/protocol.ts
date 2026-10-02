export type BackgroundStatusRequest = {
  target: 'background';
  type: 'GET_BACKGROUND_STATUS';
};

export type BackgroundStatusResponse = {
  type: 'BACKGROUND_STATUS';
  status: 'ready';
  extensionVersion: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBackgroundStatusRequest(
  value: unknown,
): value is BackgroundStatusRequest {
  return (
    isRecord(value) &&
    value.target === 'background' &&
    value.type === 'GET_BACKGROUND_STATUS'
  );
}

export function isBackgroundStatusResponse(
  value: unknown,
): value is BackgroundStatusResponse {
  return (
    isRecord(value) &&
    value.type === 'BACKGROUND_STATUS' &&
    value.status === 'ready' &&
    typeof value.extensionVersion === 'string' &&
    value.extensionVersion.length > 0
  );
}
