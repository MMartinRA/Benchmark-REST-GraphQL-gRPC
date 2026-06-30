const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const protobuf = require('protobufjs');

const targetsPath = path.join(__dirname, 'targets.json');
if (!fs.existsSync(targetsPath)) {
  console.error(
    'Falta targets.json. Copiá targets.example.json a targets.json y completá las IPs de "terraform output".'
  );
  process.exit(1);
}
const targetsConfig = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));

const PROTO_PATH = path.join(__dirname, 'proto', 'instructor.proto');
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef).instructor;
const grpcClient = new proto.InstructorService(
  `${targetsConfig.grpc.ip}:50051`,
  grpc.credentials.createInsecure()
);

// Carga independiente del mismo .proto vía protobufjs, solo para poder
// re-serializar la respuesta y medir su tamaño real en bytes (igual que
// hacemos con content-length en REST/GraphQL). No interfiere con el
// cliente gRPC de arriba, que sigue manejando la llamada real.
const protoRoot = protobuf.loadSync(PROTO_PATH);
const InstructorFlatType = protoRoot.lookupType('instructor.InstructorFlat');
const InstructorFullType = protoRoot.lookupType('instructor.InstructorFull');

const SEED_SIZE = 50;
const LOADS = [100, 200, 300, 400, 500, 1000, 2000];
const MODES = ['flat', 'nested'];
const REPETITIONS = 5;
const CONCURRENCY = 10;
const STATS_AGENT_PORT = 9100;
const REMOTE_CONTAINER_NAME = 'stack-app'; // mismo nombre en los 3 stacks remotos

const TARGETS = [
  {
    name: 'rest',
    type: 'rest',
    baseUrl: `http://${targetsConfig.rest.ip}:3000`,
    statsAgentUrl: `http://${targetsConfig.rest.ip}:${STATS_AGENT_PORT}`,
  },
  {
    name: 'graphql',
    type: 'graphql',
    url: `http://${targetsConfig.graphql.ip}:4000`,
    statsAgentUrl: `http://${targetsConfig.graphql.ip}:${STATS_AGENT_PORT}`,
  },
  {
    name: 'grpc',
    type: 'grpc',
    client: grpcClient,
    statsAgentUrl: `http://${targetsConfig.grpc.ip}:${STATS_AGENT_PORT}`,
  },
];

const GRAPHQL_QUERIES = {
  flat: 'query($id: Int!) { instructor(id: $id) { id name nationalId educationLevel } }',
  nested:
    'query($id: Int!) { instructor(id: $id) { id name nationalId educationLevel university { name country ranking } degree { title year } } }',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Desvío estándar muestral (n-1). Con un solo valor devuelve 0 en vez de NaN.
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

async function waitForServices() {
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r1 = await fetch(`${TARGETS[0].baseUrl}/health`);
      if (!r1.ok) throw new Error('rest no responde aún');

      const r2 = await fetch(TARGETS[1].url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      if (!r2.ok) throw new Error('graphql no responde aún');

      await new Promise((resolve, reject) => {
        grpcClient.GetInstructor({ id: 1 }, (err) => (err ? reject(err) : resolve()));
      });

      for (const target of TARGETS) {
        const r = await fetch(`${target.statsAgentUrl}/health`);
        if (!r.ok) throw new Error(`stats-agent de ${target.name} no responde aún`);
      }

      console.log('Los tres stacks remotos están listos. Empezando el benchmark.\n');
      return;
    } catch (err) {
      console.log(`Esperando servicios remotos (intento ${i + 1}/${maxAttempts})... ${err.message}`);
      await sleep(2000);
    }
  }
  throw new Error('Los servicios remotos no estuvieron listos a tiempo.');
}

// --- Muestreo de CPU vía el stats-agent remoto (HTTP en vez de socket local) ---

async function startCpuSampler(target) {
  await fetch(`${target.statsAgentUrl}/cpu/start?container=${REMOTE_CONTAINER_NAME}`);
  return {
    async stop() {
      const res = await fetch(`${target.statsAgentUrl}/cpu/stop?container=${REMOTE_CONTAINER_NAME}`);
      const data = await res.json();
      return data.avgCpuPct || 0;
    },
  };
}

// Devuelve { ok, ms, bytes } en éxito, o { ok: false, ms, error } en falla.
// "bytes" es el tamaño real de la respuesta sobre la red: content body crudo
// en REST/GraphQL, y la respuesta re-serializada con protobuf en gRPC.
async function runOne(target, mode, id) {
  const start = performance.now();

  try {
    if (target.type === 'rest') {
      const url = mode === 'flat' ? `${target.baseUrl}/instructors/${id}` : `${target.baseUrl}/instructors/${id}/full`;
      const res = await fetch(url);
      const text = await res.text();
      const bytes = Buffer.byteLength(text, 'utf8');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      JSON.parse(text);
      return { ok: true, ms: performance.now() - start, bytes };
    } else if (target.type === 'graphql') {
      const res = await fetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: GRAPHQL_QUERIES[mode], variables: { id } }),
      });
      const text = await res.text();
      const bytes = Buffer.byteLength(text, 'utf8');
      const body = JSON.parse(text);
      if (!res.ok || body.errors) throw new Error(body.errors ? JSON.stringify(body.errors) : `HTTP ${res.status}`);
      return { ok: true, ms: performance.now() - start, bytes };
    } else if (target.type === 'grpc') {
      const method = mode === 'flat' ? 'GetInstructor' : 'GetInstructorFull';
      const response = await new Promise((resolve, reject) => {
        target.client[method]({ id }, (err, response) => (err ? reject(err) : resolve(response)));
      });
      const MsgType = mode === 'flat' ? InstructorFlatType : InstructorFullType;
      const bytes = MsgType.encode(MsgType.fromObject(response)).finish().length;
      return { ok: true, ms: performance.now() - start, bytes };
    }
  } catch (err) {
    return { ok: false, ms: performance.now() - start, error: err.message };
  }
}

