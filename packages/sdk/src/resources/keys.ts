import type { Core, RequestOptions, WithRequestId } from "../core.js";
import type { CreateKeyRequest, Key, KeyList, KeyWithSecret } from "../types.js";

export class Keys {
  constructor(private readonly core: Core) {}

  list(options?: RequestOptions): Promise<WithRequestId<KeyList>> {
    return this.core.request({ method: "GET", path: "/v1/keys", options });
  }
  get(keyId: string, options?: RequestOptions): Promise<WithRequestId<Key>> {
    return this.core.request({ method: "GET", path: `/v1/keys/${encodeURIComponent(keyId)}`, options });
  }
  /** Console sessions only: an API-key caller gets `403`. Idempotent: revoking a revoked key returns it again. */
  revoke(keyId: string, options?: RequestOptions): Promise<WithRequestId<Key>> {
    return this.core.request({ method: "DELETE", path: `/v1/keys/${encodeURIComponent(keyId)}`, options });
  }
  /** Console sessions only: an API-key caller gets `403`. Returns the new secret, once. */
  rotate(keyId: string, options?: RequestOptions): Promise<WithRequestId<KeyWithSecret>> {
    return this.core.request({ method: "POST", path: `/v1/keys/${encodeURIComponent(keyId)}/rotate`, options });
  }
  /** Console sessions only: an API-key caller gets `403`. */
  create(body: CreateKeyRequest, options?: RequestOptions): Promise<WithRequestId<KeyWithSecret>> {
    return this.core.request({ method: "POST", path: "/v1/keys", body, options });
  }
}
