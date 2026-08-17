/**
 * Privacy stub - inbound claude.ai web-composer attachment resolution was
 * removed with the rest of the bridge/remote session code.
 *
 * print.ts uses resolveAndPrepend() to expand file attachments attached via
 * the web composer into content blocks. With attachments stripped, the
 * correct pass-through behavior is to return the original content unchanged.
 * (Returning null here breaks every SDK/-p prompt - see print.ts enqueue.)
 */
export async function getAttachmentContent(): Promise<null> { return null }
export async function resolveAndPrepend(
  _message: unknown,
  content: unknown,
): Promise<unknown> { return content }
