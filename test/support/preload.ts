import "reflect-metadata";

// LocalStack accepts any credentials; the SDK just needs some to sign requests.
process.env["AWS_ACCESS_KEY_ID"] ??= "test";
process.env["AWS_SECRET_ACCESS_KEY"] ??= "test";
process.env["AWS_REGION"] ??= "us-east-1";
