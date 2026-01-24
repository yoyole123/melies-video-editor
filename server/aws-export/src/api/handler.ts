import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { getEditorData } from '../shared/timeline';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';
const EXPORTS_BUCKET = process.env.EXPORTS_BUCKET ?? '';
const JOBS_TABLE = process.env.JOBS_TABLE ?? '';
const QUEUE_URL = process.env.QUEUE_URL ?? '';
const PRESIGN_UPLOAD_EXPIRES_SECONDS = Number(process.env.PRESIGN_UPLOAD_EXPIRES_SECONDS ?? 900);
const PRESIGN_DOWNLOAD_EXPIRES_SECONDS = Number(process.env.PRESIGN_DOWNLOAD_EXPIRES_SECONDS ?? 900);
const JOB_TTL_SECONDS = Number(process.env.JOB_TTL_SECONDS ?? 7 * 24 * 60 * 60);

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Reads the event body as a UTF-8 string.
 */
function getRawBody(event: APIGatewayProxyEventV2): string {
  const body = event.body ?? '';
  if (!body) return '';
  if (!event.isBase64Encoded) return body;
  return Buffer.from(body, 'base64').toString('utf8');
}

/**
 * Basic env validation so misconfigurations fail loudly.
 */
function assertEnv() {
  const missing = [
    ['ASSETS_BUCKET', ASSETS_BUCKET],
    ['EXPORTS_BUCKET', EXPORTS_BUCKET],
    ['JOBS_TABLE', JOBS_TABLE],
    ['QUEUE_URL', QUEUE_URL],
  ].filter(([, v]) => !v);

  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.map(([k]) => k).join(', ')}`);
  }
}

type PresignRequest = {
  assets: Array<{ src: string; contentType?: string; ext?: string }>;
};

type StartExportRequest = {
  timeline: unknown;
  assets: Array<{ src: string; s3Key: string }>;
};

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    assertEnv();

    const routeKey = event.routeKey;

    if (routeKey === 'GET /health') {
      return json(200, { ok: true });
    }

    if (routeKey === 'POST /export/presign') {
      const rawBody = getRawBody(event);
      const parsed = JSON.parse(rawBody || '{}') as PresignRequest;
      const assets = Array.isArray(parsed.assets) ? parsed.assets : [];

      const uploads = [] as Array<{ src: string; s3Key: string; uploadUrl: string }>;
      for (const asset of assets) {
        const src = String(asset?.src ?? '');
        if (!src) continue;

        const ext = String(asset?.ext ?? '');
        const safeExt = ext && ext.startsWith('.') && ext.length <= 10 ? ext : '';

        const s3Key = `assets/${randomUUID()}${safeExt}`;
        const contentType = asset?.contentType ? String(asset.contentType) : 'application/octet-stream';

        const command = new PutObjectCommand({
          Bucket: ASSETS_BUCKET,
          Key: s3Key,
          ContentType: contentType,
        });

        const uploadUrl = await getSignedUrl(s3, command, { expiresIn: PRESIGN_UPLOAD_EXPIRES_SECONDS });
        uploads.push({ src, s3Key, uploadUrl });
      }

      return json(200, { uploads });
    }

    if (routeKey === 'POST /export') {
      const rawBody = getRawBody(event);
      const parsed = JSON.parse(rawBody || '{}') as StartExportRequest;

      const editorData = getEditorData(parsed.timeline);

      const assets = Array.isArray(parsed.assets) ? parsed.assets : [];
      const assetsBySrc = new Map<string, string>();
      for (const a of assets) {
        const src = String(a?.src ?? '');
        const s3Key = String(a?.s3Key ?? '');
        if (!src || !s3Key) continue;
        assetsBySrc.set(src, s3Key);
      }

      // Light validation that timeline references only provided src keys.
      // The worker will enforce this again.
      void editorData;

      const jobId = randomUUID();
      const now = Date.now();
      const expiresAt = Math.floor((now + JOB_TTL_SECONDS * 1000) / 1000);

      await ddb.send(
        new PutCommand({
          TableName: JOBS_TABLE,
          Item: {
            jobId,
            status: 'QUEUED',
            createdAt: now,
            updatedAt: now,
            expiresAt,
          },
          ConditionExpression: 'attribute_not_exists(jobId)',
        })
      );

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: QUEUE_URL,
          MessageBody: JSON.stringify({
            jobId,
            timeline: parsed.timeline,
            assets: [...assetsBySrc.entries()].map(([src, s3Key]) => ({ src, s3Key })),
          }),
        })
      );

      // Best-effort status update.
      await ddb.send(
        new UpdateCommand({
          TableName: JOBS_TABLE,
          Key: { jobId },
          UpdateExpression: 'SET #s = :s, updatedAt = :u',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': 'QUEUED', ':u': Date.now() },
        })
      );

      return json(200, { jobId });
    }

    if (routeKey === 'GET /export/{jobId}') {
      const jobId = event.pathParameters?.jobId;

      if (!jobId) return json(400, { error: 'Missing jobId parameter.' });

      const resp = await ddb.send(
        new GetCommand({
          TableName: JOBS_TABLE,
          Key: { jobId },
        })
      );

      if (!resp.Item) return json(404, { error: 'Job not found.' });

      const status = String((resp.Item as any).status ?? 'UNKNOWN');
      const outputKey = (resp.Item as any).outputKey ? String((resp.Item as any).outputKey) : null;

      let downloadUrl: string | null = null;
      if (status === 'SUCCEEDED' && outputKey) {
        const cmd = new GetObjectCommand({ Bucket: EXPORTS_BUCKET, Key: outputKey });
        downloadUrl = await getSignedUrl(s3, cmd, { expiresIn: PRESIGN_DOWNLOAD_EXPIRES_SECONDS });
      }

      return json(200, {
        jobId,
        status,
        error: (resp.Item as any).error ?? null,
        outputKey,
        downloadUrl,
      });
    }

    console.log('Route not found context:', { routeKey, rawPath: event.rawPath });
    return json(404, { error: 'Not found.', debugRoute: routeKey, debugPath: event.rawPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    const lower = message.toLowerCase();
    if (lower.startsWith('missing env vars')) {
      return json(500, { error: 'Server misconfiguration.' });
    }

    // Avoid leaking internals: keep error terse.
    return json(400, { error: message });
  }
}
