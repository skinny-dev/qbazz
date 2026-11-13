import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors.js';
import crypto from 'node:crypto';
import { newId } from '../util/ids.js';

/**
 * Online payment, in front of a payment provider.
 *
 * A buyer pays an order in three steps: `startPayment` makes an attempt and returns the page to send them to;
 * the provider sends them back to our callback; `complete` asks the provider whether the money really moved and,
 * only then, marks the order paid. Nothing the browser says about the outcome is believed.
 *
 * Providers:
 *   - `sandbox`  a pretend gateway (a page with "pay" and "cancel") for development and demos. Refuses to run in production.
 *   - `zarinpal` ZarinPal's v4 API. Needs QBAZZ_ZARINPAL_MERCHANT; QBAZZ_ZARINPAL_SANDBOX=1 uses their test environment.
 */
export function createGatewayService(ctx) {
  const { store: db, config, events, services, log } = ctx;
  const orders = db.collection(COLLECTIONS.orders);
  const cfg = config.payments.gateway;

  const webBase = () => cfg.returnUrl || config.platform.webBaseUrl;
  const apiBase = () => config.platform.apiBaseUrl;
  const rial = (order) => (String(order.totals.currency).toUpperCase() === 'IRR' ? order.totals.total : order.totals.total * 10);

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return res.json().catch(() => ({}));
  }

  const providers = {
    sandbox: {
      async start({ attempt }) {
        return { authority: attempt.id, url: `${webBase()}/pay/sandbox/${attempt.id}` };
      },
      async verify({ attempt, query }) {
        return query.outcome === 'ok' ? { ok: true, refId: `SBX-${attempt.id.slice(-8).toUpperCase()}` } : { ok: false };
      },
    },

    zarinpal: {
      host: () => (cfg.sandbox ? 'https://sandbox.zarinpal.com' : 'https://payment.zarinpal.com'),
      async start({ order, attempt }) {
        const res = await post(`${this.host()}/pg/v4/payment/request.json`, {
          merchant_id: cfg.merchantId,
          amount: rial(order),
          description: `Qbazz ${order.code}`,
          callback_url: `${apiBase()}/pay/callback/${attempt.id}`,
        });
        const authority = res?.data?.authority;
        if (res?.data?.code !== 100 || !authority) {
          log.warn?.(`zarinpal request failed: ${JSON.stringify(res?.errors || res)}`);
          throw new ConflictError('err.pay_gateway');
        }
        return { authority, url: `${this.host()}/pg/StartPay/${authority}` };
      },
      async verify({ order, attempt, query }) {
        if (query.Status !== 'OK') return { ok: false };
        const res = await post(`${this.host()}/pg/v4/payment/verify.json`, { merchant_id: cfg.merchantId, amount: rial(order), authority: attempt.authority });
        // 100: verified now. 101: it was verified before - the callback was simply repeated.
        return [100, 101].includes(res?.data?.code) ? { ok: true, refId: String(res.data.ref_id || '') } : { ok: false };
      },
    },
  };

  function provider() {
    const name = cfg.provider;
    if (name === 'sandbox' && config.env === 'production') throw new ConflictError('err.pay_gateway');
    if (name === 'zarinpal' && !cfg.merchantId) throw new ConflictError('err.pay_gateway');
    const found = providers[name];
    if (!found) throw new ConflictError('err.pay_gateway');
    return found;
  }

  /** Can a buyer pay online right now? False when no real gateway is set up (or only the pretend one on a live server). */
  function available() {
    try { provider(); return true; } catch { return false; }
  }

  async function attemptOf(attemptId) {
    const order = await orders.findOne((row) => (row.paymentAttempts || []).some((a) => a.id === attemptId));
    if (!order) throw new NotFoundError('Payment', attemptId);
    return { order, attempt: order.paymentAttempts.find((a) => a.id === attemptId) };
  }

  /**
   * A link that starts the payment for one order, signed so it cannot be forged or reused for another order.
   * It lets someone who is not signed in on the web (a Telegram buyer) pay; it dies with the payment window.
   */
  const signature = (order) => crypto.createHmac('sha256', config.auth.secret).update(`pay:${order.id}:${order.payBy || ''}`).digest('hex').slice(0, 32);
  function payLink(order) {
    if (order.paymentMethod !== 'online' || order.paymentStatus === 'paid' || order.status !== 'pending') return null;
    return `${apiBase()}/pay/go/${order.id}?sig=${signature(order)}`;
  }
  async function startFromLink(orderId, sig) {
    const order = await services.orders.getOrFail(orderId);
    const expected = signature(order);
    const given = Buffer.from(String(sig || ''));
    const want = Buffer.from(expected);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new NotFoundError('Order', orderId);
    return startPayment(order.id, order.accountId);
  }

  /** The buyer pays. Returns where to send them. */
  async function startPayment(orderId, accountId) {
    const order = await services.orders.getOrFail(orderId);
    if (order.accountId !== accountId) throw new ForbiddenError('err.not_your_order');
    if (order.paymentMethod !== 'online' || order.status !== 'pending' || !['unpaid', 'failed'].includes(order.paymentStatus)) throw new ConflictError('err.pay_not_available');
    if (order.payBy && new Date(order.payBy) < new Date()) {
      await services.orders.updateStatus(order.id, 'cancelled', { note: 'payment_expired' }).catch(() => null);
      throw new ConflictError('err.pay_expired');
    }

    const gateway = provider();
    const attempt = { id: newId('pay'), provider: cfg.provider, authority: null, amount: order.totals.total, currency: order.totals.currency, status: 'pending', createdAt: new Date().toISOString(), paidAt: null, refId: null };
    const started = await gateway.start({ order, attempt });
    attempt.authority = started.authority;
    await orders.mutate(order.id, (draft) => {
      draft.paymentAttempts = [...(draft.paymentAttempts || []), attempt];
      return draft;
    });
    return { url: started.url, attemptId: attempt.id, expiresAt: order.payBy || null };
  }

  /** The provider sent the buyer back. Ask it what happened, and only then believe it. */
  async function complete(attemptId, query = {}) {
    const { order, attempt } = await attemptOf(attemptId);
    if (attempt.status === 'paid' || order.paymentStatus === 'paid') return { orderId: order.id, paid: true };
    if (attempt.status !== 'pending') return { orderId: order.id, paid: false };

    let verdict = { ok: false };
    try {
      verdict = await providers[attempt.provider].verify({ order, attempt, query });
    } catch (err) {
      log.warn?.(`payment verify failed for ${attemptId}: ${err.message}`);
    }
    if (verdict.ok) {
      await services.orders.markPaid(order.id, { provider: attempt.provider, refId: verdict.refId, attemptId });
      return { orderId: order.id, paid: true };
    }
    await orders.mutate(order.id, (draft) => {
      draft.paymentAttempts = (draft.paymentAttempts || []).map((a) => (a.id === attemptId ? { ...a, status: 'failed' } : a));
      if (draft.paymentStatus === 'unpaid') draft.paymentStatus = 'failed';
      return draft;
    });
    return { orderId: order.id, paid: false };
  }

  /** What the pretend gateway page shows. */
  async function sandboxInfo(attemptId) {
    if (cfg.provider !== 'sandbox' || config.env === 'production') throw new NotFoundError('Payment', attemptId);
    const { order, attempt } = await attemptOf(attemptId);
    return { attemptId, status: attempt.status, order: { id: order.id, code: order.code, storeName: order.storeName, total: order.totals.total, currency: order.totals.currency } };
  }

  async function sandboxDecide(attemptId, outcome) {
    await sandboxInfo(attemptId);
    const result = await complete(attemptId, { outcome: outcome === 'ok' ? 'ok' : 'cancel' });
    return { ...result, redirect: returnUrl(result) };
  }

  const returnUrl = ({ orderId, paid }) => `${webBase()}/orders/${orderId}?pay=${paid ? 'ok' : 'failed'}`;

  /** Orders nobody paid for in time are released: the stock goes back on the shelf. */
  async function sweepExpired() {
    const now = new Date().toISOString();
    const stale = await orders.find({ where: (o) => o.paymentMethod === 'online' && o.status === 'pending' && ['unpaid', 'failed'].includes(o.paymentStatus) && o.payBy && o.payBy < now });
    let n = 0;
    for (const order of stale) {
      try { await services.orders.updateStatus(order.id, 'cancelled', { note: 'payment_expired' }); n += 1; } catch (err) { log.warn?.(`sweep ${order.code}: ${err.message}`); }
    }
    return n;
  }

  return { payLink, startFromLink, startPayment, complete, sandboxInfo, sandboxDecide, returnUrl, sweepExpired, available, provider: () => cfg.provider };
}
