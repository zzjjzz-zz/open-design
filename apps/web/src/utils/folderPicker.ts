export function folderPickerErrorDetails(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const message = err.message.trim();
  if (!message) return undefined;
  return message.replace(/^Could not open folder picker:\s*/i, '').trim() || message;
}
