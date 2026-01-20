import path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Size, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodeLambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';

export class ExportStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const signingSecret = new secretsmanager.Secret(this, 'SigningSecret', {
      description: 'HMAC signing secret for Melies export endpoints.',
    });

    const assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const exportsBucket = new s3.Bucket(this, 'ExportsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const jobsTable = new dynamodb.Table(this, 'JobsTable', {
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const queue = new sqs.Queue(this, 'JobsQueue', {
      visibilityTimeout: Duration.minutes(20),
    });

    const apiLambda = new nodeLambda.NodejsFunction(this, 'ExportApiLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'src', 'api', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(15),
      memorySize: 512,
      environment: {
        ASSETS_BUCKET: assetsBucket.bucketName,
        EXPORTS_BUCKET: exportsBucket.bucketName,
        JOBS_TABLE: jobsTable.tableName,
        QUEUE_URL: queue.queueUrl,
        SIGNING_SECRET_ARN: signingSecret.secretArn,
        SIGNING_MAX_SKEW_SECONDS: '300',
        PRESIGN_UPLOAD_EXPIRES_SECONDS: '900',
        PRESIGN_DOWNLOAD_EXPIRES_SECONDS: '900',
        JOB_TTL_SECONDS: String(7 * 24 * 60 * 60),
      },
      bundling: {
        target: 'node20',
        format: nodeLambda.OutputFormat.CJS,
        minify: true,
        sourceMap: true,
      },
    });

    const workerLambda = new lambda.DockerImageFunction(this, 'ExportWorkerLambda', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '..'), {
        file: 'worker-image/Dockerfile',
      }),
      timeout: Duration.minutes(15),
      memorySize: 4096,
      ephemeralStorageSize: Size.gibibytes(10),
      environment: {
        ASSETS_BUCKET: assetsBucket.bucketName,
        EXPORTS_BUCKET: exportsBucket.bucketName,
        JOBS_TABLE: jobsTable.tableName,
        SIGNING_SECRET_ARN: signingSecret.secretArn,
        EXPORT_WIDTH: '1280',
        EXPORT_HEIGHT: '720',
        EXPORT_FPS: '30',
        EXPORT_AUDIO_RATE: '48000',
      },
    });

    // Permissions
    signingSecret.grantRead(apiLambda);
    signingSecret.grantRead(workerLambda);

    assetsBucket.grantReadWrite(apiLambda);
    exportsBucket.grantReadWrite(apiLambda);

    assetsBucket.grantRead(workerLambda);
    exportsBucket.grantWrite(workerLambda);

    jobsTable.grantReadWriteData(apiLambda);
    jobsTable.grantReadWriteData(workerLambda);

    queue.grantSendMessages(apiLambda);
    workerLambda.addEventSource(new lambdaEventSources.SqsEventSource(queue, { batchSize: 1 }));

    const httpApi = new apigwv2.HttpApi(this, 'ExportHttpApi', {
      apiName: 'melies-export-api',
    });

    const integration = new apigwv2Integrations.HttpLambdaIntegration('ExportApiIntegration', apiLambda);

    httpApi.addRoutes({ path: '/health', methods: [apigwv2.HttpMethod.GET], integration });
    httpApi.addRoutes({ path: '/export/presign', methods: [apigwv2.HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/export', methods: [apigwv2.HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/export/{jobId}', methods: [apigwv2.HttpMethod.GET], integration });

    // Useful outputs
    new CfnOutput(this, 'ExportApiEndpoint', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'ExportSigningSecretArn', { value: signingSecret.secretArn });
    new CfnOutput(this, 'ExportAssetsBucket', { value: assetsBucket.bucketName });
    new CfnOutput(this, 'ExportExportsBucket', { value: exportsBucket.bucketName });
  }
}
