import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { one, ping, pool } from '../config/db';
import { redis } from '../config/redis';
import { livekitRooms } from './livekit.service';

export type DependencyState = 'HEALTHY' | 'DEGRADED' | 'DOWN';
type MetricQuality = 'MEASURED' | 'ESTIMATED' | 'CONFIGURED' | 'UNAVAILABLE';

type ResourceMetric = {
  value: number | null;
  unit: string;
  capacity: number | null;
  available: number | null;
  percent: number | null;
  quality: MetricQuality;
  source: string;
  note?: string;
};

type ResourcePanel = {
  cpu: ResourceMetric;
  memory: ResourceMetric;
  networkIn: ResourceMetric;
  networkOut: ResourceMetric;
  diskRead: ResourceMetric;
  diskWrite: ResourceMetric;
  gpuUtilization: ResourceMetric;
  gpuMemory: ResourceMetric;
  facts: Array<{ label: string; value: string | number | null; unit?: string; quality: MetricQuality; source: string }>;
  samples: Array<{ name: string; value: number }>;
};

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
  resources: {
    backend: ResourcePanel;
    postgres: ResourcePanel;
    redis: ResourcePanel;
    livekit: ResourcePanel;
  };
  queues: {
    withdrawalsPending: number | null;
    rechargesAwaitingVerification: number | null;
    applicationsPending: number | null;
  };
};

const unavailable = (unit: string, source: string, note: string): ResourceMetric => ({
  value: null, unit, capacity: null, available: null, percent: null,
  quality: 'UNAVAILABLE', source, note,
});
const metric = (
  value: number | null, unit: string, source: string, opts: Partial<ResourceMetric> = {},
): ResourceMetric => ({
  value, unit, capacity: null, available: null, percent: null, quality: value === null ? 'UNAVAILABLE' : 'MEASURED',
  source, ...opts,
});
const emptyPanel = (source: string, note: string): ResourcePanel => ({
  cpu: unavailable('%', source, note),
  memory: unavailable('bytes', source, note),
  networkIn: unavailable('bytes', source, note),
  networkOut: unavailable('bytes', source, note),
  diskRead: unavailable('bytes', source, note),
  diskWrite: unavailable('bytes', source, note),
  gpuUtilization: unavailable('%', source, 'GPU telemetry requires an NVIDIA device and nvidia-smi inside the backend container.'),
  gpuMemory: unavailable('bytes', source, 'GPU telemetry requires an NVIDIA device and nvidia-smi inside the backend container.'),
  facts: [],
  samples: [],
});

