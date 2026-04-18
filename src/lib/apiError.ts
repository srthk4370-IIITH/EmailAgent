export interface ApiErrorShape {
  error: string;
  cause: string;
  fix: string;
}

export function apiError(error: string, cause: string, fix: string): ApiErrorShape {
  return { error, cause, fix };
}
