#!/usr/bin/env node
/** One-command production gateway: static llum UI + same-origin local inference. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readSSE } from '../src/sse.js';
import { createRepetitionGuard, REPETITION_NOTICE } from './repetition-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(root, 'scripts/local-model.json'), 'utf8'));
const modelPath = resolve(root, '.runtime/models', config.file);
const python = resolve(root, '.runtime/venv/bin/python');
const dist = resolve(root, 'dist');
const port = Number(process.env.PORT || 5173);
const modelPort = Number(process.env.LOCAL_MODEL_PORT || 8080);
const token = randomBytes(32).toString('hex');
const upstream = `http://127.0.0.1:${modelPort}`;
const maxBody = 32 * 1024;
let child;
let stopping = false;
let activeGenerations = 0;
let server;

function json(response, status, body) {
	if (response.destroyed || response.headersSent) return;
	response.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	});
	response.end(JSON.stringify(body));
}
function apiError(response, status, message) {
	json(response, status, { error: { message, type: 'local_gateway_error' } });
}
function validPort(value) {
	return Number.isInteger(value) && value >= 1024 && value <= 65535;
}
if (!validPort(port) || !validPort(modelPort) || port === modelPort) {
	throw new Error('PORT and LOCAL_MODEL_PORT must be distinct ports between 1024 and 65535');
}
for (const file of [python, modelPath, resolve(dist, 'index.html')]) {
	if (!existsSync(file))
		throw new Error(
			`Missing ${file}. Run npm ci, python3 scripts/setup-local.py, and npm run build.`
		);
}
const actualHash = createHash('sha256').update(readFileSync(modelPath)).digest('hex');
if (actualHash !== config.sha256) throw new Error('Model checksum mismatch. Refusing to start.');

const mime = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
};

async function readBody(request) {
	if (Number(request.headers['content-length'] || 0) > maxBody) {
		const error = new Error('Request exceeds 32 KiB');
		error.status = 413;
		throw error;
	}
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > maxBody) {
			const error = new Error('Request exceeds 32 KiB');
			error.status = 413;
			throw error;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

class RepetitionStop extends Error {}
function writeSSE(response, payload) {
	if (!response.destroyed) response.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function writeSSEDone(response) {
	if (!response.destroyed) response.write('data: [DONE]\n\n');
}

async function proxy(request, response, path) {
	const routes = { '/health': 'GET', '/v1/models': 'GET', '/v1/chat/completions': 'POST' };
	if (!(path in routes)) return apiError(response, 404, 'Unknown local API endpoint');
	if (request.method !== routes[path]) return apiError(response, 405, 'Method not allowed');
	// No cross-origin API access or browser-supplied upstream credentials.
	if (request.headers['sec-fetch-site'] === 'cross-site')
		return apiError(response, 403, 'Cross-site API access is not allowed');
	const isGeneration = path === '/v1/chat/completions';
	if (isGeneration && activeGenerations >= 1) {
		response.setHeader('Retry-After', '2');
		return apiError(
			response,
			429,
			'Model sedang menjawab. Tunggu selesai atau hentikan jawaban sebelumnya.'
		);
	}
	const controller = new AbortController();
	let repetitionStopped = false;
	const timeout = setTimeout(() => controller.abort(), 120000);
	const onClose = () => {
		if (!response.writableEnded) controller.abort();
	};
	response.on('close', onClose);
	if (isGeneration) activeGenerations++;
	try {
		let body = request.method === 'POST' ? await readBody(request) : undefined;
		let antiRepetition = true;
		if (isGeneration && body) {
			try {
				const payload = JSON.parse(body.toString('utf8'));
				if (payload && typeof payload === 'object') {
					if ('anti_repetition' in payload) {
						if (typeof payload.anti_repetition !== 'boolean') {
							return apiError(response, 400, 'anti_repetition must be a boolean');
						}
						antiRepetition = payload.anti_repetition;
						delete payload.anti_repetition;
					}
					body = Buffer.from(JSON.stringify(payload));
				}
			} catch {
				// Let the inference backend produce the canonical invalid-JSON error.
			}
		}
		const result = await fetch(upstream + path, {
			method: request.method,
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body,
			signal: controller.signal,
		});
		const headers = {
			'Content-Type': result.headers.get('content-type') || 'application/json',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'X-Accel-Buffering': 'no',
		};
		response.writeHead(result.status, headers);
		const isSSE = headers['Content-Type'].includes('text/event-stream');
		if (isGeneration && result.ok && antiRepetition && isSSE && result.body) {
			const guard = createRepetitionGuard();
			let meta = {};
			let finalChunk = null;
			try {
				await readSSE(result.body, async ({ data }) => {
					const chunk = JSON.parse(data);
					meta = { id: chunk.id, model: chunk.model, created: chunk.created };
					if (chunk.error) {
						writeSSE(response, chunk);
						return;
					}
					const choice = chunk.choices?.[0];
					if (choice?.finish_reason) {
						// Hold the terminal chunk until the guard's held-back tail is flushed.
						finalChunk = chunk;
						return;
					}
					const text = choice?.delta?.content;
					if (typeof text === 'string' && text.length > 0) {
						const guarded = guard.push(text);
						if (guarded.text) {
							writeSSE(response, {
								...chunk,
								choices: [{ ...choice, delta: { ...choice.delta, content: guarded.text } }],
							});
						}
						if (guarded.stopped) {
							repetitionStopped = true;
							writeSSE(response, {
								...meta,
								object: 'chat.completion.chunk',
								choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
								notice: REPETITION_NOTICE,
							});
							writeSSEDone(response);
							controller.abort();
							throw new RepetitionStop();
						}
					} else {
						writeSSE(response, chunk);
					}
				});
				const tail = guard.flush();
				if (tail.text) {
					writeSSE(response, {
						...meta,
						object: 'chat.completion.chunk',
						choices: [{ index: 0, delta: { content: tail.text }, finish_reason: null }],
					});
				}
				writeSSE(
					response,
					finalChunk || {
						...meta,
						object: 'chat.completion.chunk',
						choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
					}
				);
				writeSSEDone(response);
			} catch (error) {
				if (!(error instanceof RepetitionStop)) throw error;
			}
			response.end();
		} else if (isGeneration && result.ok && antiRepetition && !isSSE) {
			const payload = await result.json();
			const choice = payload.choices?.[0];
			const text = choice?.message?.content;
			if (typeof text === 'string') {
				const guard = createRepetitionGuard();
				const guarded = guard.push(text);
				if (guarded.stopped) {
					choice.message.content = guarded.text;
					choice.finish_reason = 'stop';
					payload.notice = REPETITION_NOTICE;
				}
			}
			response.end(JSON.stringify(payload));
		} else if (result.body) {
			await pipeline(Readable.fromWeb(result.body), response);
		} else {
			response.end();
		}
	} catch (error) {
		if (repetitionStopped) {
			// Upstream abort was intentional; the browser already received a normal stop chunk.
		} else if (!controller.signal.aborted) {
			apiError(
				response,
				error.status || 503,
				error.status
					? error.message
					: 'Mesin model belum siap atau koneksi inferensi terputus. Coba lagi.'
			);
		} else if (!response.destroyed) {
			const message =
				'Batas waktu inferensi tercapai atau permintaan dihentikan. Coba pertanyaan lebih pendek.';
			if (
				response.headersSent &&
				response.getHeader('Content-Type')?.includes('text/event-stream')
			) {
				response.end(`data: ${JSON.stringify({ error: { message } })}\n\n`);
			} else {
				apiError(response, 504, message);
			}
		}
	} finally {
		clearTimeout(timeout);
		response.off('close', onClose);
		if (isGeneration) activeGenerations--;
		if (!response.writableEnded) response.end();
	}
}

async function serveStatic(request, response, pathname) {
	let decoded;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return json(response, 400, { error: 'Invalid path' });
	}
	if (decoded.includes('\0') || decoded.includes('\\'))
		return json(response, 400, { error: 'Invalid path' });
	let file = resolve(dist, '.' + decoded);
	if (file !== dist && !file.startsWith(dist + sep))
		return json(response, 403, { error: 'Forbidden' });
	if (existsSync(file) && statSync(file).isDirectory()) file = resolve(file, 'index.html');
	if (!existsSync(file)) {
		if (extname(decoded)) return json(response, 404, { error: 'Not found' });
		file = resolve(dist, 'index.html');
	}
	if (request.method !== 'GET' && request.method !== 'HEAD')
		return apiError(response, 405, 'Method not allowed');
	response.writeHead(200, {
		'Content-Type': mime[extname(file)] || 'application/octet-stream',
		'Content-Length': statSync(file).size,
		'Cache-Control': file.includes(`${sep}assets${sep}`)
			? 'public, max-age=31536000, immutable'
			: 'no-cache',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
	});
	if (request.method === 'HEAD') return response.end();
	try {
		await pipeline(createReadStream(file), response);
	} catch {
		/* Client may navigate away. */
	}
}

