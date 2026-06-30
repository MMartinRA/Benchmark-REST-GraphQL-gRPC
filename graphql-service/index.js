const { ApolloServer } = require('@apollo/server');
const { startStandaloneServer } = require('@apollo/server/standalone');
const { redisClient, getInstructorFlat, getInstructorFull } = require('./lib');

const typeDefs = `#graphql
  type University {
    name: String
    country: String
    ranking: Int
  }

  type Degree {
    title: String
    year: Int
  }

  type Instructor {
    id: Int
    name: String
    nationalId: String
    educationLevel: String
    university: University
    degree: Degree
  }

  type Query {
    instructor(id: Int!): Instructor
  }
`;

const resolvers = {
  Query: {
    instructor: async (_parent, { id }) => getInstructorFlat(id),
  },
  Instructor: {
    // Estos resolvers solo se ejecutan si el cliente pide los campos anidados.
    university: async (parent) => {
      const full = await getInstructorFull(parent.id);
      return full ? full.university : null;
    },
    degree: async (parent) => {
      const full = await getInstructorFull(parent.id);
      return full ? full.degree : null;
    },
  },
};

(async () => {
  await redisClient.connect();
  const server = new ApolloServer({ typeDefs, resolvers });
  const { url } = await startStandaloneServer(server, {
    listen: { port: Number(process.env.PORT || 4000) },
  });
  console.log(`GraphQL service escuchando en ${url}`);
})();
