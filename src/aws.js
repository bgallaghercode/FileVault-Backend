// src/aws.js
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const S3_BUCKET = process.env.S3_BUCKET;
const AWS_REGION = process.env.AWS_REGION;

if (!S3_BUCKET || !AWS_REGION) {
  throw new Error('S3_BUCKET and AWS_REGION must be set in env');
}

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

module.exports = {
  s3,
  S3_BUCKET,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  getSignedUrl,
};
