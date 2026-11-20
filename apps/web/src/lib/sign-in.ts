import { type DerivedKeys } from "@messages/crypto";
import { ApiError, registerDevice, type FetchLike } from "./api.js";
import type { DeviceKeys, ServerSession } from "../session.js";

export type SignInErrorKind = "network" | "other";
export type SignInError = Error & { kind: SignInErrorKind };

export type RegisterDeviceWithRetryOptions = {
  fetcher?: FetchLike;
  register?: (
    derived: DerivedKeys,
    fetcher?: FetchLike,
  ) => Promise<{ session: ServerSession; deviceKeys: DeviceKeys }>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

export async function registerDeviceWithRetry(
  derived: DerivedKeys,
  options: RegisterDeviceWithRetryOptions = {},
): Promise<{ session: ServerSession; deviceKeys: DeviceKeys }> {
  const register = options.register ?? registerDevice;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const start = now();
  let retried401 = false;

  while (true) {
    try {
      return await register(derived, options.fetcher);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && !retried401) {
        retried401 = true;
        continue;
      }
      if (error instanceof ApiError && error.status === 429) {
        throw Object.assign(new Error(error.code), { kind: "other" as const });
      }
      const retryable =
        error instanceof TypeError ||
        (error instanceof ApiError &&
          (error.status === 0 || error.status >= 500));
      if (!retryable) {
        throw Object.assign(
          error instanceof Error ? error : new Error("Sign-in failed"),
          { kind: "other" as const },
        );
      }
      if (now() - start >= 60_000) {
        throw Object.assign(
          error instanceof Error ? error : new Error("Network unavailable"),
          { kind: "network" as const },
        );
      }
      await sleep(5_000);
      if (now() - start >= 60_000) {
        throw Object.assign(
          error instanceof Error ? error : new Error("Network unavailable"),
          { kind: "network" as const },
        );
      }
    }
  }
}
