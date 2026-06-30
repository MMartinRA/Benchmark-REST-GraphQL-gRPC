const express = require('express');
const { redisClient, getInstructorFlat, getInstructorFull } = require('./lib');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/instructors/:id', async (req, res) => {
  try {
    const data = await getInstructorFlat(Number(req.params.id));
    if (!data) return res.status(404).json({ error: 'not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/instructors/:id/full', async (req, res) => {
  try {
    const data = await getInstructorFull(Number(req.params.id));
    if (!data) return res.status(404).json({ error: 'not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

(async () => {
  await redisClient.connect();
  app.listen(PORT, () => console.log(`REST service escuchando en el puerto ${PORT}`));
})();
