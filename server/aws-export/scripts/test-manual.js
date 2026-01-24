/**
 * Manual verification script for the IAM-protected Export API.
 * 
 * Usage:
 * 1. Deploy the stack: `cdk deploy --outputs-file output.json`
 * 2. Run this script with options from the output file:
 *    export API_URL="https://..."
 *    export REGION="il-central-1"
 *    export IDENTITY_POOL_ID="..."
 *    node scripts/test-manual.js
 */

const { createExportIamClient } = require('../client/iamExportClient.js');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const API_URL = process.env.API_URL;
const REGION = process.env.REGION;
const IDENTITY_POOL_ID = process.env.IDENTITY_POOL_ID;

if (!API_URL || !REGION || !IDENTITY_POOL_ID) {
  console.error('Error: Missing environment variables.');
  console.error('Usage (PowerShell):');
  console.error('  $env:API_URL="https://..."; $env:REGION="..."; $env:IDENTITY_POOL_ID="..."; node scripts/test-manual.js');
  process.exit(1);
}

const client = createExportIamClient({
  apiBaseUrl: API_URL,
  region: REGION,
  identityPoolId: IDENTITY_POOL_ID,
});

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;

/**
 * Upload a local file to a presigned S3 PUT URL.
 */
async function uploadFileToPresignedUrl({ uploadUrl, filePath, contentType }) {
  const absPath = path.resolve(filePath);
  const body = await fs.promises.readFile(absPath);

  const resp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'content-type': contentType || 'application/octet-stream',
      'content-length': String(body.length),
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`S3 upload failed (${resp.status}): ${text}`);
  }
}

/**
 * Polls the Export API until the job is SUCCEEDED/FAILED or times out.
 */
async function waitForJobDone({ jobId, timeoutMs = DEFAULT_JOB_TIMEOUT_MS, intervalMs = DEFAULT_POLL_INTERVAL_MS }) {
  const startedAt = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = await client.getJob(jobId);
    const state = String(status.status || '');

    if (state === 'SUCCEEDED' || state === 'FAILED') return status;

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for export job ${jobId}`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Downloads a URL to a local file.
 */
async function downloadToFile({ url, outPath }) {
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Download failed (${resp.status}): ${text}`);
  }

  if (!resp.body) throw new Error('Missing response body while downloading.');

  // Node fetch returns a web stream; convert to a Node readable.
  const readable = Readable.fromWeb(resp.body);
  await pipeline(readable, fs.createWriteStream(outPath));
}

async function run() {
  try {
    console.log('--- Testing /health ---');
    const health = await client.health();
    console.log('Health:', health);

    console.log('\n--- Testing /export/presign ---');
    const localTestFile = path.join(__dirname, 'test1.mp4');
    if (!fs.existsSync(localTestFile)) {
      throw new Error(`Missing local test footage file: ${localTestFile}`);
    }

    // `src` is just an identifier that must match timeline action.data.src.
    // It does NOT have to be a real URL (the worker uses it as a map key).
    const assetSrc = 'file://./test1.mp4';

    const presign = await client.presignAssets([{ src: assetSrc, ext: '.mp4', contentType: 'video/mp4' }]);
    if (!presign?.uploads?.length) throw new Error('Presign response missing uploads.');

    console.log(`Received ${presign.uploads.length} upload URLs.`);
    console.log('First upload URL:', presign.uploads[0].uploadUrl.substring(0, 50) + '...');

    console.log('\n--- Uploading test1.mp4 to presigned S3 URL ---');
    const upload = presign.uploads.find((u) => u && u.src === assetSrc) || presign.uploads[0];
    await uploadFileToPresignedUrl({
      uploadUrl: upload.uploadUrl,
      filePath: localTestFile,
      contentType: 'video/mp4',
    });
    console.log('Upload complete. s3Key:', upload.s3Key);

    console.log('\n--- Testing /export (Job Creation) ---');
    // Minimal real timeline that places the clip at t=2s and ends at t=3s.
    // Notes:
    // - The worker/render plan only reads: row.actions[].effectId/start/end/data.src
    // - For video, effectId must be 'effect1'
    // - Melies represents embedded audio as a separate action with effectId 'effect2'
    const linkId = 'link-1';
    const timeline = {
      version: 1,
      editorData: [
        { id: '0', actions: [] },
        {
          id: '1',
          actions: [
            {
              id: 'action-1',
              effectId: 'effect1',
              start: 2,
              end: 3,
              data: { src: assetSrc, linkId },
            },
          ],
        },
        { id: '2', actions: [] },
        {
          id: '3',
          actions: [
            {
              id: 'action-2',
              effectId: 'effect2',
              start: 2,
              end: 3,
              data: { src: assetSrc, linkId },
            },
          ],
        },
      ],
    };

    const job = await client.startExport({
      timeline,
      assets: [{ src: upload.src, s3Key: upload.s3Key }],
    });
    console.log('Job Started:', job);

    console.log('\n--- Waiting for completion ---');
    const done = await waitForJobDone({ jobId: job.jobId });
    console.log('Job Status:', done);

    if (String(done.status) !== 'SUCCEEDED') {
      throw new Error(`Job did not succeed: status=${String(done.status)} error=${String(done.error || '')}`);
    }

    if (!done.downloadUrl) {
      throw new Error('Missing downloadUrl on SUCCEEDED job response.');
    }

    console.log('\n--- Downloading rendered video ---');
    const outPath = path.resolve(process.cwd(), `melies-export-${job.jobId}.mp4`);
    await downloadToFile({ url: done.downloadUrl, outPath });
    console.log('Downloaded:', outPath);

    console.log('\n✅ detailed verification complete.');

  } catch (err) {
    console.error('\n❌ Test Failed:', err && err.message ? err.message : err);
    if (err.cause) console.error(err.cause);
    process.exit(1);
  }
}

run();