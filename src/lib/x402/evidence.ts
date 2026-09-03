/**
 * Payment-evidence pin for the x402 accept-selection seam.
 *
 * Callers that already know which resource they intend to pay (from a seller
 * `/.well-known/x402` document, an OpenAPI `x-payment-info` block, or a buyer
 * catalog that copies those fields) can refuse an accept that names a different
 * payee, network, asset, amount, or origin. Opt-in: with no pin, selection is
 * unchanged.
 */

import { ClientError } from '../errors.js';
import { selectAcceptEntry, type PaymentRequiredAccept, type SchemePreference } from './signer.js';

/** USDC atomic scale used by x402 exact-scheme amounts in this client. */
const USDC_DECIMALS = 6;

export type PaymentEvidenceMismatch =
  | 'scheme'
  | 'network'
  | 'payTo'
  | 'asset'
  | 'amount'
  | 'extraName'
  | 'extraVersion'
  | 'origin'
  | 'route';

/**
 * Stable identity of a paid resource. Undefined fields are not checked.
 */
export interface PaymentEvidencePin {
  scheme?: string;
  network?: string;
  payTo?: string;
  asset?: string;
  amount?: string;
  extraName?: string;
  extraVersion?: string;
  origin?: string;
  route?: string;
  /** Decimal USD price (e.g. OpenAPI `x-payment-info.price.amount`). */
  priceUsd?: number;
}

