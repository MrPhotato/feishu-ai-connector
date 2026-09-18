import { ServiceUnavailableException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

interface PrivateRequestSnapshot {
  body: unknown;
  query: Request['query'];
  headers: Request['headers'];
  originalUrl: string;
  url: string;
  interactionUid?: string;
  request?: Request;
}

interface PrivateResponseSnapshot {
  json: Response['json'];
  send: Response['send'];
  redirect: Response['redirect'];
  response?: Response;
}

const requests: WeakMap<Request, PrivateRequestSnapshot> = new WeakMap();
const responses: WeakMap<Response, PrivateResponseSnapshot> = new WeakMap();
const PRIVATE_PATH: RegExp = /^(?:\/app\/[^/]+)?\/(?:oidc(?:\/|$)|interaction(?:\/|$)|auth\/feishu\/callback(?:\/|$)|mcp(?:\/|$)|openapi\/connector-auth-storage\/execute(?:\/|$))/iu;

function pathname(url: string): string { return url.split('?')[0]; }

function logSafeUrl(url: string): string {
  return pathname(url)
    .replace(/(\/interaction\/)[^/]+/iu, '$1__private__')
    .replace(/(\/oidc\/(?:auth|resume|interaction)\/)[^/]+/iu, '$1__private__');
}

/** Ordinary module middleware: retains routing shape and all platform authentication headers. */
function connectorPrivacyMiddleware(request: Request, response: Response, next: NextFunction): void {
  if (!PRIVATE_PATH.test(pathname(request.originalUrl || request.url)) || requests.has(request)) {
    next(); return;
  }
  const originalUrl: string = request.originalUrl || request.url;
  const interactionMatch: RegExpMatchArray | null = pathname(originalUrl).match(/\/interaction\/([^/]+)/iu);
  let interactionUid: string | undefined;
  try { interactionUid = interactionMatch ? decodeURIComponent(interactionMatch[1]) : undefined; } catch {
    response.statusCode = 400;
    response.setHeader('Content-Type', 'application/json');
    response.end('{"error":"invalid_request"}');
    return;
  }
  requests.set(request, {
    body: request.body, query: request.query, headers: { ...request.headers },
    originalUrl, url: request.url, interactionUid,
  });
  responses.set(response, { json: response.json, send: response.send, redirect: response.redirect });
  // Never restore these fields on the real request: SDK finish listeners retain that object.
  request.body = undefined;
  Object.defineProperty(request, 'query', { value: {}, writable: true, configurable: true, enumerable: true });
  request.originalUrl = logSafeUrl(originalUrl);
  request.url = logSafeUrl(request.url);
  if (Object.hasOwn(request, 'rawBody')) Reflect.set(request, 'rawBody', undefined);
  next();
}

/** The raw values exist only on a separate request object, never on the logging-visible request. */
function connectorPrivateRequest(request: Request): Request {
  const snapshot: PrivateRequestSnapshot | undefined = requests.get(request);
  if (!snapshot) throw new ServiceUnavailableException('Private request handling is unavailable.');
  if (snapshot.request) return snapshot.request;
  // Inherit the genuine IncomingMessage and platform context; do not synthesize an identity.
  const shadow: Request = Object.create(request);
  Object.defineProperties(shadow, {
    body: { value: snapshot.body, writable: true, configurable: true, enumerable: true },
    query: { value: snapshot.query, writable: true, configurable: true, enumerable: true },
    headers: { value: snapshot.headers, writable: true, configurable: true, enumerable: true },
    originalUrl: { value: snapshot.originalUrl, writable: true, configurable: true, enumerable: true },
    url: { value: snapshot.url, writable: true, configurable: true, enumerable: true },
    params: { value: { ...request.params, ...(snapshot.interactionUid ? { uid: snapshot.interactionUid } : {}) },
      writable: true, configurable: true, enumerable: true },
  });
  snapshot.request = shadow;
  return shadow;
}

/**
 * Keep the real response and its observability listeners intact. Only the handler's view uses
 * pre-interceptor Express serializers, which write via the real socket's end method. Handler
 * methods must return void, otherwise the platform also logs the Nest return value.
 */
function connectorPrivateResponse(response: Response): Response {
  const snapshot: PrivateResponseSnapshot | undefined = responses.get(response);
  if (!snapshot) throw new ServiceUnavailableException('Private response handling is unavailable.');
  if (snapshot.response) return snapshot.response;
  const shadow: Response = new Proxy(response, {
    get(target: Response, property: string | symbol): unknown {
      const captured: unknown = property === 'json' ? snapshot.json :
        property === 'send' ? snapshot.send : property === 'redirect' ? snapshot.redirect : undefined;
      if (typeof captured === 'function') {
        return (...args: unknown[]): unknown => Reflect.apply(captured, shadow, args);
      }
      const value: unknown = Reflect.get(target, property, target);
      // Express's app is itself callable, but is data, not a response method.
      if (property === 'app' || property === 'constructor') return value;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, args);
        return result === target ? shadow : result;
      };
    },
  });
  snapshot.response = shadow;
  return shadow;
}

export { connectorPrivacyMiddleware, connectorPrivateRequest, connectorPrivateResponse };
