const express = require('express');
const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const app = express();
const PORT = process.env.PORT || 9100;

// Un sampler activo por nombre de contenedor (en este despliegue solo hay uno: stack-app)
const samplers = new Map();

function startSampling(containerName) {
  if (samplers.has(containerName)) return; // ya estaba corriendo, no reiniciar
  const container = docker.getContainer(containerName);
  const entry = { stream: null, samples: [] };
  samplers.set(containerName, entry);

  container.stats({ stream: true }, (err, stream) => {
    if (err) {
      console.error(`No se pudo leer stats de ${containerName}:`, err.message);
      return;
    }
    entry.stream = stream;
    stream.on('data', (chunk) => {
      try {
        const stats = JSON.parse(chunk.toString());
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        const cpuCount =
          stats.cpu_stats.online_cpus ||
          (stats.cpu_stats.cpu_usage.percpu_usage ? stats.cpu_stats.cpu_usage.percpu_usage.length : 1);
        if (systemDelta > 0 && cpuDelta >= 0) {
          entry.samples.push((cpuDelta / systemDelta) * cpuCount * 100);
        }
      } catch (_e) {
        // chunk parcial o inválido, se ignora
      }
    });
  });
}

function stopSampling(containerName) {
  const entry = samplers.get(containerName);
  if (!entry) return 0;
  if (entry.stream) entry.stream.destroy();
  samplers.delete(containerName);
  if (entry.samples.length === 0) return 0;
  return entry.samples.reduce((a, b) => a + b, 0) / entry.samples.length;
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/cpu/start', (req, res) => {
  const containerName = req.query.container;
  if (!containerName) return res.status(400).json({ error: 'falta ?container=' });
  startSampling(containerName);
  res.json({ started: containerName });
});

app.get('/cpu/stop', (req, res) => {
  const containerName = req.query.container;
  if (!containerName) return res.status(400).json({ error: 'falta ?container=' });
  const avgCpuPct = stopSampling(containerName);
  res.json({ container: containerName, avgCpuPct });
});

app.listen(PORT, () => console.log(`stats-agent escuchando en el puerto ${PORT}`));
