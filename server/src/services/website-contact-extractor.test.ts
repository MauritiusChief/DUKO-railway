import { gzipSync } from 'node:zlib';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CLEANED_TEXT_BYTES,
  MAX_COMPRESSED_BYTES,
  MAX_DECOMPRESSED_BYTES,
  WebsiteExtractionError,
  extractContactsFromHtml,
  extractWebsiteContacts,
  isPublicIpAddress,
  requestPinnedPage,
} from './website-contact-extractor.js';

const input = { placeId: 'place-1', websiteUrl: 'https://example.com/' };
const publicAddress = [{ address: '93.184.216.34', family: 4 as const }];
const transportServers: Server[] = [];

afterEach(async () => {
  await Promise.all(transportServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function htmlResponse(html: string | Buffer, headers: Record<string, string> = {}) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body: Buffer.isBuffer(html) ? html : Buffer.from(html),
  };
}

describe('isPublicIpAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2001::1',
    '2002:a00:1::1',
    '3fff::1',
    '::ffff:127.0.0.1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('accepts public address %s', (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });
});

describe('extractContactsFromHtml', () => {
  it('extracts metadata, mailto, tel and visible-text contacts while removing active content', () => {
    const result = extractContactsFromHtml(`
      <!doctype html>
      <html>
        <head>
          <title> Example Merchant </title>
          <meta name="description" content=" Custom cabinets and design ">
          <link rel="canonical" href="/home">
          <style>.hidden { display: none }</style>
          <script>secret@example.com +1 212-555-9999</script>
        </head>
        <body>
          <a href="mailto:Sales%40Example.com?subject=Hello">Email us</a>
          <a href="tel:+1-212-555-0100">Call</a>
          <div hidden><a href="mailto:trap@example.com">Hidden trap</a></div>
          <p>Backup: support@example.com or (646) 555-0110 ext 2</p>
        </body>
      </html>
    `, 'https://example.com/start');

    expect(result).toMatchObject({
      sourceUrl: 'https://example.com/start',
      pageTitle: 'Example Merchant',
      pageDescription: 'Custom cabinets and design',
      canonicalUrl: 'https://example.com/home',
      textTruncated: false,
    });
    expect(result.emails).toEqual(['sales@example.com', 'support@example.com']);
    expect(result.phones).toEqual(['+1-212-555-0100', '(646) 555-0110 ext 2']);
    expect(result.cleanedWebsiteText).not.toContain('secret@example.com');
    expect(result.cleanedWebsiteText).toContain('Backup: support@example.com');
  });

  it('handles malformed percent encoding without failing the page', () => {
    const result = extractContactsFromHtml('<a href="mailto:%E0%A4%A">Mail</a><a href="tel:%E0%A4%A">Call</a>', 'https://example.com');
    expect(result.emails).toEqual([]);
  });

  it('truncates cleaned text to at most 50 KiB on a UTF-8 boundary', () => {
    const result = extractContactsFromHtml(`<body>${'商家正文 '.repeat(20_000)}</body>`, 'https://example.com');
    expect(result.textTruncated).toBe(true);
    expect(Buffer.byteLength(result.cleanedWebsiteText, 'utf8')).toBeLessThanOrEqual(MAX_CLEANED_TEXT_BYTES);
    expect(result.cleanedWebsiteText).not.toContain('\uFFFD');
  });
});

