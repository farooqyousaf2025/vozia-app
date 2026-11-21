import { one, ping } from '../config/db';
import { redis } from '../config/redis';
import { livekitRooms } from './livekit.service';

export type DependencyState = 'HEALTHY' | 'DEGRADED' | 'DOWN';

export type PlatformOperationsSnapshot = {
  generatedAt: string;
  uptimeSeconds: number;
  overall: DependencyState;
  dependencies: {
    backend: DependencyState;
    postgres: DependencyState;
    redis: DependencyState;
    livekit: DependencyState;
  };
  liveMediaRooms: number | null;
  queues: {
    withdrawalsPending: number | null;
    rechargesAwaitingVerification: number | null;
    applicationsPending: number | null;
  };
};

export async function platformOperationsSnapshot(access: {
  finance: boolean;
  applications: boolean;
}): Promise<PlatformOperationsSnapshot> {
  const [postgresUp, redisResult, livekitResult] = await Promise.all([
    ping(),
    redis.ping().then(() => true).catch(() => false),
    livekitRooms().listRooms([]).then((rooms) => rooms.length).catch(() => null),
  ]);

  let queues: PlatformOperationsSnapshot['queues'] = {
    withdrawalsPending: null,
    rechargesAwaitingVerification: null,
    applicationsPending: null,
  };

  if (postgresUp && (access.finance || access.applications)) {
    const [financeCounts, applicationCount] = await Promise.all([
      access.finance
        ? one<{ withdrawals: string; recharges: string }>(
            `SELECT
               (SELECT COUNT(*) FROM withdrawal_requests WHERE status IN ('PENDING','APPROVED'))::text AS withdrawals,
               (SELECT COUNT(*) FROM recharge_orders WHERE status IN ('AWAITING_PAYMENT','AWAITING_VERIFICATION'))::text AS recharges`,
          ).catch(() => null)
        : Promise.resolve(null),
      access.applications
        ? one<{ applications: string }>(
            `SELECT COUNT(*)::text AS applications FROM role_applications WHERE status IN ('PENDING','INFO_REQUESTED')`,
          ).catch(() => null)
        : Promise.resolve(null),
    ]);
    queues = {
      withdrawalsPending: access.finance && financeCounts ? Number(financeCounts.withdrawals) : null,
      rechargesAwaitingVerification: access.finance && financeCounts ? Number(financeCounts.recharges) : null,
      applicationsPending: access.applications && applicationCount ? Number(applicationCount.applications) : null,
    };
  }

  const dependencies = {
    backend: 'HEALTHY' as DependencyState,
    postgres: postgresUp ? 'HEALTHY' as DependencyState : 'DOWN' as DependencyState,
    redis: redisResult ? 'HEALTHY' as DependencyState : 'DOWN' as DependencyState,
    livekit: livekitResult === null ? 'DOWN' as DependencyState : 'HEALTHY' as DependencyState,
  };
  const overall: DependencyState = Object.values(dependencies).every((state) => state === 'HEALTHY')
    ? 'HEALTHY'
    : Object.values(dependencies).some((state) => state === 'DOWN')
      ? 'DOWN'
      : 'DEGRADED';

  return {
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    overall,
    dependencies,
    liveMediaRooms: livekitResult,
    queues,
  };
}
