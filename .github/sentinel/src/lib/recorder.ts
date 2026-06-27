/**
 * Session recording for `/qa`: Playwright records the viewport to a .webm while
 * the agent explores (no page-side JS, so it never slows the run), then we publish
 * the video to the (private) Vercel Blob store and link a signed, viewable URL in
 * the report. Best-effort throughout — recording must never fail the QA run.
 */
import { issueSignedToken, presignUrl, put } from "@vercel/blob";

/** How long the signed replay link stays viewable. */
const LINK_TTL_DAYS = 7;

/**
 * Publish the session video to Vercel Blob and return a directly-viewable URL.
 * The store is PRIVATE, so: upload with `access:'private'` (authenticated by
 * BLOB_READ_WRITE_TOKEN), then mint a presigned GET URL (the raw blob URL is 403).
 * Returns the signed URL, or null when creds are absent / anything fails (logged,
 * never fatal).
 */
export async function uploadVideo(video: Buffer, pathname: string): Promise<string | null> {
  // `put()` authenticates purely via BLOB_READ_WRITE_TOKEN (the store is encoded
  // in the token); the SDK never reads BLOB_STORE_ID. Gate on the token alone so a
  // half-configured run (store id set, token missing) skips cleanly instead of
  // proceeding into a guaranteed `put` failure.
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const blob = await put(pathname, video, {
      access: "private",
      addRandomSuffix: true,
      contentType: "video/webm",
    });
    const key = new URL(blob.url).pathname.replace(/^\//, "");
    const validUntil = Date.now() + LINK_TTL_DAYS * 24 * 3600 * 1000;
    const token = await issueSignedToken({ pathname: key, operations: ["get"], validUntil });
    const { presignedUrl } = await presignUrl(
      { clientSigningToken: token.clientSigningToken, delegationToken: token.delegationToken },
      { operation: "get", pathname: key, access: "private", validUntil },
    );
    console.log(`Video published (${(video.length / 1_048_576).toFixed(1)}MB): ${presignedUrl.slice(0, 80)}…`);
    return presignedUrl;
  } catch (err) {
    console.error(`Video upload failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
