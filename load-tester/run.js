const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const Docker = require('dockerode');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const PROTO_PATH = path.join(__dirname, 'proto', 'instructor.proto');
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef).instructor;
const grpcClient = new proto.InstructorService('grpc-service:50051', grpc.credentials.createInsecure());

const SEED_SIZE = 50; // cantidad de instructores cargados por shared/init.sql
const LOADS = [100, 200, 300, 400, 500];
const MODES = ['flat', 'nested'];
const REPETITIONS = 3; // corridas por combinación, para promediar ruido
const CONCURRENCY = 10;

const TARGETS = [
  { name: 'rest', type: 'rest', baseUrl: 'http://rest-service:3000', container: 'bench-rest-service' },
  { name: 'graphql', type: 'graphql', url: 'http://graphql-service:4000/', container: 'bench-graphql-service' },
  { name: 'grpc', type: 'grpc', container: 'bench-grpc-service', client: grpcClient },
];

const GRAPHQL_QUERIES = {
  flat: 'query($id: Int!) { instructor(id: $id) { id name nationalId educationLevel } }',
  nested:
    'query($id: Int!) { instructor(id: $id) { id name nationalId educationLevel university { name country ranking } degree { title year } } }',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServices() {
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r1 = await fetch('http://rest-service:3000/health');
      if (!r1.ok) throw new Error('rest-service no responde aún');

      const r2 = await fetch('http://graphql-service:4000/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      if (!r2.ok) throw new Error('graphql-service no responde aún');

      await new Promise((resolve, reject) => {
        grpcClient.GetInstructor({ id: 1 }, (err) => (err ? reject(err) : resolve()));
      });

      console.log('Los tres servicios están listos. Empezando el benchmark.\n');
      return;
    } catch (err) {
      console.log(`Esperando servicios (intento ${i + 1}/${maxAttempts})... ${err.message}`);
      await sleep(2000);
    }
  }
  throw new Error('Los servicios no estuvieron listos a tiempo.');
}

// --- Muestreo de CPU del contenedor vía la API de Docker (stream continuo) ---

function startCpuSampler(containerName) {
  const container = docker.getContainer(containerName);
  const samples = [];
  let stream = null;

  const ready = new Promise((resolveReady) => {
    container.stats({ stream: true }, (err, s) => {
      if (err) {
        console.error(`No se pudo leer stats de ${containerName}:`, err.message);
        resolveReady();
        return;
      }
      stream = s;
      stream.on('data', (chunk) => {
        try {
          const stats = JSON.parse(chunk.toString());
          const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
          const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
          const cpuCount =
            stats.cpu_stats.online_cpus ||
            (stats.cpu_stats.cpu_usage.percpu_usage ? stats.cpu_stats.cpu_usage.percpu_usage.length : 1);
          if (systemDelta > 0 && cpuDelta >= 0) {
            samples.push((cpuDelta / systemDelta) * cpuCount * 100);
          }
        } catch (_e) {
          // chunk parcial o inválido, se ignora
        }
      });
      resolveReady();
    });
  });

  return {
    ready,
    stop() {
      if (stream) stream.destroy();
      if (samples.length === 0) return 0;
      return samples.reduce((a, b) => a + b, 0) / samples.length;
    },
  };
}

// --- Ejecución de una solicitud individual contra cada protocolo ---

async function runOne(target, mode, id) {
  const start = performance.now();

  if (target.type === 'rest') {
    const url = mode === 'flat' ? `${target.baseUrl}/instructors/${id}` : `${target.baseUrl}/instructors/${id}/full`;
    const res = await fetch(url);
    await res.json();
  } else if (target.type === 'graphql') {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: GRAPHQL_QUERIES[mode], variables: { id } }),
    });
    await res.json();
  } else if (target.type === 'grpc') {
    const method = mode === 'flat' ? 'GetInstructor' : 'GetInstructorFull';
    await new Promise((resolve, reject) => {
      target.client[method]({ id }, (err, response) => (err ? reject(err) : resolve(response)));
    });
  }

  return performance.now() - start;
}

async function runRequests(target, mode, total) {
  const latencies = [];
  let next = 1;

  async function worker() {
    while (next <= total) {
      const id = ((next - 1) % SEED_SIZE) + 1;
      next += 1;
      const ms = await runOne(target, mode, id);
      latencies.push(ms);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, worker);
  await Promise.all(workers);
  return latencies;
}

function computeStats(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { avg, p95, min: sorted[0], max: sorted[sorted.length - 1] };
}

// --- Orquestación principal ---

async function main() {
  await waitForServices();

  const resultsPath = path.join(__dirname, 'results', 'results.csv');
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(
    resultsPath,
    'protocol,mode,requests,avg_latency_ms,p95_latency_ms,min_latency_ms,max_latency_ms,avg_cpu_pct\n'
  );

  for (const target of TARGETS) {
    for (const mode of MODES) {
      for (const load of LOADS) {
        const allLatencies = [];
        const cpuSamples = [];

        for (let r = 0; r < REPETITIONS; r++) {
          const sampler = startCpuSampler(target.container);
          await sampler.ready;
          const samplerStart = Date.now();
          const latencies = await runRequests(target, mode, load);

          // El daemon de Docker emite una muestra de stats aproximadamente cada 1s.
          // Si la ráfaga termina antes de eso, no llega a haber ninguna muestra para
          // promediar (por eso el CPU salía siempre en 0). Forzamos una ventana mínima.
          const MIN_SAMPLING_WINDOW_MS = 1500;
          const elapsed = Date.now() - samplerStart;
          if (elapsed < MIN_SAMPLING_WINDOW_MS) {
            await sleep(MIN_SAMPLING_WINDOW_MS - elapsed);
          }

          const cpuAvg = sampler.stop();

          allLatencies.push(...latencies);
          cpuSamples.push(cpuAvg);
        }

        const s = computeStats(allLatencies);
        const avgCpu = cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length;

        const line = `${target.name},${mode},${load},${s.avg.toFixed(2)},${s.p95.toFixed(2)},${s.min.toFixed(
          2
        )},${s.max.toFixed(2)},${avgCpu.toFixed(2)}\n`;
        fs.appendFileSync(resultsPath, line);

        console.log(
          `[${target.name}] ${mode} x${load} -> avg=${s.avg.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms cpu=${avgCpu.toFixed(
            1
          )}%`
        );
      }
    }
  }

  console.log(`\nListo. Resultados completos en results/results.csv`);
}

main().catch((err) => {
  console.error('Error fatal en el benchmark:', err);
  process.exit(1);
});
