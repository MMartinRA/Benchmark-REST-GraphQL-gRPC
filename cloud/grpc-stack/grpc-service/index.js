const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { redisClient, getInstructorFlat, getInstructorFull } = require('./lib');

const PROTO_PATH = path.join(__dirname, 'proto', 'instructor.proto');
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false, // convierte national_id -> nationalId, igual que en lib.js
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef).instructor;

async function GetInstructor(call, callback) {
  try {
    const data = await getInstructorFlat(call.request.id);
    if (!data) return callback({ code: grpc.status.NOT_FOUND, message: 'not found' });
    callback(null, data);
  } catch (err) {
    callback({ code: grpc.status.INTERNAL, message: err.message });
  }
}

async function GetInstructorFull(call, callback) {
  try {
    const data = await getInstructorFull(call.request.id);
    if (!data) return callback({ code: grpc.status.NOT_FOUND, message: 'not found' });
    callback(null, data);
  } catch (err) {
    callback({ code: grpc.status.INTERNAL, message: err.message });
  }
}

(async () => {
  await redisClient.connect();
  const server = new grpc.Server();
  server.addService(proto.InstructorService.service, { GetInstructor, GetInstructorFull });
  const PORT = process.env.PORT || 50051;
  server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), (err) => {
    if (err) {
      console.error('Error al iniciar el servidor gRPC:', err);
      process.exit(1);
    }
    console.log(`gRPC service escuchando en el puerto ${PORT}`);
  });
})();
