import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { buildFfmpegArgs, runFfmpeg } from '../../src/shared/ffmpegPlan.js';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';
const EXPORTS_BUCKET = process.env.EXPORTS_BUCKET ?? '';
const JOBS_TABLE = process.env.JOBS_TABLE ?? '';
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';

/**
 * Writes a stream body from AWS SDK v3 GetObject into a file.
 */
async function writeStreamToFile(body, filePath) {
  if (!body) throw new Error('Empty S3 body.');

  // In Node.js runtime, Body is a Readable.
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  const buf = Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(c)));
  await fs.writeFile(filePath, buf);
}

/**
 * Downloads an S3 object to local disk.
 */
async function downloadToFile({ bucket, key, filePath }) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await writeStreamToFile(resp.Body, filePath);
}

/**
 * Uploads a local file to S3.
 */
async function uploadFile({ bucket, key, filePath, contentType }) {
  const body = await fs.readFile(filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

async function setJobStatus(jobId, status, extra = {}) {
  const now = Date.now();
  const exprNames = { '#s': 'status' };
  const exprValues = { ':s': status, ':u': now };

  let updateExpr = 'SET #s = :s, updatedAt = :u';

  for (const [k, v] of Object.entries(extra)) {
    const nameKey = `#${k}`;
    const valueKey = `:${k}`;
    exprNames[nameKey] = k;
    exprValues[valueKey] = v;
    updateExpr += `, ${nameKey} = ${valueKey}`;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    })
  );
}

/**
 * SQS worker: consumes export jobs and renders via ffmpeg.
 */
export async function handler(event) {
  const records = Array.isArray(event?.Records) ? event.Records : [];

  for (const record of records) {
    const message = JSON.parse(record.body || '{}');
    const jobId = String(message.jobId || '');
    const timeline = message.timeline;
    const assets = Array.isArray(message.assets) ? message.assets : [];

    if (!jobId) continue;

    const tmpDir = path.join(os.tmpdir(), `melies-export-${jobId}-${randomUUID()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    try {
      await setJobStatus(jobId, 'RUNNING');

      const editorData = timeline?.editorData;
      if (!Array.isArray(editorData)) {
        throw new Error('Invalid timeline: missing editorData array.');
      }

      const assetsBySrc = new Map();
      for (const a of assets) {
        const src = String(a?.src ?? '');
        const s3Key = String(a?.s3Key ?? '');
        if (!src || !s3Key) continue;

        const ext = path.extname(s3Key) || '.bin';
        const localPath = path.join(tmpDir, `asset-${randomUUID()}${ext}`);
        await downloadToFile({ bucket: ASSETS_BUCKET, key: s3Key, filePath: localPath });
        assetsBySrc.set(src, localPath);
      }

      const outPath = path.join(tmpDir, 'export.mp4');
      const ffmpegArgs = buildFfmpegArgs({ editorData, assetsBySrc, outPath });

      await runFfmpeg({ ffmpegPath: FFMPEG_PATH, args: ffmpegArgs, cwd: tmpDir });

      const outputKey = `exports/${jobId}.mp4`;
      await uploadFile({ bucket: EXPORTS_BUCKET, key: outputKey, filePath: outPath, contentType: 'video/mp4' });

      await setJobStatus(jobId, 'SUCCEEDED', { outputKey });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setJobStatus(jobId, 'FAILED', { error: message });
      throw err;
    } finally {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
