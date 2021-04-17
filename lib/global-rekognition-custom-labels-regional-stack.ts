import * as cdk from "@aws-cdk/core";
import * as s3 from "@aws-cdk/aws-s3";
import * as iam from "@aws-cdk/aws-iam";
import { CfnOutput, RemovalPolicy } from "@aws-cdk/core";
import { S3EventSource } from "@aws-cdk/aws-lambda-event-sources";
import * as lambda from "@aws-cdk/aws-lambda";
import * as path from "path";
import { HttpApi, HttpMethod } from "@aws-cdk/aws-apigatewayv2";
import { LambdaProxyIntegration } from "@aws-cdk/aws-apigatewayv2-integrations";
import { ManagedPolicy } from "@aws-cdk/aws-iam";

export class GlobalRekognitionCustomLabelsRegionalStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    const trainingBucket = new s3.Bucket(this, "TrainingDataBucket", {
      bucketName: "global-custom-labels-" + this.account + "-" + this.region,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const outputBucket = new s3.Bucket(this, "outputBucket", {
      bucketName:
        "global-custom-labels-" + this.account + "-" + this.region + "-output",
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    outputBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetBucketAcl"],
        resources: [outputBucket.bucketArn],
        principals: [new iam.ServicePrincipal("rekognition.amazonaws.com")],
      })
    );
    outputBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [outputBucket.arnForObjects("*")],
        principals: [new iam.ServicePrincipal("rekognition.amazonaws.com")],
        conditions: {
          StringEquals: {
            "s3:x-amz-acl": "bucket-owner-full-control",
          },
        },
      })
    );

    trainingBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetBucketAcl", "s3:GetBucketLocation"],
        resources: [trainingBucket.bucketArn],
        principals: [new iam.ServicePrincipal("rekognition.amazonaws.com")],
      })
    );
    trainingBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:GetObject",
          "s3:GetObjectAcl",
          "s3:GetObjectVersion",
          "s3:GetObjectTagging",
        ],
        resources: [trainingBucket.arnForObjects("*")],
        principals: [new iam.ServicePrincipal("rekognition.amazonaws.com")],
      })
    );

    const processManifestFunctionLayer = new lambda.LayerVersion(
      this,
      "ProcessManifestFunctionLayer",
      {
        code: lambda.Code.fromAsset(
          path.join(__dirname, "lambda", "process-manifest-layer")
        ),
        compatibleRuntimes: [lambda.Runtime.NODEJS_14_X],
        license: "Apache-2.0",
        description: "A layer to test the L2 construct",
      }
    );
    const processManifestFunction = new lambda.Function(
      this,
      "ProcessManifestFunction",
      {
        runtime: lambda.Runtime.NODEJS_14_X,
        handler: "index.lambdaHandler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "lambda", "process-manifest"),
          { exclude: ["node_modules"] }
        ),
        layers: [processManifestFunctionLayer],
      }
    );

    processManifestFunction.addEventSource(
      new S3EventSource(trainingBucket, {
        events: [s3.EventType.OBJECT_CREATED_PUT],
        filters: [{ suffix: ".manifest" }],
      })
    );
    trainingBucket.grantReadWrite(processManifestFunction);

    const buildModelFunctionLayer = new lambda.LayerVersion(
      this,
      "BuildModelFunctionLayer",
      {
        code: lambda.Code.fromAsset(
          path.join(__dirname, "lambda", "build-model-layer")
        ),
        compatibleRuntimes: [lambda.Runtime.NODEJS_14_X],
        license: "Apache-2.0",
        description: "A layer to test the L2 construct",
      }
    );
    const buildModelFunction = new lambda.Function(this, "BuildModelFunction", {
      runtime: lambda.Runtime.NODEJS_14_X,
      handler: "index.lambdaHandler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "lambda", "build-model"),
        { exclude: ["node_modules"] }
      ),
      layers: [buildModelFunctionLayer],
      environment: {
        trainingBucket: trainingBucket.bucketName,
        outputBucket: outputBucket.bucketName,
      },
    });

    buildModelFunction.role!.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonRekognitionCustomLabelsFullAccess"
      )
    );
    buildModelFunction.role!.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonS3ReadOnlyAccess")
    );

    const buildModelDefaultIntegration = new LambdaProxyIntegration({
      handler: buildModelFunction,
    });
    const httpApi = new HttpApi(this, "HttpApi");
    httpApi.addRoutes({
      path: "/build",
      methods: [HttpMethod.GET],
      integration: buildModelDefaultIntegration,
    });

    new CfnOutput(this, "TrainingDataBucketName", {
      value: trainingBucket.bucketName,
      description: "Training Data Bucket",
    });
    
    new CfnOutput(this, "OutputDataBucketName", {
      value: outputBucket.bucketName,
      description: "Output Data Bucket",
    });
    new CfnOutput(this, "Region", {
      value: this.region!,
      description: "Region",
    });
    new CfnOutput(this, "RunModelHttpApiUrl", {
      value: httpApi.url!,
      description: "Run Model Http Api Url",
    });
  }
}