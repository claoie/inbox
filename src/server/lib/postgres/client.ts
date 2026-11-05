import { Pool, PoolOptions } from "./pool";

const {
  POSTGRES_HOST: host = "localhost",
  POSTGRES_PORT: port = "5432",
  POSTGRES_USER: user = "postgres",
  POSTGRES_PASSWORD: password,
  POSTGRES_DATABASE: database = "mail",
} = process.env;

const config: PoolOptions = {
  host,
  port: parseInt(port, 10),
  user,
  password,
  database,
  // The driver opens every connection on the first query rather than on
  // demand, so this is a standing connection count, not a ceiling.
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  statementTimeoutMillis: 30_000,
  // Client-side backstop: fires if statement_timeout can't — e.g. the TCP
  // connection is silently wedged and the server never delivers the abort.
  queryTimeoutMillis: 30_000,
};

let _pool: Pool | null = null;
const getPool = (): Pool => {
  if (!_pool) _pool = new Pool(config);
  return _pool;
};
export const resetPool = (): void => {
  _pool = null;
};
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop) {
    return Reflect.get(getPool(), prop, getPool());
  },
  set(_target, prop, value) {
    return Reflect.set(getPool(), prop, value, getPool());
  },
  has(_target, prop) {
    return Reflect.has(getPool(), prop);
  },
  deleteProperty(_target, prop) {
    return Reflect.deleteProperty(getPool(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(getPool());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(getPool(), prop);
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(getPool());
  },
});

// Graceful shutdown is handled centrally in start.ts (SIGTERM/SIGINT → shutdown()).
// Do not register pool.end() handlers here — duplicate handlers cause a race condition
// where pool.end() is called twice: once from client.ts and once from shutdown(),
// resulting in "Cannot use a pool after calling end on the pool" errors during startup.
