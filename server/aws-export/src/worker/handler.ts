import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import type { Readable } from 'node:stream';

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { buildFfmpegArgs, runFfmpeg } from '../shared/ffmpegPlan';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';
const EXPORTS_BUCKET = process.env.EXPORTS_BUCKET ?? '';
const JOBS_TABLE = process.env.JOBS_TABLE ?? '';
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';

type ExportJobMessage = {
  jobId: string;
  timeline: { editorData?: unknown };
  assets: Array<{ src: string; s3Key: string }>;
};

/**
 * Streams an S3 object body to disk.
 */
async function downloadToFile(params: { bucket: string; key: string; filePath: string }): Promise<void> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: params.bucket, Key: params.key }));
  const body = resp.Body as Readable | undefined;
  if (!body) throw new Error(`Empty S3 body for ${params.bucket}/${params.key}`);

  await pipeline(body, fs.createWriteStream(params.filePath));
}

/**
 * Uploads a local file to S3 (streamed).
 */
async function uploadFile(params: {
  bucket: string;
  key: string;
  filePath: string;
  contentType: string;
}): Promise<void> {
  const stream = fs.createReadStream(params.filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: stream,
      ContentType: params.contentType,
    })
  );
}

/**
 * Updates a job record status in DynamoDB.
 */
async function setJobStatus(jobId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const now = Date.now();
  const exprNames: Record<string, string> = { '#s': 'status' };
  const exprValues: Record<string, unknown> = { ':s': status, ':u': now };

  let updateExpr = 'SET #s = :s, updatedAt = :u';

  for (const [key, value] of Object.entries(extra)) {
    const nameKey = `#${key}`;
    const valueKey = `:${key}`;
    exprNames[nameKey] = key;
    exprValues[valueKey] = value;
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

function assertEnv(): void {
  const missing = [
    ['ASSETS_BUCKET', ASSETS_BUCKET],
    ['EXPORTS_BUCKET', EXPORTS_BUCKET],
    ['JOBS_TABLE', JOBS_TABLE],
  ].filter(([, v]) => !v);

  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.map(([k]) => k).join(', ')}`);
  }
}

/**
 * SQS worker: consumes export jobs and renders via ffmpeg.
 */
export async function handler(event: { Records?: Array<{ body: string }> }): Promise<void> {
  assertEnv();

  const records = Array.isArray(event?.Records) ? event.Records : [];

  for (const record of records) {
    const message = JSON.parse(record.body || '{}') as Partial<ExportJobMessage>;
    const jobId = String(message.jobId || '');

    if (!jobId) continue;

    const timeline = message.timeline ?? {};
    const editorData = (timeline as { editorData?: unknown }).editorData;
    if (!Array.isArray(editorData)) {
      await setJobStatus(jobId, 'FAILED', { error: 'Invalid timeline: missing editorData array.' });
      continue;
    }

    const assets = Array.isArray(message.assets) ? message.assets : [];

    const tmpDir = path.join(os.tmpdir(), `melies-export-${jobId}-${randomUUID()}`);
    await fsp.mkdir(tmpDir, { recursive: true });

    try {
      await setJobStatus(jobId, 'RUNNING');

      const assetsBySrc = new Map<string, string>();
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
      const error = err instanceof Error ? err.message : String(err);
      await setJobStatus(jobId, 'FAILED', { error });
      // Throw to trigger SQS retry for transient failures.
      throw err;
    } finally {
      try {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
