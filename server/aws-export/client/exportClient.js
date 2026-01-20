import crypto from 'node:crypto';

/**
 * Computes the signature used by the Export API.
 *
 * Signed message format:
 * `${timestampMs}.${method}.${path}.${rawBody}`
 *
 * @param {object} params
 * @param {string} params.secret HMAC secret
 * @param {number} params.timestampMs Unix epoch millis
 * @param {string} params.method HTTP method (e.g. POST)
 * @param {string} params.path Path only (e.g. /export)
 * @param {string} params.rawBody Exact request body string ('' for empty)
 */
export function computeExportSignature({ secret, timestampMs, method, path, rawBody }) {
  const msg = `${timestampMs}.${String(method).toUpperCase()}.${path}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
}

/**
 * Builds headers for a signed request.
 *
 * @param {object} params
 * @param {string} params.secret
 * @param {string} params.method
 * @param {string} params.path
 * @param {string} params.rawBody
 */
export function buildSignedHeaders({ secret, method, path, rawBody }) {
  const timestampMs = Date.now();
  const signature = computeExportSignature({ secret, timestampMs, method, path, rawBody });

  return {
    'x-base44-timestamp': String(timestampMs),
    'x-base44-signature': signature,
  };
}

/**
 * Performs a signed fetch to the Export API.
 *
 * Notes:
 * - `path` MUST match the Lambda's `event.rawPath` (no query string).
 * - `rawBody` MUST be the exact string sent over the wire.
 *
 * @param {object} params
 * @param {string} params.baseUrl API base URL (e.g. https://abc.execute-api.us-east-1.amazonaws.com)
 * @param {string} params.secret Signing secret
 * @param {string} params.path Request path, starting with '/'
 * @param {string} [params.method]
 * @param {object} [params.headers]
 * @param {string|undefined} [params.bodyString]
 */
export async function signedFetch({ baseUrl, secret, path, method = 'GET', headers = {}, bodyString }) {
  const url = new URL(path, baseUrl);

  const rawBody = typeof bodyString === 'string' ? bodyString : '';
  const sigHeaders = buildSignedHeaders({ secret, method, path, rawBody });

  const resp = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...sigHeaders,
    },
    body: bodyString,
  });

  const contentType = resp.headers.get('content-type') || '';
  const isJson = contentType.toLowerCase().includes('application/json');
  const body = isJson ? await resp.json() : await resp.text();

  if (!resp.ok) {
    const msg = typeof body === 'object' && body && body.error ? body.error : JSON.stringify(body);
    const err = new Error(`Export API request failed (${resp.status}): ${msg}`);
    err.status = resp.status;
    err.body = body;
    throw err;
  }

  return body;
}

/**
 * Requests presigned S3 upload URLs.
 *
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} params.secret
 * @param {Array<{src: string, contentType?: string, ext?: string}>} params.assets
 */
export async function presignUploads({ baseUrl, secret, assets }) {
  const path = '/export/presign';
  const bodyString = JSON.stringify({ assets });
  return await signedFetch({
    baseUrl,
    secret,
    path,
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    bodyString,
  });
}

/**
 * Uploads a file/blob/buffer to a presigned S3 URL.
 *
 * @param {object} params
 * @param {string} params.uploadUrl
 * @param {Blob|ArrayBuffer|Uint8Array|Buffer} params.body
 * @param {string} [params.contentType]
 */
export async function uploadToPresignedUrl({ uploadUrl, body, contentType }) {
  const resp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: contentType ? { 'content-type': contentType } : undefined,
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`S3 upload failed (${resp.status}): ${text}`);
  }
}

/**
 * Starts an export job.
 *
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} params.secret
 * @param {object} params.timeline Must contain { editorData: [...] }
 * @param {Array<{src: string, s3Key: string}>} params.assets
 */
export async function startExport({ baseUrl, secret, timeline, assets }) {
  const path = '/export';
  const bodyString = JSON.stringify({ timeline, assets });
  return await signedFetch({
    baseUrl,
    secret,
    path,
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    bodyString,
  });
}

/**
 * Gets current status of an export job.
 *
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} params.secret
 * @param {string} params.jobId
 */
export async function getExportJob({ baseUrl, secret, jobId }) {
  const path = `/export/${jobId}`;
  return await signedFetch({ baseUrl, secret, path, method: 'GET' });
}

/**
 * Polls until the job is done (SUCCEEDED/FAILED) or times out.
 *
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} params.secret
 * @param {string} params.jobId
 * @param {number} [params.timeoutMs]
 * @param {number} [params.intervalMs]
 */
export async function waitForExport({ baseUrl, secret, jobId, timeoutMs = 10 * 60_000, intervalMs = 1500 }) {
  const start = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await getExportJob({ baseUrl, secret, jobId });
    const status = String(job.status || '');

    if (status === 'SUCCEEDED' || status === 'FAILED') return job;

    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for export job ${jobId}`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Convenience helper that runs the full flow:
 * 1) presign uploads
 * 2) upload all assets (in parallel)
 * 3) start export
 * 4) optionally wait for completion
 *
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} params.secret
 * @param {object} params.timeline
 * @param {Array<{src: string, body: Blob|ArrayBuffer|Uint8Array|Buffer, contentType?: string, ext?: string}>} params.assets
 * @param {boolean} [params.wait]
 */
export async function exportVideo({ baseUrl, secret, timeline, assets, wait = true }) {
  const presignResp = await presignUploads({
    baseUrl,
    secret,
    assets: assets.map((a) => ({ src: a.src, contentType: a.contentType, ext: a.ext })),
  });

  const uploads = Array.isArray(presignResp.uploads) ? presignResp.uploads : [];
  const uploadBySrc = new Map(uploads.map((u) => [u.src, u]));

  await Promise.all(
    assets.map(async (a) => {
      const u = uploadBySrc.get(a.src);
      if (!u) throw new Error(`Missing presign response for src: ${a.src}`);
      await uploadToPresignedUrl({ uploadUrl: u.uploadUrl, body: a.body, contentType: a.contentType });
    })
  );

  const startResp = await startExport({
    baseUrl,
    secret,
    timeline,
    assets: uploads.map((u) => ({ src: u.src, s3Key: u.s3Key })),
  });

  const jobId = String(startResp.jobId || '');
  if (!jobId) throw new Error('Missing jobId from /export response.');

  if (!wait) return { jobId };
  return await waitForExport({ baseUrl, secret, jobId });
}
