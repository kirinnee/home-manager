import type { KTeamPaths } from './paths';
import { PushApi } from './push-api';
import { PushNotifier } from './push-notifier';
import { PushSender } from './push-sender';
import { PushSubscriptionStore, pushSubscriptionFile } from './push-subscriptions';
import type { RegisterPushDeviceInput } from './push-types';
import { VapidKeyStore, vapidKeyFile } from './push-vapid';
import type { KTeamService } from './service';

/** Production composition root kept out of daemon-entry.ts. The daemon patch
 * constructs this once, passes `api` to startApiServer, and includes close() in
 * its bounded shutdown drain. */
export class PushService {
  readonly api: PushApi;
  private readonly subscriptions: PushSubscriptionStore;
  private readonly vapid: VapidKeyStore;
  private readonly notifier: PushNotifier;

  private constructor(paths: KTeamPaths, sessions: Pick<KTeamService, 'list' | 'get' | 'subscribe'>) {
    this.subscriptions = new PushSubscriptionStore(pushSubscriptionFile(paths.daemon));
    this.vapid = new VapidKeyStore(vapidKeyFile(paths.daemon));
    this.notifier = new PushNotifier(sessions, this.subscriptions, this.vapid, new PushSender());
    this.api = new PushApi({
      publicKey: () => this.vapid.publicKey(),
      listDevices: () => this.subscriptions.list(),
      registerDevice: (input: RegisterPushDeviceInput) => this.subscriptions.register(input),
      revokeDevice: (id: string) => this.subscriptions.revoke(id),
    });
  }

  static async create(
    paths: KTeamPaths,
    sessions: Pick<KTeamService, 'list' | 'get' | 'subscribe'>,
  ): Promise<PushService> {
    const service = new PushService(paths, sessions);
    await service.notifier.start();
    return service;
  }

  close(): Promise<void> {
    return this.notifier.close();
  }
}
