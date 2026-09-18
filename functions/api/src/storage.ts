/**
 * Artifact bytes. The database holds metadata and the verification verdict; the bytes
 * themselves live in S3, keyed by content hash.
 *
 * Two rules the key layout enforces:
 *
 *   - **Keys are content-addressed**, so writing the same artifact twice is idempotent
 *     and a re-compile of an unchanged spec costs one PUT of identical bytes rather
 *     than a second copy under a new name.
 *   - **Keys are namespaced by organization**, even though the hash alone would be
 *     unique. Deleting one tenant's data must never remove bytes another tenant's rows
 *     still point at, and a shared key would make that impossible to do safely.
 *
 * `read` re-derives the key from the stored URI but refuses any URI that does not name
 * this project's bucket under the `artifacts/` prefix. The URI comes from our own table,
 * so this is belt-and-braces — but a row is a thing an attacker with any write path
 * could aim somewhere else, and a storage client that follows arbitrary URIs is how
 * that becomes a read of something it shouldn't.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ApiError } from './errors.js';

const PREFIX = 'artifacts';

let client: S3Client | undefined;

function s3(): S3Client {
  if (!client) client = new S3Client({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
  return client;
}

function bucket(): string {
  const name = process.env['STORAGE_BUCKET'];
  if (!name) throw new Error('STORAGE_BUCKET is not set; artifact storage is unavailable');
  return name;
}

export interface StoredArtifact {
  readonly contentHash: string;
  readonly storageUri: string;
  readonly sizeBytes: number;
}

export async function write(
  orgId: string,
  contentHash: string,
  contentType: string,
  body: string,
): Promise<StoredArtifact> {
  const key = `${PREFIX}/${orgId}/${contentHash}`;
  const bytes = Buffer.from(body, 'utf8');
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: bytes,
      ContentType: contentType,
      // Content-addressed: the bytes under a key can never change, so anything holding
      // them may cache indefinitely.
      CacheControl: 'private, max-age=31536000, immutable',
    }),
  );
  return { contentHash, storageUri: `s3://${bucket()}/${key}`, sizeBytes: bytes.byteLength };
}

export async function read(storageUri: string): Promise<string> {
  const expected = `s3://${bucket()}/${PREFIX}/`;
  if (!storageUri.startsWith(expected)) {
    throw new ApiError(
      'INTERNAL',
      'The stored artifact location is not a valid artifact URI.',
      'Contact support with the artifact identifier.',
    );
  }
  const key = storageUri.slice(`s3://${bucket()}/`.length);
  const response = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const body = response.Body;
  if (!body) {
    throw new ApiError(
      'NOT_FOUND',
      'The artifact metadata exists but its bytes are missing from storage.',
      'Recompile the specification to regenerate the artifact.',
    );
  }
  return body.transformToString('utf8');
}
