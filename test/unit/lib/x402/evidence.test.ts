/**
 * Payment-evidence pin: read published catalog / well-known / OpenAPI documents
 * and refuse a foreign or stale accept at the x402 select-accept seam.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  acceptMatchesPin,
  findOpenApiOperation,
  findWellKnownItem,
  mismatchAgainstPin,
  pinFromBuyerRuntimeCatalog,
  pinFromOpenApiOperation,
  pinFromWellKnownItem,
  selectAcceptMatchingPin,
} from '../../../../src/lib/x402/evidence.js';
import {
  createX402FetchMiddleware,
  extractAcceptFromPaymentRequired,
  type X402PaymentCache,
} from '../../../../src/lib/x402/fetch-middleware.js';
import type { PaymentRequiredAccept, SignerWallet } from '../../../../src/lib/x402/signer.js';

const { mockSignPayment } = vi.hoisted(() => ({ mockSignPayment: vi.fn() }));

vi.mock('../../../../src/lib/x402/signer.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/lib/x402/signer.js')>(
    '../../../../src/lib/x402/signer.js'
  );
  return {
    ...actual,
    signPayment: (...args: unknown[]) => mockSignPayment(...args),
  };
});

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/x402-evidence'
);

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

const WALLET: SignerWallet = {
  privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
  address: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
};

function toolsCallBody(toolName: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: {} },
  });
}

function makePaidTool(metaX402: Record<string, unknown>): Tool {
  return {
    name: 'extract',
    description: 'Paid extract',
    inputSchema: { type: 'object' },
    _meta: { x402: { paymentRequired: true, ...metaX402 } },
  } as unknown as Tool;
}

const catalog = loadJson('catalog.json');
const wellKnown = loadJson('well-known-extract.json');
const openapi = loadJson('openapi-extract.json');

const pin = pinFromBuyerRuntimeCatalog(catalog);
const wellKnownItem = findWellKnownItem(wellKnown, '/extract');
const wellKnownPin = pinFromWellKnownItem(wellKnownItem);
const openApiOp = findOpenApiOperation(openapi, '/extract', 'get');
const openApiPin = pinFromOpenApiOperation(openApiOp);

const matchingAccept: PaymentRequiredAccept = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '5000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x8904dF3DE6DFEe6a7C8cc38619d2f17806213Cee',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
};

const matchingResource = {
  url: 'https://agents.samedaydesk.com/extract?url=https%3A%2F%2Fexample.com',
};

beforeEach(() => {
  mockSignPayment.mockReset();
  mockSignPayment.mockResolvedValue({
    paymentSignatureBase64: 'mock-signature-base64',
    from: WALLET.address,
    to: matchingAccept.payTo,
    amountUsd: 0.005,
    amountAtomicUnits: 5000n,
    networkLabel: 'Base Mainnet',
    expiresAt: new Date(),
  });
});

describe('payment evidence pin from published documents', () => {
  it('reads the buyer catalog, well-known extract item, and OpenAPI x-payment-info', () => {
    expect(pin.scheme).toBe('exact');
    expect(pin.network).toBe('eip155:8453');
    expect(pin.payTo?.toLowerCase()).toBe('0x8904df3de6dfee6a7c8cc38619d2f17806213cee');
    expect(pin.amount).toBe('5000');
    expect(pin.origin).toBe('https://agents.samedaydesk.com');
    expect(pin.route).toBe('/extract');
    expect(pin.priceUsd).toBe(0.005);

    expect(wellKnownPin.payTo?.toLowerCase()).toBe(pin.payTo?.toLowerCase());
    expect(wellKnownPin.amount).toBe(pin.amount);
    expect(wellKnownPin.origin).toBe(pin.origin);
    expect(wellKnownPin.route).toBe('/extract');

    expect(openApiPin.scheme).toBe(pin.scheme);
    expect(openApiPin.network).toBe(pin.network);
    expect(openApiPin.asset?.toLowerCase()).toBe(pin.asset?.toLowerCase());
    expect(openApiPin.priceUsd).toBe(pin.priceUsd);
    expect(openApiPin.payTo).toBeUndefined();
  });

  it('keeps an accept that matches the catalog pin and well-known resource URL', () => {
    expect(acceptMatchesPin(matchingAccept, pin, matchingResource)).toBe(true);
    expect(acceptMatchesPin(matchingAccept, wellKnownPin, matchingResource)).toBe(true);
    expect(acceptMatchesPin(matchingAccept, openApiPin)).toBe(true);
    expect(selectAcceptMatchingPin([matchingAccept], pin, 'exact', matchingResource)?.amount).toBe(
      '5000'
    );
  });

  it('rejects a foreign payTo / origin and a stale amount', () => {
    const foreignPayTo: PaymentRequiredAccept = {
      ...matchingAccept,
      payTo: '0x0000000000000000000000000000000000000001',
    };
    const staleAmount: PaymentRequiredAccept = { ...matchingAccept, amount: '49900' };
    const foreignOrigin = { url: 'https://evil.example/extract?url=https://example.com' };

    expect(mismatchAgainstPin(foreignPayTo, pin)).toBe('payTo');
    expect(mismatchAgainstPin(staleAmount, pin)).toBe('amount');
    expect(mismatchAgainstPin(matchingAccept, pin, foreignOrigin)).toBe('origin');
    expect(selectAcceptMatchingPin([foreignPayTo, staleAmount], pin, 'exact')).toBeUndefined();
    expect(
      extractAcceptFromPaymentRequired(
        {
          x402Version: 2,
          accepts: [foreignPayTo],
          resource: matchingResource,
        },
        'exact',
        pin
      )
    ).toBeUndefined();
  });
});

describe('createX402FetchMiddleware evidencePin', () => {
  it('signs a tools/call whose _meta.x402 matches the catalog pin', async () => {
    const tool = makePaidTool({ accepts: [matchingAccept] });
    const cache: X402PaymentCache = { signature: null };
    const fetchFn = createX402FetchMiddleware(
      vi.fn().mockResolvedValue(new Response('', { status: 200 })),
      {
        wallet: WALLET,
        getToolByName: () => tool,
        paymentCache: cache,
        schemePreference: 'exact',
        evidencePin: pin,
      }
    );

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('extract') });

    expect(mockSignPayment).toHaveBeenCalledTimes(1);
    const accept = mockSignPayment.mock.calls[0]?.[0]?.accept as PaymentRequiredAccept;
    expect(accept.payTo).toBe(matchingAccept.payTo);
    expect(accept.amount).toBe('5000');
  });

  it('does not sign a foreign or stale fixture when a pin is set', async () => {
    const foreign: PaymentRequiredAccept = {
      ...matchingAccept,
      payTo: '0x0000000000000000000000000000000000000001',
    };
    const stale: PaymentRequiredAccept = { ...matchingAccept, amount: '49900' };
    const tool = makePaidTool({ accepts: [foreign, stale] });
    const cache: X402PaymentCache = { signature: null };
    const baseFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => tool,
      paymentCache: cache,
      schemePreference: 'exact',
      evidencePin: pin,
    });

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('extract') });

    expect(mockSignPayment).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(
      new Headers((baseFetch.mock.calls[0]?.[1] as RequestInit).headers).get('PAYMENT-SIGNATURE')
    ).toBeNull();
  });

  it('does not retry a 402 whose PAYMENT-REQUIRED is stale relative to the pin', async () => {
    const staleHeader = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: matchingResource,
        accepts: [{ ...matchingAccept, amount: '49900' }],
      })
    ).toString('base64');
    const cache: X402PaymentCache = { signature: null };
    const baseFetch = vi
      .fn()
      .mockResolvedValue(
        new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': staleHeader } })
      );
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => undefined,
      paymentCache: cache,
      schemePreference: 'exact',
      evidencePin: pin,
    });

    const response = await fetchFn('https://example.test/mcp', {
      method: 'POST',
      body: toolsCallBody('extract'),
    });

    expect(response.status).toBe(402);
    expect(mockSignPayment).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });
});
