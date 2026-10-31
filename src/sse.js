/** Incremental SSE parser: preserves UTF-8 and events split across network chunks. */
export async function readSSE(stream, onEvent) {
	if (!stream) throw new Error('The model server returned an empty response');
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let finished = false;

	async function consume(block) {
		const lines = block.replace(/\r\n/g, '\n').split('\n');
		let event = 'message';
		const data = [];
		for (const line of lines) {
			if (line.startsWith('event:')) event = line.slice(6).trim();
			else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
			else if (line.startsWith('error:')) throw new Error(line.slice(6).trim());
		}
		if (!data.length) return;
		const payload = data.join('\n');
		if (payload === '[DONE]') {
			finished = true;
			return;
		}
		await onEvent({ event, data: payload });
	}

	try {
		while (!finished) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			buffer = buffer.replace(/\r\n/g, '\n');
			let boundary;
			while (!finished && (boundary = buffer.indexOf('\n\n')) !== -1) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				await consume(block);
			}
			if (done) {
				if (buffer.trim()) await consume(buffer);
				break;
			}
		}
	} finally {
		if (finished) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
