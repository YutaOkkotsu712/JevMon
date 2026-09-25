// The live view without the bot: recorded battles, the performance page and replays, straight from the logs. Useful
// while the bot is stopped (a bench run, say) or for recording a replay. It serves on the loopback interface only.
//
//   npm run view                 # http://127.0.0.1:8733, or LIVE_VIEW_PORT
//   npm run view -- --port 8736
import { parseArgs } from 'node:util';
import { LiveServer } from '../dist/src/ui/LiveServer.js';

const { values: args } = parseArgs({ options: { port: { type: 'string' } } });
const port = Number(args.port ?? process.env.LIVE_VIEW_PORT ?? 8733);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const username = process.env.SHOWDOWN_USERNAME?.trim();
if (!username) throw new Error('SHOWDOWN_USERNAME is needed to tell our side from theirs in the logs');
const server = new LiveServer({ port, onStatus: status => console.log(status), username, logDirectory: 'logs' });
server.start();
console.log(`jevmon view on http://127.0.0.1:${port} (Live · Performance · Replays)`);
// The server does not hold the process open by itself, so that the bot can exit cleanly; this script must.
setInterval(() => {}, 1 << 30);