async function runRequests(target, mode, total) {
  const results = [];
  let next = 1;

  async function worker() {
    while (next <= total) {
      const id = ((next - 1) % SEED_SIZE) + 1;
      next += 1;
      const r = await runOne(target, mode, id);
      results.push(r);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, worker);
  await Promise.all(workers);
  return results;
}

function computeStats(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = mean(sorted);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { avg, p95, min: sorted[0], max: sorted[sorted.length - 1] };
}

async function main() {
  await waitForServices();

  const resultsPath = path.join(__dirname, 'results', 'results-cloud.csv');
  const detailPath = path.join(__dirname, 'results', 'results-cloud-detail.csv');
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });

  fs.writeFileSync(
    resultsPath,
    'protocol,mode,requests,repetitions,avg_latency_ms,stddev_latency_ms,p95_latency_ms,min_latency_ms,max_latency_ms,' +
      'avg_cpu_pct,stddev_cpu_pct,avg_payload_bytes,error_count,error_rate_pct,throughput_rps\n'
  );
  fs.writeFileSync(
    detailPath,
    'protocol,mode,requests,repetition,avg_latency_ms,p95_latency_ms,min_latency_ms,max_latency_ms,' +
      'cpu_pct,avg_payload_bytes,errors,elapsed_ms,throughput_rps\n'
  );

  for (const target of TARGETS) {
    for (const mode of MODES) {
      for (const load of LOADS) {
        const allLatencies = [];
        const allPayloads = [];
        const cpuSamples = [];
        const repAvgLatencies = [];
        let totalErrors = 0;
        let totalSuccesses = 0;
        let totalElapsedMs = 0;

        for (let r = 0; r < REPETITIONS; r++) {
          const sampler = await startCpuSampler(target);

          const repStart = Date.now();
          const results = await runRequests(target, mode, load);
          const repElapsedMs = Date.now() - repStart;

          const MIN_SAMPLING_WINDOW_MS = 1500;
          if (repElapsedMs < MIN_SAMPLING_WINDOW_MS) {
            await sleep(MIN_SAMPLING_WINDOW_MS - repElapsedMs);
          }

          const cpuAvg = await sampler.stop();

          const successes = results.filter((res) => res.ok);
          const failures = results.filter((res) => !res.ok);
          const repLatencies = successes.map((res) => res.ms);
          const repPayloads = successes.map((res) => res.bytes);
          const repAvgLatency = mean(repLatencies);
          const repAvgPayload = mean(repPayloads);
          const repThroughput = successes.length / (repElapsedMs / 1000);

          allLatencies.push(...repLatencies);
          allPayloads.push(...repPayloads);
          cpuSamples.push(cpuAvg);
          repAvgLatencies.push(repAvgLatency);
          totalErrors += failures.length;
          totalSuccesses += successes.length;
          totalElapsedMs += repElapsedMs;

          const repStats = computeStats(repLatencies.length ? repLatencies : [0]);
          const detailLine =
            `${target.name},${mode},${load},${r + 1},${repAvgLatency.toFixed(2)},${repStats.p95.toFixed(2)},` +
            `${repStats.min.toFixed(2)},${repStats.max.toFixed(2)},${cpuAvg.toFixed(2)},${repAvgPayload.toFixed(0)},` +
            `${failures.length},${repElapsedMs},${repThroughput.toFixed(2)}\n`;
          fs.appendFileSync(detailPath, detailLine);
        }

        const s = computeStats(allLatencies.length ? allLatencies : [0]);
        const avgCpu = mean(cpuSamples);
        const stdCpu = stddev(cpuSamples);
        const stdLatency = stddev(repAvgLatencies);
        const avgPayload = mean(allPayloads);
        const totalAttempted = totalSuccesses + totalErrors;
        const errorRate = totalAttempted > 0 ? (totalErrors / totalAttempted) * 100 : 0;
        const throughput = totalElapsedMs > 0 ? totalSuccesses / (totalElapsedMs / 1000) : 0;

        const line =
          `${target.name},${mode},${load},${REPETITIONS},${s.avg.toFixed(2)},${stdLatency.toFixed(2)},` +
          `${s.p95.toFixed(2)},${s.min.toFixed(2)},${s.max.toFixed(2)},${avgCpu.toFixed(2)},${stdCpu.toFixed(2)},` +
          `${avgPayload.toFixed(0)},${totalErrors},${errorRate.toFixed(2)},${throughput.toFixed(2)}\n`;
        fs.appendFileSync(resultsPath, line);

        console.log(
          `[${target.name}] ${mode} x${load} -> avg=${s.avg.toFixed(1)}ms (±${stdLatency.toFixed(1)}) ` +
            `p95=${s.p95.toFixed(1)}ms cpu=${avgCpu.toFixed(1)}% payload=${avgPayload.toFixed(0)}B ` +
            `errors=${totalErrors}/${totalAttempted} throughput=${throughput.toFixed(1)}req/s`
        );
      }
    }
  }

  console.log(`\nListo. Resumen en results/results-cloud.csv, detalle por repetición en results/results-cloud-detail.csv`);
}

main().catch((err) => {
  console.error('Error fatal en el benchmark:', err);
  process.exit(1);
});