describe('extractWebsiteContacts security and resource limits', () => {
  it('rejects private DNS results before making a request', async () => {
    const requestPage = vi.fn();
    await expect(extractWebsiteContacts(input, {
      resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }],
      requestPage,
    })).rejects.toMatchObject({ code: 'blocked_address' });
    expect(requestPage).not.toHaveBeenCalled();
  });

  it('rejects a hostname if any DNS answer is private', async () => {
    await expect(extractWebsiteContacts(input, {
      resolveHostname: async () => [
        ...publicAddress,
        { address: '10.0.0.2', family: 4 },
      ],
      requestPage: vi.fn(),
    })).rejects.toMatchObject({ code: 'blocked_address' });
  });

  it('revalidates DNS on every redirect and blocks a redirect to loopback', async () => {
    const resolveHostname = vi.fn(async (hostname: string) => hostname === 'example.com'
      ? publicAddress
      : [{ address: '127.0.0.1', family: 4 as const }]);
    const requestPage = vi.fn(async () => ({
      statusCode: 302,
      headers: { location: 'http://localhost/internal' },
      body: Buffer.alloc(0),
    }));

    await expect(extractWebsiteContacts(input, { resolveHostname, requestPage }))
      .rejects.toMatchObject({ code: 'blocked_address' });
    expect(resolveHostname).toHaveBeenCalledTimes(2);
    expect(requestPage).toHaveBeenCalledTimes(1);
  });

  it('pins each request to the validated address and follows at most three redirects', async () => {
    const requested: Array<{ host: string; address: string }> = [];
    let calls = 0;
    const result = await extractWebsiteContacts(input, {
      resolveHostname: async () => publicAddress,
      requestPage: async (url, address) => {
        requested.push({ host: url.hostname, address: address.address });
        calls += 1;
        if (calls < 4) {
          return { statusCode: 302, headers: { location: `/step-${calls}` }, body: Buffer.alloc(0) };
        }
        return htmlResponse('<title>Done</title><body>hello@example.com</body>');
      },
    });

    expect(requested).toHaveLength(4);
    expect(requested.every((entry) => entry.address === publicAddress[0].address)).toBe(true);
    expect(result.pageTitle).toBe('Done');
    expect(result.sourceUrl).toBe('https://example.com/step-3');

    await expect(extractWebsiteContacts(input, {
      resolveHostname: async () => publicAddress,
      requestPage: async () => ({ statusCode: 302, headers: { location: '/again' }, body: Buffer.alloc(0) }),
    })).rejects.toMatchObject({ code: 'too_many_redirects' });
  });

  it('requires HTML content and successful status', async () => {
    await expect(extractWebsiteContacts(input, {
      resolveHostname: async () => publicAddress,
      requestPage: async () => ({
        statusCode: 200,
        headers: { 'content-type': 'application/pdf' },
        body: Buffer.from('%PDF'),
      }),
    })).rejects.toMatchObject({ code: 'unsupported_content_type' });

    await expect(extractWebsiteContacts(input, {
      resolveHostname: async () => publicAddress,
      requestPage: async () => ({ statusCode: 503, headers: {}, body: Buffer.alloc(0) }),
    })).rejects.toMatchObject({ code: 'upstream_http_error', upstreamStatus: 503 });
  });

  it('supports gzip and rejects unknown content encoding', async () => {
    const compressed = gzipSync(Buffer.from('<title>Compressed</title><body>mail@example.com</body>'));
    const result = await extractWebsiteContacts(input, {
      resolveHostname: async () => publicAddress,
      requestPage: async () => htmlResponse(compressed, { 'content-encoding': 'gzip' }),
    });
    expect(result.pageTitle).toBe('Compressed');

    await expect(extractWebsiteContacts(input, {
      resolveHostname: async () => publicAddress,
      requestPage: async () => htmlResponse('body', { 'content-encoding': 'compress' }),
    })).rejects.toMatchObject({ code: 'unsupported_content_encoding' });
  });

  it('rejects compressed and decompressed bodies over their limits', async () => {
    await expect(extractWebsiteContacts(input, {
      resolveHostname: async () => publicAddress,
      requestPage: async () => htmlResponse(Buffer.alloc(MAX_COMPRESSED_BYTES + 1)),
    })).rejects.toMatchObject({ code: 'response_too_large' });

    const bomb = gzipSync(Buffer.alloc(MAX_DECOMPRESSED_BYTES + 1, 65));
    await expect(extractWebsiteContacts(input, {
      resolveHostname: async () => publicAddress,
      requestPage: async () => htmlResponse(bomb, { 'content-encoding': 'gzip' }),
    })).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('rejects non-HTTP protocols and credentials even when called outside the route', async () => {
    await expect(extractWebsiteContacts({ ...input, websiteUrl: 'file:///etc/passwd' }))
      .rejects.toBeInstanceOf(WebsiteExtractionError);
    await expect(extractWebsiteContacts({ ...input, websiteUrl: 'https://user:pass@example.com' }))
      .rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('applies one total deadline to DNS and all redirects', async () => {
    await expect(extractWebsiteContacts(input, {
      resolveHostname: async () => new Promise(() => undefined),
      timeoutMs: 5,
    })).rejects.toMatchObject({ code: 'timeout' });

    await expect(extractWebsiteContacts(input, {
      resolveHostname: async () => publicAddress,
      requestPage: async () => {
        await new Promise((resolve) => setTimeout(resolve, 8));
        return { statusCode: 302, headers: { location: '/next' }, body: Buffer.alloc(0) };
      },
      timeoutMs: 12,
    })).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('requestPinnedPage transport', () => {
  async function startServer(handler: http.RequestListener): Promise<number> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    transportServers.push(server);
    return (server.address() as AddressInfo).port;
  }

  it('connects to the pinned IP while preserving the original Host and fixed User-Agent', async () => {
    let receivedHost = '';
    let receivedUserAgent = '';
    const port = await startServer((req, res) => {
      receivedHost = req.headers.host ?? '';
      receivedUserAgent = req.headers['user-agent'] ?? '';
      res.setHeader('Content-Type', 'text/html');
      res.end('<title>Local fixture</title>');
    });

    const response = await requestPinnedPage(
      new URL(`http://merchant.invalid:${port}/home?x=1`),
      { address: '127.0.0.1', family: 4 },
      1_000,
    );
    expect(response.statusCode).toBe(200);
    expect(receivedHost).toBe(`merchant.invalid:${port}`);
    expect(receivedUserAgent).toBe('DUKO-Merchant-Contact-Extractor/1.0');
  });

  it('aborts slow responses and streaming bodies over the compressed limit', async () => {
    const slowPort = await startServer((_req, _res) => {
      // Deliberately leave the response open until the client timeout destroys the socket.
    });
    await expect(requestPinnedPage(
      new URL(`http://merchant.invalid:${slowPort}/`),
      { address: '127.0.0.1', family: 4 },
      10,
    )).rejects.toMatchObject({ code: 'timeout' });

    const largePort = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.write(Buffer.alloc(MAX_COMPRESSED_BYTES, 65));
      res.end(Buffer.alloc(1, 65));
    });
    await expect(requestPinnedPage(
      new URL(`http://merchant.invalid:${largePort}/`),
      { address: '127.0.0.1', family: 4 },
      1_000,
    )).rejects.toMatchObject({ code: 'response_too_large' });
  });
});
