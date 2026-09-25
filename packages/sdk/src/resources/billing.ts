import type { Core, RequestOptions, WithRequestId } from "../core.js";
import type { AutoRechargeRequest, Billing as BillingT, Checkout, CheckoutRequest, Portal } from "../types.js";

export class Billing {
  constructor(private readonly core: Core) {}

  get(options?: RequestOptions): Promise<WithRequestId<BillingT>> {
    return this.core.request({ method: "GET", path: "/v1/billing", options });
  }
  setAutoRecharge(body: AutoRechargeRequest, options?: RequestOptions): Promise<WithRequestId<BillingT>> {
    return this.core.request({ method: "PUT", path: "/v1/billing/auto-recharge", body, options });
  }
  /** Returns a hosted checkout URL. */
  checkout(body: CheckoutRequest, options?: RequestOptions): Promise<WithRequestId<Checkout>> {
    return this.core.request({ method: "POST", path: "/v1/billing/checkout", body, options });
  }
  /** Returns a billing portal URL. */
  portal(options?: RequestOptions): Promise<WithRequestId<Portal>> {
    return this.core.request({ method: "POST", path: "/v1/billing/portal", options });
  }
}
