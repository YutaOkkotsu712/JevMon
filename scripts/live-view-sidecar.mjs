/** A corrected live view alongside an already-running bot. It reads the bot's read-only UI and battle logs. */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { PANEL_HTML } from '../dist/src/ui/panel.js';
import { ResultLogIndex } from '../dist/src/ui/results.js';

const username = process.env.SHOWDOWN_USERNAME;
if (!username) throw new Error('SHOWDOWN_USERNAME is required to identify our results');
const source = 'http://127.0.0.1:8733/state';
const port = Number(process.env.LIVE_VIEW_SIDECAR_PORT || 8734);
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8733) throw new Error('Invalid sidecar port');
const history = new ResultLogIndex(resolve('logs'), username);
const streams = new Set();
let state = null;
let previous = '';
let previousRoom = null;
let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const [response, recorded] = await Promise.all([fetch(source, { signal: AbortSignal.timeout(3000) }), history.refresh()]);
    if (!response.ok) throw new Error(`Bot UI returned ${response.status}`);
    const bot = await response.json();
    const byRoom = new Map(recorded.map(r => [r.room, r]));
    for (const r of bot.results || []) {
      const old = byRoom.get(r.room);
      byRoom.set(r.room, old ? { ...r, ...old, rating: old.rating || r.rating } : r);
    }
    const results = [...byRoom.values()].sort((a, b) => (a.finishedAt || '').localeCompare(b.finishedAt || '') || a.room.localeCompare(b.room));
    const latest = bot.result && byRoom.get(bot.result.room);
    state = { ...bot, result: latest || bot.result, results };
    const encoded = JSON.stringify(state);
    if (encoded !== previous) {
      const room = bot.live?.room || bot.arena?.room || null;
      const reset = room !== previousRoom;
      const frame = `data: ${JSON.stringify({ ...state, ...(reset ? { reset: true } : {}) })}\n\n`;
      for (const stream of streams) { try { stream.write(frame); } catch { streams.delete(stream); } }
      previous = encoded;
      previousRoom = room;
    }
  } catch (error) {
    console.error(`UI mirror waiting for bot: ${error instanceof Error ? error.message : String(error)}`);
  } finally { polling = false; }
}

await poll();
const server = createServer((request, response) => {
  const host = (request.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!new Set(['127.0.0.1', 'localhost', '[::1]']).has(host)) { response.writeHead(403).end(); return; }
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  const url = (request.url || '/').split('?')[0];
  const headers = { 'cache-control': 'no-store' };
  if (url === '/' || url === '/index.html') {
    response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }).end(PANEL_HTML);
  } else if (url === '/state') {
    if (!state) { response.writeHead(503, headers).end(); return; }
    response.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(state));
  } else if (url === '/events') {
    if (!state) { response.writeHead(503, headers).end(); return; }
    response.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive' });
    response.write(`data: ${JSON.stringify({ ...state, reset: true })}\n\n`);
    streams.add(response);
    request.on('close', () => streams.delete(response));
  } else response.writeHead(404, headers).end();
});
server.listen(port, '127.0.0.1', () => console.log(`Corrected live view on http://127.0.0.1:${port}`));
setInterval(poll, 1500);