function readFile(path: string): string | null {
  try { return fs.readFileSync(path, 'utf8').trim(); } catch { return null; }
}
function numericFile(path: string): number | null {
  const raw = readFile(path);
  if (raw === null || raw === 'max') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
function parseKeyValues(raw: string): Record<string, string> {
  return Object.fromEntries(raw.split(/\r?\n/).filter((line) => line.includes(':')).map((line) => {
    const index = line.indexOf(':');
    return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
}
function sumNetworkCounters(): { rx: number; tx: number } | null {
  const raw = readFile('/proc/net/dev');
  if (!raw) return null;
  let rx = 0; let tx = 0; let found = false;
  for (const line of raw.split('\n').slice(2)) {
    const parts = line.trim().split(/[:\s]+/);
    if (parts.length < 10 || parts[0] === 'lo') continue;
    const values = parts.slice(1).map(Number);
    if (!values.every(Number.isFinite)) continue;
    rx += values[0]; tx += values[8]; found = true;
  }
  return found ? { rx, tx } : null;
}
function cgroupIo(): { read: number; write: number } | null {
  const raw = readFile('/sys/fs/cgroup/io.stat');
  if (!raw) return null;
  let read = 0; let write = 0; let found = false;
  for (const line of raw.split('\n')) {
    const fields = line.split(/\s+/).slice(1);
    for (const field of fields) {
      const [key, value] = field.split('=');
      if (key === 'rbytes' && Number.isFinite(Number(value))) { read += Number(value); found = true; }
      if (key === 'wbytes' && Number.isFinite(Number(value))) { write += Number(value); found = true; }
    }
  }
  return found ? { read, write } : null;
}

let previousCpu: { usageMicros: number; at: number } | null = null;
function backendResources(): ResourcePanel {
  const panel = emptyPanel('backend container /proc and cgroup v2', 'Backend process/container metrics are not a measurement of other Docker services.');
  const now = Date.now();
  const cpuStat = parseKeyValues((readFile('/sys/fs/cgroup/cpu.stat') ?? '').replace(/ /g, ':'));
  const usageMicros = Number(cpuStat.usage_usec);
  const cpuMax = readFile('/sys/fs/cgroup/cpu.max')?.split(/\s+/) ?? [];
  const quota = cpuMax[0] && cpuMax[0] !== 'max' ? Number(cpuMax[0]) / Number(cpuMax[1]) : null;
  const cpuCapacity = quota && Number.isFinite(quota) && quota > 0 ? quota : os.cpus().length;
  if (Number.isFinite(usageMicros) && previousCpu) {
    const elapsedMicros = (now - previousCpu.at) * 1000;
    const usedMicros = Math.max(0, usageMicros - previousCpu.usageMicros);
    const percent = elapsedMicros > 0 ? Math.min(100, usedMicros / elapsedMicros / cpuCapacity * 100) : null;
    panel.cpu = metric(percent, '% of container CPU quota', 'cgroup v2 cpu.stat delta over successive dashboard samples', {
      capacity: cpuCapacity, available: percent === null ? null : Math.max(0, 100 - percent),
      percent, note: 'Sampled since the previous dashboard request; not a lifetime average.',
    });
  } else {
    panel.cpu = unavailable('%', 'cgroup v2 cpu.stat', 'CPU baseline is being collected; refresh once to calculate usage.');
  }
  if (Number.isFinite(usageMicros)) previousCpu = { usageMicros, at: now };

  const memoryUsed = numericFile('/sys/fs/cgroup/memory.current');
  const memoryLimit = numericFile('/sys/fs/cgroup/memory.max');
  if (memoryUsed !== null) {
    const percent = memoryLimit && memoryLimit > 0 ? memoryUsed / memoryLimit * 100 : null;
    panel.memory = metric(memoryUsed, 'bytes', 'cgroup v2 memory.current', {
      capacity: memoryLimit, available: memoryLimit === null ? null : Math.max(0, memoryLimit - memoryUsed),
      percent, note: memoryLimit === null ? 'Container memory limit is not set or is unavailable.' : 'Current container memory consumption.',
    });
  }
  const network = sumNetworkCounters();
  if (network) {
    panel.networkIn = metric(network.rx, 'bytes', '/proc/net/dev cumulative container network receive counter');
    panel.networkOut = metric(network.tx, 'bytes', '/proc/net/dev cumulative container network transmit counter');
  }
  const io = cgroupIo();
  if (io) {
    panel.diskRead = metric(io.read, 'bytes', 'cgroup v2 io.stat cumulative block-device reads');
    panel.diskWrite = metric(io.write, 'bytes', 'cgroup v2 io.stat cumulative block-device writes');
  } else {
    const procIo = parseKeyValues((readFile('/proc/self/io') ?? '').replace(/ /g, ':'));
    panel.diskRead = metric(Number(procIo.read_bytes) || null, 'bytes', '/proc/self/io process read_bytes counter', { note: 'Process-level counter; not total volume usage.' });
    panel.diskWrite = metric(Number(procIo.write_bytes) || null, 'bytes', '/proc/self/io process write_bytes counter', { note: 'Process-level counter; not total volume usage.' });
  }

  try {
    const output = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], {
      encoding: 'utf8', timeout: 1200, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const rows = output.split(/\r?\n/).map((line) => line.split(',').map((value) => Number(value.trim()))).filter((row) => row.length >= 3 && row.every(Number.isFinite));
    if (rows.length) {
      const utilization = rows.reduce((sum, row) => sum + row[0], 0) / rows.length;
      const used = rows.reduce((sum, row) => sum + row[1], 0) * 1024 * 1024;
      const total = rows.reduce((sum, row) => sum + row[2], 0) * 1024 * 1024;
      panel.gpuUtilization = metric(utilization, '%', 'nvidia-smi average across visible GPUs', { percent: utilization });
      panel.gpuMemory = metric(used, 'bytes', 'nvidia-smi summed GPU memory', { capacity: total, available: Math.max(0, total - used), percent: total > 0 ? used / total * 100 : null });
    }
  } catch { /* No NVIDIA runtime/device or nvidia-smi: remain explicitly unavailable. */ }

  const root = (() => { try { return fs.statfsSync('/'); } catch { return null; } })();
  if (root) panel.facts.push({ label: 'Container root filesystem available', value: Number(root.bavail) * Number(root.bsize), unit: 'bytes', quality: 'MEASURED', source: 'statfs(/)' });
  panel.facts.push({ label: 'Visible CPU cores', value: cpuCapacity, unit: 'cores', quality: quota ? 'MEASURED' : 'ESTIMATED', source: quota ? 'cgroup cpu.max quota' : 'os.cpus() visible count' });
  panel.facts.push({ label: 'Backend process RSS', value: process.memoryUsage().rss, unit: 'bytes', quality: 'MEASURED', source: 'Node.js process.memoryUsage()' });
  panel.facts.push({ label: 'Backend heap used', value: process.memoryUsage().heapUsed, unit: 'bytes', quality: 'MEASURED', source: 'Node.js process.memoryUsage()' });
  panel.facts.push({ label: 'Backend uptime', value: Math.round(process.uptime()), unit: 'seconds', quality: 'MEASURED', source: 'Node.js process.uptime()' });
  return panel;
}

async function postgresResources(): Promise<ResourcePanel> {
  const panel = emptyPanel('PostgreSQL SQL statistics', 'PostgreSQL CPU, host RAM, GPU and container network counters are not exposed by SQL; connect a metrics exporter for those host-level values.');
  const row = await one<{
    active_connections: string; max_connections: string; database_bytes: string;
    shared_buffers: string; blks_read: string; blks_hit: string; temp_bytes: string;
    xact_commit: string; xact_rollback: string; deadlocks: string; blk_read_time: string; blk_write_time: string;
  }>(`SELECT
      (SELECT count(*) FROM pg_stat_activity)::text AS active_connections,
      current_setting('max_connections') AS max_connections,
      pg_database_size(current_database())::text AS database_bytes,
      current_setting('shared_buffers') AS shared_buffers,
      COALESCE((SELECT blks_read FROM pg_stat_database WHERE datname = current_database()),0)::text AS blks_read,
      COALESCE((SELECT blks_hit FROM pg_stat_database WHERE datname = current_database()),0)::text AS blks_hit,
      COALESCE((SELECT temp_bytes FROM pg_stat_database WHERE datname = current_database()),0)::text AS temp_bytes,
      COALESCE((SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()),0)::text AS xact_commit,
      COALESCE((SELECT xact_rollback FROM pg_stat_database WHERE datname = current_database()),0)::text AS xact_rollback,
      COALESCE((SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()),0)::text AS deadlocks,
      COALESCE((SELECT blk_read_time FROM pg_stat_database WHERE datname = current_database()),0)::text AS blk_read_time,
      COALESCE((SELECT blk_write_time FROM pg_stat_database WHERE datname = current_database()),0)::text AS blk_write_time`);
  if (!row) throw new Error('PostgreSQL statistics unavailable');
  const active = Number(row.active_connections); const max = Number(row.max_connections);
  panel.facts.push(
    { label: 'Active connections', value: active, unit: 'connections', quality: 'MEASURED', source: 'pg_stat_activity' },
    { label: 'Connection capacity', value: max, unit: 'connections', quality: 'CONFIGURED', source: 'max_connections' },
    { label: 'Database size', value: Number(row.database_bytes), unit: 'bytes', quality: 'MEASURED', source: 'pg_database_size(current_database())' },
    { label: 'Shared buffers configured', value: row.shared_buffers, quality: 'CONFIGURED', source: 'PostgreSQL shared_buffers setting; not actual RAM usage' },
    { label: 'Temporary bytes written', value: Number(row.temp_bytes), unit: 'bytes', quality: 'MEASURED', source: 'pg_stat_database.temp_bytes cumulative' },
    { label: 'Committed transactions', value: Number(row.xact_commit), quality: 'MEASURED', source: 'pg_stat_database cumulative' },
    { label: 'Rolled-back transactions', value: Number(row.xact_rollback), quality: 'MEASURED', source: 'pg_stat_database cumulative' },
    { label: 'Deadlocks', value: Number(row.deadlocks), quality: 'MEASURED', source: 'pg_stat_database cumulative' },
    { label: 'Block read time', value: Number(row.blk_read_time), unit: 'ms', quality: 'MEASURED', source: 'pg_stat_database cumulative' },
    { label: 'Block write time', value: Number(row.blk_write_time), unit: 'ms', quality: 'MEASURED', source: 'pg_stat_database cumulative' },
  );
  const blocksRead = Number(row.blks_read); const blocksHit = Number(row.blks_hit);
  const hitRatio = blocksRead + blocksHit > 0 ? blocksHit / (blocksRead + blocksHit) * 100 : null;
  panel.facts.push({ label: 'Shared buffer cache hit ratio', value: hitRatio === null ? null : Number(hitRatio.toFixed(2)), unit: '%', quality: hitRatio === null ? 'UNAVAILABLE' : 'MEASURED', source: 'pg_stat_database blks_hit / (blks_hit + blks_read)' });
  panel.facts.push({ label: 'Connection pool capacity (backend)', value: pool.options.max ?? 20, unit: 'connections', quality: 'CONFIGURED', source: 'backend pg Pool max configuration' });
  panel.memory = metric(null, 'bytes', 'PostgreSQL host/container memory exporter not configured', { note: 'shared_buffers above is a configured cache size, not total PostgreSQL RAM usage.' });
  panel.cpu = unavailable('%', 'PostgreSQL host/container metrics exporter not configured', 'SQL does not report process CPU utilization.');
  return panel;
}

async function redisResources(): Promise<ResourcePanel> {
  const panel = emptyPanel('Redis INFO sections', 'Redis CPU, memory and network values are queried from Redis INFO; disk persistence IO is not directly exposed here.');
  const [memoryInfo, clientInfo, statsInfo, serverInfo, dbSize] = await Promise.all([
    redis.info('memory'), redis.info('clients'), redis.info('stats'), redis.info('server'), redis.dbsize(),
  ]);
  const memory = parseKeyValues(memoryInfo); const clients = parseKeyValues(clientInfo);
  const stats = parseKeyValues(statsInfo); const server = parseKeyValues(serverInfo);
  const used = Number(memory.used_memory); const max = Number(memory.maxmemory);
  panel.memory = metric(Number.isFinite(used) ? used : null, 'bytes', 'Redis INFO memory used_memory', {
    capacity: Number.isFinite(max) && max > 0 ? max : null,
    available: Number.isFinite(max) && max > 0 && Number.isFinite(used) ? Math.max(0, max - used) : null,
    percent: Number.isFinite(max) && max > 0 && Number.isFinite(used) ? used / max * 100 : null,
    note: Number.isFinite(max) && max > 0 ? 'Compared with Redis maxmemory.' : 'Redis maxmemory is unlimited; no configured memory ceiling.',
  });
  const totalCommands = Number(stats.total_commands_processed);
  panel.facts.push(
    { label: 'Connected clients', value: Number(clients.connected_clients) || 0, quality: 'MEASURED', source: 'Redis INFO clients' },
    { label: 'Tracked keys', value: dbSize, quality: 'MEASURED', source: 'Redis DBSIZE for selected database' },
    { label: 'Total commands processed', value: Number.isFinite(totalCommands) ? totalCommands : null, quality: 'MEASURED', source: 'Redis INFO stats cumulative' },
    { label: 'Cache hit ratio', value: Number.isFinite(Number(stats.keyspace_hits)) && Number(stats.keyspace_hits) + Number(stats.keyspace_misses) > 0 ? Number((Number(stats.keyspace_hits) / (Number(stats.keyspace_hits) + Number(stats.keyspace_misses)) * 100).toFixed(2)) : null, unit: '%', quality: 'MEASURED', source: 'Redis INFO stats keyspace hits/misses' },
    { label: 'Redis version', value: server.redis_version ?? null, quality: 'MEASURED', source: 'Redis INFO server' },
    { label: 'Memory fragmentation ratio', value: Number(memory.mem_fragmentation_ratio) || null, quality: 'MEASURED', source: 'Redis INFO memory' },
  );
  panel.networkIn = metric(Number(stats.total_net_input_bytes) || null, 'bytes', 'Redis INFO stats cumulative total_net_input_bytes');
  panel.networkOut = metric(Number(stats.total_net_output_bytes) || null, 'bytes', 'Redis INFO stats cumulative total_net_output_bytes');
  panel.cpu = unavailable('%', 'Redis INFO cpu delta not sampled', 'Redis reports cumulative CPU time; this view currently exposes command/network counters instead of a guessed CPU percentage.');
  panel.diskRead = metric(null, 'bytes', 'Redis persistence disk IO exporter not configured', { note: 'RDB/AOF persistence settings are not equivalent to actual disk throughput.' });
  panel.diskWrite = metric(null, 'bytes', 'Redis persistence disk IO exporter not configured');
  return panel;
}

async function livekitResources(): Promise<ResourcePanel> {
  const panel = emptyPanel('LiveKit room service API and optional Prometheus endpoint', 'LiveKit CPU, RAM, disk and network telemetry requires its Prometheus metrics endpoint.');
  const rooms = await livekitRooms().listRooms([]);
  const participants = rooms.reduce((sum, room) => sum + Number(room.numParticipants ?? 0), 0);
  panel.facts.push(
    { label: 'Active media rooms', value: rooms.length, quality: 'MEASURED', source: 'LiveKit RoomService.ListRooms' },
    { label: 'Connected participants', value: participants, quality: 'MEASURED', source: 'LiveKit RoomService.ListRooms participant counts' },
  );
  const endpoint = process.env.LIVEKIT_METRICS_URL || 'http://livekit:6789/metrics';
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(1500) });
    if (response.ok) {
      const body = await response.text();
      for (const line of body.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([-+0-9.eE]+)$/);
        if (!match || !/(cpu|memory|bytes|packet|room|participant|track)/i.test(match[1])) continue;
        const value = Number(match[2]);
        if (Number.isFinite(value)) panel.samples.push({ name: match[1], value });
      }
      panel.samples = panel.samples.slice(0, 24);
      if (panel.samples.length) {
        panel.facts.push({ label: 'Prometheus samples received', value: panel.samples.length, quality: 'MEASURED', source: endpoint });
      }
    }
  } catch { /* Keep room/participant counts and mark host resource metrics unavailable. */ }
  return panel;
}

