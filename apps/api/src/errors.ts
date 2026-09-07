export class ApiFailure extends Error {
  constructor(
    public code: string,
    public status: 400 | 401 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
export const denied = () =>
  new ApiFailure(
    "access-denied",
    403,
    "This account does not have household access.",
  );
