# AWS Export (API Gateway + Lambda)

This folder contains an AWS-native implementation of the current `POST /export` (see `server/index.mjs`) that works well behind API Gateway.

Why it looks different than the Express version:
- **API Gateway payload limits** make uploading large video assets in a single multipart request impractical.
- We instead upload assets to **S3 via presigned URLs**, then call `/export` with a small JSON payload.
- Rendering runs in a **Lambda worker (container image)** that includes `ffmpeg`.

## Architecture

- **HTTP API (API Gateway)**
  - `GET /health`
  - `POST /export/presign` → returns presigned S3 PUT URLs for assets
  - `POST /export` → creates an export job + enqueues it
  - `GET /export/{jobId}` → returns status + (when complete) a presigned download URL
- **S3 (assets bucket)**: uploaded source media
- **S3 (exports bucket)**: rendered `mp4` outputs
- **SQS**: job queue
- **DynamoDB**: job tracking
- **Lambda (API)**: handles API Gateway requests
- **Lambda (Worker)**: consumes SQS jobs, runs `ffmpeg`, uploads output

## Security (trusted callers)

All `/export*` endpoints require **HMAC-signed requests** (including polling/downloading).

Headers:
- `x-base44-timestamp`: unix epoch ms
- `x-base44-signature`: hex HMAC-SHA256 signature

The signed string is:

```
${timestamp}.${method}.${path}.${rawBody}
```

Signature (Node example):

```js
import crypto from 'crypto';

function sign({ secret, timestamp, method, path, bodyString }) {
  const msg = `${timestamp}.${method}.${path}.${bodyString}`;
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
}
```

The API rejects requests if:
- timestamp is older/newer than 5 minutes
- signature does not match

The secret is stored in **AWS Secrets Manager** and read by the lambdas.

After deploy, fetch the secret value (for configuring Base44 + your dev client):

1. Find the secret ARN from the CDK output `ExportSigningSecretArn`
2. Read it:
  - `aws secretsmanager get-secret-value --secret-id <arn> --query SecretString --output text`

## Request/Response shapes

### 1) Presign uploads

`POST /export/presign`

Body:
```json
{ "assets": [{ "src": "...", "contentType": "video/mp4", "ext": ".mp4" }] }
```

Response:
```json
{ "uploads": [{ "src": "...", "s3Key": "assets/<uuid>.mp4", "uploadUrl": "https://..." }] }
```

Upload each file with HTTP PUT to `uploadUrl` using the provided `content-type`.

### 2) Start export

`POST /export`

Body:
```json
{
  "timeline": { "editorData": [] },
  "assets": [{ "src": "<src used in timeline>", "s3Key": "assets/<uuid>.mp4" }]
}
```

Response:
```json
{ "jobId": "..." }
```

### 3) Poll status / download

`GET /export/{jobId}`

Response (queued/running):
```json
{ "jobId": "...", "status": "RUNNING" }
```

Response (done):
```json
{ "jobId": "...", "status": "SUCCEEDED", "downloadUrl": "https://..." }
```

## Deploy (CDK)

From this folder:

1. Install deps:
   - `pnpm install` (or `npm install`)
2. Bootstrap (first time per account/region):
   - `npx cdk bootstrap`
3. Deploy:
   - `npx cdk deploy`

Outputs include:
- API endpoint
- Secrets Manager ARN for the signing secret

## Dev vs prod

The CDK stack currently uses `RemovalPolicy.DESTROY` + `autoDeleteObjects: true` on buckets/tables to keep iteration easy.
For production, switch these to `RETAIN` and add explicit lifecycle rules.

## Notes on performance

- The worker Lambda is configured with high memory and large ephemeral storage for faster encoding.
- For very long timelines, consider moving the worker to ECS/Fargate; the API/job model remains the same.
