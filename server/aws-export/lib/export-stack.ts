import path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Size, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodeLambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';

export class ExportStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const stageName = 'prod';
    const allowedOrigins = ['https://sparkle-stories-c8b62fef.base44.app'];

    const assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedOrigins: allowedOrigins,
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: Duration.days(10).toSeconds(),
        },
      ],
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const exportsBucket = new s3.Bucket(this, 'ExportsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedOrigins: allowedOrigins,
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: Duration.days(10).toSeconds(),
        },
      ],
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
        exclude: ['node_modules', 'cdk.out', '.git', '.vscode'],
      }),
      timeout: Duration.minutes(15),
      memorySize: 4096,
      ephemeralStorageSize: Size.gibibytes(10),
      environment: {
        ASSETS_BUCKET: assetsBucket.bucketName,
        EXPORTS_BUCKET: exportsBucket.bucketName,
        JOBS_TABLE: jobsTable.tableName,
        EXPORT_WIDTH: '1280',
        EXPORT_HEIGHT: '720',
        EXPORT_FPS: '30',
        EXPORT_AUDIO_RATE: '48000',
      },
    });

    // Permissions
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
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowHeaders: [
          'content-type',
          'authorization',
          'x-amz-date',
          'x-amz-security-token',
          'x-amz-content-sha256',
        ],
        maxAge: Duration.days(10),
      },
    });

    const stage = new apigwv2.HttpStage(this, 'ExportHttpStage', {
      httpApi,
      stageName,
      autoDeploy: true,
    });

    const iamAuthorizer = new apigwv2Authorizers.HttpIamAuthorizer();

    const integration = new apigwv2Integrations.HttpLambdaIntegration('ExportApiIntegration', apiLambda);

    httpApi.addRoutes({ path: '/health', methods: [apigwv2.HttpMethod.GET], integration, authorizer: iamAuthorizer });
    httpApi.addRoutes({
      path: '/export/presign',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: iamAuthorizer,
    });
    httpApi.addRoutes({ path: '/export', methods: [apigwv2.HttpMethod.POST], integration, authorizer: iamAuthorizer });
    httpApi.addRoutes({
      path: '/export/{jobId}',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: iamAuthorizer,
    });

    // Cognito Identity Pool (unauthenticated) -> temporary AWS credentials for browser callers.
    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      allowUnauthenticatedIdentities: true,
    });

    const guestRole = new iam.Role(this, 'GuestRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'unauthenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
    });

    guestRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [
          httpApi.arnForExecuteApi('*', '/health', stageName),
          httpApi.arnForExecuteApi('*', '/export*', stageName),
        ],
      })
    );

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: identityPool.ref,
      roles: {
        unauthenticated: guestRole.roleArn,
      },
    });

    // Useful outputs
    new CfnOutput(this, 'ExportApiBaseUrl', { value: stage.url });
    new CfnOutput(this, 'ExportApiId', { value: httpApi.apiId });
    new CfnOutput(this, 'ExportStageName', { value: stage.stageName });
    new CfnOutput(this, 'ExportIdentityPoolId', { value: identityPool.ref });
    new CfnOutput(this, 'ExportRegion', { value: this.region });
    new CfnOutput(this, 'ExportAssetsBucket', { value: assetsBucket.bucketName });
    new CfnOutput(this, 'ExportExportsBucket', { value: exportsBucket.bucketName });
  }
}
