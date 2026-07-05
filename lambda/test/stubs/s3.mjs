// Stub for @aws-sdk/client-s3. The commands just capture their input so the
// s3-request-presigner stub (and tests) can inspect Bucket/Key/ContentType.
export class S3Client {
  constructor(config) { this.config = config; }
}
export class PutObjectCommand {
  constructor(input) { this.input = input; }
}
export class GetObjectCommand {
  constructor(input) { this.input = input; }
}
