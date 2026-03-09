const net = require('net');

const LISTEN_HOST = process.env.PG_PROXY_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.PG_PROXY_PORT || 55432);
const TARGET_HOST = process.env.PG_TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.PG_TARGET_PORT || 5432);

const server = net.createServer((client) => {
  const upstream = net.createConnection({ host: TARGET_HOST, port: TARGET_PORT });
  client.pipe(upstream);
  upstream.pipe(client);

  const closeBoth = () => {
    client.destroy();
    upstream.destroy();
  };

  client.on('error', closeBoth);
  upstream.on('error', closeBoth);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`pg-proxy listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