function stop(code = 0) {
	if (stopping) return;
	stopping = true;
	server?.close();
	if (child && child.exitCode === null) {
		child.kill('SIGTERM');
		const killTimer = setTimeout(() => child?.kill('SIGKILL'), 5000);
		killTimer.unref();
		child.once('exit', () => clearTimeout(killTimer));
	}
	const exitTimer = setTimeout(() => process.exit(code), 6000);
	exitTimer.unref();
	process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

async function start() {
	console.log(`Loading ${config.name} (${config.size} bytes), SHA-256 verified…`);
	child = spawn(python, [resolve(root, 'scripts/local_server.py')], {
		cwd: root,
		env: {
			...process.env,
			LOCAL_MODEL_TOKEN: token,
			LOCAL_MODEL_PORT: String(modelPort),
			OMP_NUM_THREADS: '2',
		},
		stdio: ['ignore', 'inherit', 'inherit'],
	});
	child.on('error', (error) => {
		console.error(error.message);
		stop(1);
	});
	child.on('exit', (code) => {
		if (!stopping) {
			console.error(`Inference engine exited (${code}).`);
			stop(1);
		}
	});
	const deadline = Date.now() + 90000;
	let ready = false;
	while (Date.now() < deadline && !stopping && child.exitCode === null) {
		try {
			const result = await fetch(upstream + '/health', { signal: AbortSignal.timeout(1500) });
			const health = await result.json();
			if (result.ok && health.status === 'ready' && health.model === config.id) {
				ready = true;
				break;
			}
		} catch {
			/* The engine loads weights before opening its loopback port. */
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	if (!ready || stopping) {
		if (!stopping) console.error('Model did not become ready within 90 seconds.');
		stop(1);
		return;
	}
	server = createServer((request, response) => {
		const pathname = new URL(request.url, 'http://localhost').pathname;
		if (pathname.startsWith('/local-api/')) {
			proxy(request, response, pathname.slice('/local-api'.length)).catch(() =>
				apiError(response, 500, 'Gateway error')
			);
		} else {
			serveStatic(request, response, pathname).catch(() =>
				apiError(response, 500, 'Static file error')
			);
		}
	});
	server.requestTimeout = 130000;
	server.headersTimeout = 10000;
	server.on('error', (error) => {
		console.error(error.message);
		stop(1);
	});
	server.listen(port, '0.0.0.0', () => {
		console.log(`\nllum local is ready: http://localhost:${port}`);
		console.log(`Browser API: /local-api/v1/chat/completions`);
		console.log(`Inference: loopback only, port ${modelPort}; CPU threads: ${config.threads}`);
		console.log('No cloud API key required. Press Ctrl+C to stop both servers.\n');
	});
}
start().catch((error) => {
	console.error(error);
	stop(1);
});