export async function platformOperationsSnapshot(access: {
  finance: boolean;
  applications: boolean;
}): Promise<PlatformOperationsSnapshot> {
  const [postgresUp, redisResult, livekitResult, backendPanel] = await Promise.all([
    ping(),
    redis.ping().then(() => true).catch(() => false),
    livekitRooms().listRooms([]).then((rooms) => rooms.length).catch(() => null),
    Promise.resolve(backendResources()),
  ]);

  const [postgresPanel, redisPanel, livekitPanel] = await Promise.all([
    postgresUp ? postgresResources().catch(() => emptyPanel('PostgreSQL', 'Statistics query failed.')) : Promise.resolve(emptyPanel('PostgreSQL', 'PostgreSQL is unreachable.')),
    redisResult ? redisResources().catch(() => emptyPanel('Redis', 'INFO query failed.')) : Promise.resolve(emptyPanel('Redis', 'Redis is unreachable.')),
    livekitResult === null ? Promise.resolve(emptyPanel('LiveKit', 'LiveKit is unreachable.')) : livekitResources().catch(() => emptyPanel('LiveKit', 'LiveKit telemetry query failed.')),
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

  const resources = { backend: backendPanel, postgres: postgresPanel, redis: redisPanel, livekit: livekitPanel };
  const alerts: PlatformOperationsSnapshot['alerts'] = [];
  for (const [service, state] of Object.entries(dependencies)) {
    if (state === 'DOWN') alerts.push({
      id: `dependency-${service}`, severity: 'CRITICAL', service,
      metric: 'availability', message: `${service} dependency is unreachable.`,
      value: null, threshold: null, source: 'dependency connectivity check',
    });
  }
  const addThresholdAlert = (service: string, metricName: string, value: ResourceMetric, warning: number, critical: number) => {
    if (value.percent === null || value.quality === 'UNAVAILABLE' || !Number.isFinite(value.percent)) return;
    if (value.percent >= critical || value.percent >= warning) {
      const severity = value.percent >= critical ? 'CRITICAL' : 'WARNING';
      const threshold = severity === 'CRITICAL' ? critical : warning;
      alerts.push({
        id: `capacity-${service}-${metricName}`, severity, service, metric: metricName,
        message: `${service} ${metricName} is at ${value.percent.toFixed(1)}% of configured capacity.`,
        value: Number(value.percent.toFixed(1)), threshold, source: value.source,
      });
    }
  };
  addThresholdAlert('backend', 'CPU', resources.backend.cpu, 75, 90);
  addThresholdAlert('backend', 'memory', resources.backend.memory, 75, 90);
  addThresholdAlert('backend', 'GPU memory', resources.backend.gpuMemory, 80, 95);
  addThresholdAlert('redis', 'memory', resources.redis.memory, 75, 90);
  const activeConnections = resources.postgres.facts.find((fact) => fact.label === 'Active connections')?.value;
  const maxConnections = resources.postgres.facts.find((fact) => fact.label === 'Connection capacity')?.value;
  if (typeof activeConnections === 'number' && typeof maxConnections === 'number' && maxConnections > 0) {
    const connectionPercent = activeConnections / maxConnections * 100;
    addThresholdAlert('postgres', 'connections', {
      value: activeConnections, unit: 'connections', capacity: maxConnections,
      available: Math.max(0, maxConnections - activeConnections), percent: connectionPercent,
      quality: 'MEASURED', source: 'pg_stat_activity / max_connections',
    }, 75, 90);
  }

  return {
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    overall,
    dependencies,
    liveMediaRooms: livekitResult,
    resources,
    alerts,
    queues,
  };
}
