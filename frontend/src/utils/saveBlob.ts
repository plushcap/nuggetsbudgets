/**
 * How long a download's object URL is kept after the click. Some browsers (older WebKit)
 * start the save well after click() returns, so revoking the URL at once can cancel it
 * (FileSaver.js waits 40 s for the same reason).
 */
export const REVOKE_DOWNLOAD_URL_AFTER_MS = 40_000;

/**
 * Hand a file to the browser to save as `fileName`: a temporary `<a download>` on an
 * object URL, clicked and removed, and the URL revoked once the save has had time to start.
 * The one way the app saves a fetched or built file: the backup, export, utilities,
 * merchant and investment pages each had their own, most revoking the URL at once.
 */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DOWNLOAD_URL_AFTER_MS);
  }
}
