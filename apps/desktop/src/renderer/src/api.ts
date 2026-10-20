import type { AtlasApi, FieldIssueLike, IpcResult } from './types';

declare global {
  interface Window {
    atlas: AtlasApi;
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly issues: FieldIssueLike[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Unwraps an IPC result, turning failures into ApiError with a user-safe message. */
export async function unwrap<T>(request: Promise<IpcResult<T>>): Promise<T> {
  let result: IpcResult<T>;
  try {
    result = await request;
  } catch {
    throw new ApiError('ATLAS could not complete the request.', 'INTERNAL_ERROR', []);
  }
  if (!result.ok) {
    throw new ApiError(result.error.message, result.error.code, result.error.issues);
  }
  return result.data;
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'An unexpected error occurred.';
}

export const api = (): AtlasApi => window.atlas;
