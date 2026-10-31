import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readSSE } from '../src/sse.js';
import { createRepetitionGuard } from '../scripts/repetition-guard.mjs';
import { DEFAULT_PARAMS, normalizeParams, localSamplingParams } from '../src/generation.js';

const base = process.env.LOCAL_TEST_URL || 'http://127.0.0.1:5173';
const chatPath = '/local-api/v1/chat/completions';
const prompt = (content = 'Say hello in one short sentence.') => ({
	model: 'smollm2-135m-instruct',
	messages: [{ role: 'user', content }],
	temperature: 0,
	max_tokens: 32,
});
async function chat(body, options = {}) {
	return fetch(base + chatPath, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: options.signal || AbortSignal.timeout(45000),
	});
}
function byteStream(chunks) {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

before(async () => {
	try {
		const response = await fetch(base + '/local-api/health', { signal: AbortSignal.timeout(3000) });
		assert.equal(response.status, 200);
	} catch (error) {
		throw new Error(
			`Start the actual local server with npm run local before npm run test:local. ${error.message}`
		);
	}
});

test('SSE reassembles split UTF-8, CRLF, comments, multiple data lines and DONE', async () => {
	const encoder = new TextEncoder();
	const first = encoder.encode(': heartbeat\r\n\r\ndata: {"text":"Halo 🌙"');
	const second = encoder.encode(
		'}\r\n\r\nevent: custom\r\ndata: one\r\ndata: two\n\ndata: [DONE]\n\n'
	);
	const events = [];
	// Split the moon emoji itself, not just event boundaries.
	await readSSE(
		byteStream([first.subarray(0, first.length - 2), first.subarray(first.length - 2), second]),
		(event) => events.push(event)
	);
	assert.deepEqual(events, [
		{ event: 'message', data: '{"text":"Halo 🌙"}' },
		{ event: 'custom', data: 'one\ntwo' },
	]);
	assert.deepEqual(JSON.parse(events[0].data), { text: 'Halo 🌙' });
});

test('SSE surfaces server error events', async () => {
	await assert.rejects(
		readSSE(byteStream([new TextEncoder().encode('error: inference failed\n\n')]), () => {}),
		/inference failed/
	);
});

test('production UI and local assets are served without a cloud dependency', async () => {
	const response = await fetch(base);
	assert.equal(response.status, 200);
	const html = await response.text();
	assert.match(html, /llum · Local AI/);
	assert.doesNotMatch(html, /cdn\.jsdelivr/);
	const asset = html.match(/src="(\/assets\/[^\"]+\.js)"/)[1];
	const script = await fetch(base + asset);
	assert.equal(script.status, 200);
	assert.match(script.headers.get('content-type'), /javascript/);
	assert.match(await script.text(), /smollm2-135m-instruct/);
	assert.equal(
		(await fetch(base + '/.runtime/models/SmolLM2-135M-Instruct.Q4_1.gguf')).status,
		404
	);
	assert.equal((await fetch(base + '/local-api/secrets')).status, 404);
});

test('health reports the real CPU model and model discovery works', async () => {
	const health = await (await fetch(base + '/local-api/health')).json();
	assert.equal(health.status, 'ready');
	assert.equal(health.engine, 'llama.cpp');
	assert.equal(health.device, 'cpu');
	assert.equal(health.weightBytes, 98362432);
	assert.equal(health.contextTokens, 2048);
	assert.equal(health.penaltyLastN, 128);
	assert.equal(health.antiRepetition, true);
	assert.equal(health.sampling.repeat_penalty, 1.15);
	assert.equal(health.sampling.frequency_penalty, 0.25);
	const models = await (await fetch(base + '/local-api/v1/models')).json();
	assert.equal(models.data[0].id, 'smollm2-135m-instruct');
});

test('local sampling knobs are validated and forwarded to real inference', async () => {
	const response = await chat({
		...prompt('Write one short sentence about the sea.'),
		temperature: 0.4,
		top_p: 0.85,
		top_k: 30,
		repeat_penalty: 1.2,
		frequency_penalty: 0.3,
		anti_repetition: true,
	});
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.ok(result.choices[0].message.content.trim().length > 0);
	for (const body of [
		{ ...prompt(), top_p: 1.5 },
		{ ...prompt(), top_k: -1 },
		{ ...prompt(), top_k: 1.5 },
		{ ...prompt(), repeat_penalty: 0.5 },
		{ ...prompt(), frequency_penalty: 3 },
		{ ...prompt(), anti_repetition: 'yes' },
	]) {
		const invalid = await chat(body);
		assert.equal(invalid.status, 400);
		assert.ok((await invalid.json()).error.message);
	}
});

test('repetition guard stops degenerate loops while preserving ordinary text', () => {
	const ordinary = 'Here are three steps:\n1. Open the file.\n2. Edit the value.\n3. Save it.\n';
	const guard = createRepetitionGuard();
	const ordinaryPush = guard.push(ordinary);
	assert.equal(ordinaryPush.stopped, false);
	assert.equal(ordinaryPush.text + guard.flush().text, ordinary);

	const loop = 'The same sentence keeps appearing here. '.repeat(8);
	const looping = createRepetitionGuard();
	let emitted = '';
	for (const chunk of loop.match(/.{1,7}/gs)) {
		const result = looping.push(chunk);
		emitted += result.text;
		if (result.stopped) break;
	}
	assert.equal(looping.stopped, true);
	assert.ok(emitted.length < loop.length);
	assert.ok(emitted.includes('The same sentence keeps appearing here.'));
	assert.ok((emitted.match(/The same sentence keeps appearing here\./g) || []).length <= 2);

	const wordLoop = createRepetitionGuard();
	const repeatedWord = 'loop '.repeat(40);
	let wordEmitted = '';
	for (const chunk of repeatedWord.match(/.{1,5}/gs)) {
		const result = wordLoop.push(chunk);
		wordEmitted += result.text;
		if (result.stopped) break;
	}
	assert.equal(wordLoop.stopped, true);
	assert.ok(wordEmitted.length < repeatedWord.length);
});

test('generation params migrate old stored settings and map only local fields', () => {
	const migrated = normalizeParams({ temperature: 0.2, maxTokens: 128 });
	assert.equal(migrated.temperature, 0.2);
	assert.equal(migrated.maxTokens, 128);
	assert.equal(migrated.topP, DEFAULT_PARAMS.topP);
	assert.equal(migrated.antiRepetition, true);
	assert.deepEqual(localSamplingParams(migrated), {
		top_p: DEFAULT_PARAMS.topP,
		top_k: DEFAULT_PARAMS.topK,
		repeat_penalty: DEFAULT_PARAMS.repeatPenalty,
		frequency_penalty: DEFAULT_PARAMS.frequencyPenalty,
	});
	assert.equal(normalizeParams({ topK: 999 }).topK, 200);
	assert.equal(normalizeParams({ repeatPenalty: 0 }).repeatPenalty, 1);
});

test('real non-streaming inference returns generated text and token usage', async () => {
	const response = await chat(prompt('Write one short sentence about the moon.'));
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.equal(result.model, 'smollm2-135m-instruct');
	assert.ok(result.choices[0].message.content.trim().length > 0);
	assert.ok(result.usage.completion_tokens > 0);
	assert.ok(result.usage.completion_tokens <= 32);
});

test('real streaming inference returns parseable OpenAI-compatible chunks', async () => {
	const response = await chat({ ...prompt(), stream: true, anti_repetition: true });
	assert.equal(response.status, 200);
	assert.match(response.headers.get('content-type'), /text\/event-stream/);
	const chunks = [];
	await readSSE(response.body, ({ data }) => chunks.push(JSON.parse(data)));
	assert.ok(chunks.length >= 2);
	assert.ok(chunks.some((chunk) => chunk.choices[0]?.delta?.content));
	const terminal = chunks.find((chunk) => chunk.choices[0]?.finish_reason);
	assert.ok(terminal);
	assert.ok(['stop', 'length'].includes(terminal.choices[0].finish_reason));
	// The terminal chunk must arrive after all content, including the guard's flushed tail.
	assert.equal(chunks.indexOf(terminal), chunks.length - 1);
});

test('invalid, multimodal, tool and excessive-token requests fail clearly', async () => {
	for (const body of [
		{ ...prompt(), max_tokens: 9999 },
		{ ...prompt(), temperature: -1 },
		{ ...prompt(), tools: [] },
		{ ...prompt(), messages: [] },
		{
			...prompt(),
			messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
		},
	]) {
		const response = await chat(body);
		assert.equal(response.status, 400);
		assert.ok((await response.json()).error.message);
	}
	const oversized = await chat(prompt('x'.repeat(33000)));
	assert.ok([400, 413].includes(oversized.status));
});

test('cross-site inference and unsupported methods are blocked', async () => {
	const blocked = await fetch(base + chatPath, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
		body: JSON.stringify(prompt()),
	});
	assert.equal(blocked.status, 403);
	assert.equal((await fetch(base + chatPath)).status, 405);
});

test('one generation at a time protects the small CPU runtime', async () => {
	const first = await chat({
		...prompt('Write a detailed story about a robot.'),
		max_tokens: 128,
		stream: true,
	});
	assert.equal(first.status, 200);
	const reader = first.body.getReader();
	await reader.read();
	try {
		const second = await chat(prompt());
		assert.equal(second.status, 429);
		assert.ok((await second.json()).error.message);
	} finally {
		await reader.cancel();
	}
	// Let the upstream generator observe the disconnect before the next test.
	await new Promise((resolve) => setTimeout(resolve, 1200));
});
