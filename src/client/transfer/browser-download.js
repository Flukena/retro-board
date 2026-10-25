const DOWNLOAD_REVOKE_DELAY_MS = 0;

export function downloadArtifact(artifact) {
  const blob = artifact.blob ?? new Blob([artifact.contents], { type: artifact.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = artifact.fileName;
  anchor.click();
  // Safari/Firefox may begin reading the blob after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
}
