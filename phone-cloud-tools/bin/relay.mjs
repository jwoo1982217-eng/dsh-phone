#!/usr/bin/env node
import { createRelay } from '../lib/relay.mjs';
const relay = createRelay();
const port = Number(process.env.DSH_RELAY_PORT ?? 8789);
relay.server.listen(port, '127.0.0.1', () => process.stdout.write('手机工具中继已启动，127.0.0.1:' + port + '；请通过 TLS 反向代理发布 /relay\n'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void relay.close());
