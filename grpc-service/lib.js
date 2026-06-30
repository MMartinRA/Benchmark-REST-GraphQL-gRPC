const mysql = require('mysql2/promise');
const { createClient } = require('redis');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

const redisClient = createClient({
  url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`,
});
redisClient.on('error', (err) => console.error('Redis error:', err.message));

const CACHE_TTL_SECONDS = 60;

async function getInstructorFlat(id) {
  const cacheKey = `instructor:flat:${id}`;
  const cached = await redisClient.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const [rows] = await pool.query(
    'SELECT id, name, national_id AS nationalId, education_level AS educationLevel FROM instructors WHERE id = ?',
    [id]
  );
  if (rows.length === 0) return null;

  const result = rows[0];
  await redisClient.set(cacheKey, JSON.stringify(result), { EX: CACHE_TTL_SECONDS });
  return result;
}

async function getInstructorFull(id) {
  const cacheKey = `instructor:full:${id}`;
  const cached = await redisClient.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const [rows] = await pool.query(
    `SELECT i.id, i.name, i.national_id AS nationalId, i.education_level AS educationLevel,
            u.name AS universityName, u.country AS universityCountry, u.ranking AS universityRanking,
            d.title AS degreeTitle, d.year AS degreeYear
     FROM instructors i
     LEFT JOIN universities u ON u.id = i.university_id
     LEFT JOIN academic_degrees d ON d.instructor_id = i.id
     WHERE i.id = ?`,
    [id]
  );
  if (rows.length === 0) return null;

  const r = rows[0];
  const result = {
    id: r.id,
    name: r.name,
    nationalId: r.nationalId,
    educationLevel: r.educationLevel,
    university: { name: r.universityName, country: r.universityCountry, ranking: r.universityRanking },
    degree: { title: r.degreeTitle, year: r.degreeYear },
  };
  await redisClient.set(cacheKey, JSON.stringify(result), { EX: CACHE_TTL_SECONDS });
  return result;
}

module.exports = { pool, redisClient, getInstructorFlat, getInstructorFull };
