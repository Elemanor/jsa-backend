const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

// Configure AWS S3 - ensure credentials are trimmed
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ? process.env.AWS_ACCESS_KEY_ID.trim() : undefined,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ? process.env.AWS_SECRET_ACCESS_KEY.trim() : undefined,
  region: process.env.AWS_REGION ? process.env.AWS_REGION.trim() : 'us-east-2',
  signatureVersion: 'v4'
});

// Generate a presigned URL for direct upload from browser
async function generatePresignedUrl(fileName, fileType, folder = 'work-areas') {
  const fileExtension = fileName.split('.').pop();
  const key = `${folder}/${uuidv4()}.${fileExtension}`;

  // Clean up environment variables (remove any newlines)
  const bucketName = (process.env.S3_BUCKET_NAME || 'mjr-jsa-photos').trim();
  const region = (process.env.AWS_REGION || 'us-east-2').trim();

  const params = {
    Bucket: bucketName,
    Key: key.trim(),
    ContentType: fileType,
    // Note: ACL removed from presigned URL to avoid CORS issues
    // The bucket policy handles public read access
    Expires: 300 // URL expires in 5 minutes
  };

  try {
    const uploadUrl = await s3.getSignedUrlPromise('putObject', params);
    const fileUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;

    return {
      uploadUrl: uploadUrl.trim(),
      fileUrl: fileUrl.trim(),
      key: key.trim()
    };
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    throw error;
  }
}

// Upload a file directly to S3 from server
async function uploadToS3(fileBuffer, fileName, fileType, folder = 'work-areas') {
  const fileExtension = fileName.split('.').pop();
  const key = `${folder}/${uuidv4()}.${fileExtension}`;

  const params = {
    Bucket: process.env.S3_BUCKET_NAME || 'mjr-jsa-photos',
    Key: key,
    Body: fileBuffer,
    ContentType: fileType,
    ACL: 'public-read'
  };

  try {
    const result = await s3.upload(params).promise();
    return {
      fileUrl: result.Location,
      key: result.Key
    };
  } catch (error) {
    console.error('Error uploading to S3:', error);
    throw error;
  }
}

// Delete a file from S3
async function deleteFromS3(key) {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME || 'mjr-jsa-photos',
    Key: key
  };

  try {
    await s3.deleteObject(params).promise();
    return { success: true };
  } catch (error) {
    console.error('Error deleting from S3:', error);
    throw error;
  }
}

module.exports = {
  generatePresignedUrl,
  uploadToS3,
  deleteFromS3
};