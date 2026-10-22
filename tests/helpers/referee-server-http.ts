// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Shared response and bounded body handling for the loopback reference host.
// ABOUTME: Preserve the dashboard's transport error shape and enforce decompressed request limits.
import http from 'http';
import { gunzipSync } from 'zlib';
export const json = (response: http.ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
};
export const status = (
  code: string,
  message: string,
  httpStatus: number,
  extra: Record<string, unknown> = {}
) => ({
  httpStatus,
  body: {
    success: false,
    error: message,
    hint: 'See the reference server contract.',
    code,
    ...extra,
  },
});
export async function body(
  request: http.IncomingMessage,
  limit: number
): Promise<Buffer | 'too large' | 'corrupt'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) return 'too large';
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks);
  if (request.headers['content-encoding'] !== 'gzip') return raw;
  try {
    return gunzipSync(raw, { maxOutputLength: limit });
  } catch (error) {
    return (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'too large' : 'corrupt';
  }
}
