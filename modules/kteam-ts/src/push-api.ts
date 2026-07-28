import { PushError, parseRegisterPushDevice, type PushDeviceView, type RegisterPushDeviceInput } from './push-types';

export interface PushApiService {
  publicKey(): Promise<string>;
  listDevices(): Promise<PushDeviceView[]>;
  registerDevice(input: RegisterPushDeviceInput): Promise<PushDeviceView>;
  revokeDevice(id: string): Promise<PushDeviceView>;
}

export interface PushApiRequest {
  method: string;
  url: URL;
  body?: unknown;
}

export interface PushApiResponse {
  status: number;
  body: unknown;
}

export const isPushPath = (pathname: string): boolean => pathname === '/v1/push' || pathname.startsWith('/v1/push/');

export function pushWardenDenial(method: string, pathname: string): string | null {
  if (!isPushPath(pathname)) return null;
  // Even the public VAPID half is admin-token gated so this surface never
  // widens the capability-scoped warden token by accident.
  return `${method === 'GET' ? 'read' : 'manage'} push notifications`;
}

function errorResponse(error: PushError): PushApiResponse {
  const status = error.code === 'not_found' ? 404 : error.code === 'invalid' ? 400 : 500;
  return { status, body: { error: error.message, code: error.code } };
}

/** Transport-shaped handler kept outside contended api-server.ts. Its entire
 * integration is one optional route check documented in real-push.patch.md. */
export class PushApi {
  constructor(private readonly service: PushApiService) {}

  async handle(request: PushApiRequest): Promise<PushApiResponse | null> {
    if (!isPushPath(request.url.pathname)) return null;
    try {
      if (request.url.pathname === '/v1/push/vapid' && request.method === 'GET') {
        return { status: 200, body: { publicKey: await this.service.publicKey() } };
      }
      if (request.url.pathname === '/v1/push/subscriptions') {
        if (request.method === 'GET') return { status: 200, body: { devices: await this.service.listDevices() } };
        if (request.method === 'POST') {
          return { status: 201, body: await this.service.registerDevice(parseRegisterPushDevice(request.body)) };
        }
        return null;
      }
      const match = request.url.pathname.match(/^\/v1\/push\/subscriptions\/([^/]+)$/u);
      if (match && request.method === 'DELETE') {
        let id: string;
        try {
          id = decodeURIComponent(match[1]!);
        } catch {
          throw new PushError('invalid', 'push device id is malformed');
        }
        return { status: 200, body: await this.service.revokeDevice(id) };
      }
      return null;
    } catch (error) {
      if (error instanceof PushError) return errorResponse(error);
      throw error;
    }
  }
}
