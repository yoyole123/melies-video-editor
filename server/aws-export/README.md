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

All endpoints are protected by **AWS IAM (SigV4)** at API Gateway.

Call flow:

Browser (Base44)
→ Cognito **Identity Pool** (unauthenticated)
→ short-lived AWS credentials (issued by Cognito/STS)
→ API Gateway HTTP API (**IAM auth**)
→ Lambda

Properties:
- No API keys or secrets in the client
- No user login required
- Credentials expire automatically
- IAM policy can be scoped to only `execute-api:Invoke` for this API

### CORS (strict)

The stack configures CORS with a strict allowlist.

Current allowlist is hardcoded in the CDK stack as:
- `https://sparkle-stories-c8b62fef.base44.app`

If you need local dev origins, add them to `allowedOrigins` in the CDK stack.

Note: Presigned S3 uploads/downloads also require S3 bucket CORS rules for the same origin.
The CDK stack configures bucket CORS for the same allowlist so browser PUT/GET requests work.

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
- `ExportApiBaseUrl` (includes the stage, e.g. `.../prod`)
- `ExportApiId`
- `ExportStageName`
- `ExportIdentityPoolId`
- `ExportRegion`

## JS client helper

See [server/aws-export/client/README.md](server/aws-export/client/README.md) for a browser-friendly JavaScript helper (`iamExportClient.js`) that:
- obtains unauth Cognito Identity Pool credentials
- SigV4-signs requests to API Gateway (AWS_IAM)

## Dev vs prod

The CDK stack currently uses `RemovalPolicy.DESTROY` + `autoDeleteObjects: true` on buckets/tables to keep iteration easy.
For production, switch these to `RETAIN` and add explicit lifecycle rules.

## Notes on performance

- The worker Lambda is configured with high memory and large ephemeral storage for faster encoding.
- For very long timelines, consider moving the worker to ECS/Fargate; the API/job model remains the same.