export interface PaymentResourceRef {
  url?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function evmAddr(value: string | undefined): string | undefined {
  return value ? value.toLowerCase() : undefined;
}

function normalizeRoute(path: string): string {
  if (!path) return '/';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

function originAndRouteFromUrl(url: string): { origin?: string; route?: string } {
  try {
    const parsed = new URL(url);
    return { origin: parsed.origin, route: normalizeRoute(parsed.pathname) };
  } catch {
    return {};
  }
}

function originKey(origin: string): string {
  try {
    const parsed = new URL(origin);
    return `${parsed.protocol}//${parsed.hostname}`.toLowerCase();
  } catch {
    return origin.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * Compare an advertised accept (and optional resource URL) to a pin.
 * Returns the first mismatched field, or undefined if the accept is allowed.
 */
export function mismatchAgainstPin(
  accept: PaymentRequiredAccept,
  pin: PaymentEvidencePin,
  resource?: PaymentResourceRef
): PaymentEvidenceMismatch | undefined {
  if (pin.scheme !== undefined && accept.scheme !== pin.scheme) return 'scheme';
  if (pin.network !== undefined && accept.network !== pin.network) return 'network';
  if (pin.payTo !== undefined && evmAddr(accept.payTo) !== evmAddr(pin.payTo)) return 'payTo';
  if (pin.asset !== undefined && evmAddr(accept.asset) !== evmAddr(pin.asset)) return 'asset';
  if (pin.amount !== undefined && String(accept.amount) !== String(pin.amount)) return 'amount';
  if (pin.priceUsd !== undefined && pin.amount === undefined) {
    const atomic = Number(accept.amount);
    if (!Number.isFinite(atomic) || Math.round(pin.priceUsd * 10 ** USDC_DECIMALS) !== atomic) {
      return 'amount';
    }
  }
  if (pin.extraName !== undefined && accept.extra?.name !== pin.extraName) return 'extraName';
  if (pin.extraVersion !== undefined && accept.extra?.version !== pin.extraVersion) {
    return 'extraVersion';
  }

  const url = resource?.url;
  if ((pin.origin !== undefined || pin.route !== undefined) && url) {
    const observed = originAndRouteFromUrl(url);
    if (
      pin.origin !== undefined &&
      observed.origin &&
      originKey(observed.origin) !== originKey(pin.origin)
    ) {
      return 'origin';
    }
    if (
      pin.route !== undefined &&
      observed.route &&
      normalizeRoute(observed.route) !== normalizeRoute(pin.route)
    ) {
      return 'route';
    }
  }

  return undefined;
}

export function acceptMatchesPin(
  accept: PaymentRequiredAccept,
  pin: PaymentEvidencePin,
  resource?: PaymentResourceRef
): boolean {
  return mismatchAgainstPin(accept, pin, resource) === undefined;
}

/**
 * Scheme-preference selection, restricted to accepts that match `pin` when one is set.
 */
export function selectAcceptMatchingPin(
  accepts: PaymentRequiredAccept[],
  pin: PaymentEvidencePin | undefined,
  preference: SchemePreference = 'auto',
  resource?: PaymentResourceRef
): PaymentRequiredAccept | undefined {
  const candidates = pin
    ? accepts.filter((entry) => acceptMatchesPin(entry, pin, resource))
    : accepts;
  return selectAcceptEntry(candidates, preference);
}

/**
 * Pin from the buyer-runtime catalog document (`route` + `contract`).
 */
export function pinFromBuyerRuntimeCatalog(doc: unknown): PaymentEvidencePin {
  const root = asRecord(doc);
  const route = asRecord(root?.route);
  const contract = asRecord(root?.contract);
  if (!route || !contract) {
    throw new ClientError('Payment evidence catalog is missing route or contract.');
  }

  const extra = asRecord(contract.extra);
  const scheme = asString(contract.scheme);
  const network = asString(contract.network);
  const payTo = asString(contract.payTo);
  const asset = asString(contract.asset);
  const amount = asString(contract.amount);
  const extraName = asString(extra?.name);
  const extraVersion = asString(extra?.version);
  const origin = asString(route.origin);
  const path = asString(route.path);
  const pin: PaymentEvidencePin = {
    ...(scheme ? { scheme } : {}),
    ...(network ? { network } : {}),
    ...(payTo ? { payTo } : {}),
    ...(asset ? { asset } : {}),
    ...(amount ? { amount } : {}),
    ...(extraName ? { extraName } : {}),
    ...(extraVersion ? { extraVersion } : {}),
    ...(origin ? { origin } : {}),
    ...(path ? { route: normalizeRoute(path) } : {}),
  };

  const priceUsd = contract.priceUsd;
  if (typeof priceUsd === 'number' && Number.isFinite(priceUsd)) {
    pin.priceUsd = priceUsd;
  }

  if (!pin.scheme || !pin.network || !pin.payTo || !pin.asset || !pin.amount) {
    throw new ClientError('Payment evidence catalog contract is missing identity fields.');
  }
  return pin;
}

/**
 * Pin from one `/.well-known/x402` item (`resource` + `accepts[0]`).
 */
export function pinFromWellKnownItem(item: unknown): PaymentEvidencePin {
  const root = asRecord(item);
  const resource = asRecord(root?.resource);
  const accepts = root?.accepts;
  const accept = Array.isArray(accepts) ? asRecord(accepts[0]) : undefined;
  if (!accept) {
    throw new ClientError('well-known x402 item has no accepts.');
  }

  const extra = asRecord(accept.extra);
  const scheme = asString(accept.scheme);
  const network = asString(accept.network);
  const payTo = asString(accept.payTo);
  const asset = asString(accept.asset);
  const amount = asString(accept.amount);
  const extraName = asString(extra?.name);
  const extraVersion = asString(extra?.version);
  const routeTemplate = asString(resource?.routeTemplate);
  const resourceUrl = asString(resource?.url) || asString(asRecord(root?.request)?.url);
  const fromUrl = resourceUrl ? originAndRouteFromUrl(resourceUrl) : {};
  const route = routeTemplate
    ? normalizeRoute(routeTemplate)
    : fromUrl.route
      ? fromUrl.route
      : undefined;

  const pin: PaymentEvidencePin = {
    ...(scheme ? { scheme } : {}),
    ...(network ? { network } : {}),
    ...(payTo ? { payTo } : {}),
    ...(asset ? { asset } : {}),
    ...(amount ? { amount } : {}),
    ...(extraName ? { extraName } : {}),
    ...(extraVersion ? { extraVersion } : {}),
    ...(fromUrl.origin ? { origin: fromUrl.origin } : {}),
    ...(route ? { route } : {}),
  };

  if (!pin.scheme || !pin.network || !pin.payTo || !pin.asset || !pin.amount) {
    throw new ClientError('well-known x402 accept is missing identity fields.');
  }
  return pin;
}

export function findWellKnownItem(doc: unknown, route: string): unknown {
  const root = asRecord(doc);
  const items = root?.items;
  if (!Array.isArray(items)) return undefined;
  const wanted = normalizeRoute(route);
  return items.find((item) => {
    const resource = asRecord(asRecord(item)?.resource);
    const template = asString(resource?.routeTemplate);
    if (template && normalizeRoute(template) === wanted) return true;
    const url = asString(resource?.url);
    return url ? originAndRouteFromUrl(url).route === wanted : false;
  });
}

/**
 * Pin from an OpenAPI operation's `x-payment-info` (scheme/network/asset + USD price).
 * OpenAPI does not carry `payTo`; that field stays unset.
 */
export function pinFromOpenApiOperation(operation: unknown): PaymentEvidencePin {
  const op = asRecord(operation);
  const payment = asRecord(op?.['x-payment-info']);
  if (!payment) {
    throw new ClientError('OpenAPI operation is missing x-payment-info.');
  }

  const price = asRecord(payment.price);
  const protocols = Array.isArray(payment.protocols) ? payment.protocols : [];
  let x402: Record<string, unknown> | undefined;
  for (const entry of protocols) {
    const rec = asRecord(entry);
    const proto = asRecord(rec?.x402);
    if (proto) {
      x402 = proto;
      break;
    }
  }
  if (!x402) {
    throw new ClientError('OpenAPI x-payment-info has no x402 protocol.');
  }

  const priceAmount = asString(price?.amount);
  const scheme = asString(x402.scheme);
  const network = asString(x402.network);
  const asset = asString(x402.asset);
  const pin: PaymentEvidencePin = {
    ...(scheme ? { scheme } : {}),
    ...(network ? { network } : {}),
    ...(asset ? { asset } : {}),
  };
  if (priceAmount !== undefined) {
    const usd = Number(priceAmount);
    if (!Number.isFinite(usd)) {
      throw new ClientError('OpenAPI x-payment-info price is not a number.');
    }
    pin.priceUsd = usd;
  }
  if (!pin.scheme || !pin.network || !pin.asset) {
    throw new ClientError('OpenAPI x-payment-info x402 is missing identity fields.');
  }
  return pin;
}

export function findOpenApiOperation(doc: unknown, path: string, method = 'get'): unknown {
  const root = asRecord(doc);
  const paths = asRecord(root?.paths);
  const pathItem = asRecord(paths?.[path]);
  return pathItem?.[method.toLowerCase()];
}
