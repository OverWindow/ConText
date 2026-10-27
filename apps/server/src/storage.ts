import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import type { BlobReference } from '@context/contracts';
import type { ServerConfig } from './config.ts';
import { ApiError } from './errors.ts';

export interface StoredBlob extends BlobReference { storage_key: string; verified_at?: string | null; }
export class BlobStorage {
  readonly client: S3Client;
  constructor(readonly config: ServerConfig) {
    this.client = new S3Client({region:config.region,endpoint:config.s3Endpoint,forcePathStyle:!!config.s3Endpoint,
      ...(config.testMode ? {credentials:{accessKeyId:'test',secretAccessKey:'test'}} : {}),
      maxAttempts:3, requestChecksumCalculation:'WHEN_REQUIRED', responseChecksumValidation:'WHEN_REQUIRED',
    });
  }
  private ready() { if (!this.config.bucket) throw new ApiError(503,'STORAGE_UNAVAILABLE','Private document storage is not configured'); }
  private checksum(blob: BlobReference) { return Buffer.from(blob.sha256,'hex').toString('base64'); }
  async prepare(blob: StoredBlob) {
    this.ready();
    const checksum = this.checksum(blob);
    const headers: Record<string,string> = {'Content-Type':blob.mime_type,'If-None-Match':'*',
      'x-amz-checksum-sha256':checksum,'x-amz-sdk-checksum-algorithm':'SHA256','x-amz-server-side-encryption':'AES256','x-amz-meta-blob-id':blob.id};
    const command = new PutObjectCommand({Bucket:this.config.bucket,Key:blob.storage_key,ContentLength:blob.size,ContentType:blob.mime_type,
      IfNoneMatch:'*',ChecksumSHA256:checksum,ChecksumAlgorithm:'SHA256',ServerSideEncryption:'AES256',Metadata:{'blob-id':blob.id}});
    const upload_url = await getSignedUrl(this.client,command,{expiresIn:this.config.urlTtl,unhoistableHeaders:new Set(Object.keys(headers).map(k=>k.toLowerCase()))});
    return {upload_url,headers};
  }
  async verify(blob: StoredBlob) {
    this.ready();
    let head;
    try { head = await this.client.send(new HeadObjectCommand({Bucket:this.config.bucket,Key:blob.storage_key,ChecksumMode:'ENABLED'})); }
    catch (error) {
      if ((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode === 404) throw new ApiError(409,'UPLOAD_MISSING','Upload the original file before completing it');
      throw new ApiError(503,'STORAGE_UNAVAILABLE','Unable to verify the private file');
    }
    if (head.ContentLength !== blob.size || head.ContentType !== blob.mime_type || head.ChecksumSHA256 !== this.checksum(blob) || head.Metadata?.['blob-id'] !== blob.id || head.ServerSideEncryption !== 'AES256') throw new ApiError(422,'BLOB_MISMATCH','Stored file checksum, size or metadata does not match');
  }
  async download(blob: StoredBlob, filename='document') {
    this.ready();
    return getSignedUrl(this.client,new GetObjectCommand({Bucket:this.config.bucket,Key:blob.storage_key,ResponseContentType:'application/octet-stream',
      ResponseContentDisposition:`attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(filename)}`}),{expiresIn:this.config.urlTtl});
  }
  async bytes(blob: StoredBlob): Promise<Buffer> {
    this.ready(); const response = await this.client.send(new GetObjectCommand({Bucket:this.config.bucket,Key:blob.storage_key,ChecksumMode:'ENABLED'}));
    const bytes = Buffer.from(await response.Body!.transformToByteArray());
    if (bytes.length !== blob.size || createHash('sha256').update(bytes).digest('hex') !== blob.sha256) throw new ApiError(422,'BLOB_MISMATCH','Private file is corrupt');
    return bytes;
  }
  async put(blob: StoredBlob, bytes: Buffer) {
    this.ready();
    if (bytes.length !== blob.size || createHash('sha256').update(bytes).digest('hex') !== blob.sha256) throw new Error('Invalid derived artifact bytes');
    try { await this.client.send(new PutObjectCommand({Bucket:this.config.bucket,Key:blob.storage_key,Body:bytes,ContentLength:bytes.length,ContentType:blob.mime_type,
      IfNoneMatch:'*',ChecksumSHA256:this.checksum(blob),ChecksumAlgorithm:'SHA256',ServerSideEncryption:'AES256',Metadata:{'blob-id':blob.id}})); }
    catch(error) { if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==412)throw error; }
    await this.verify(blob);
  }
}
