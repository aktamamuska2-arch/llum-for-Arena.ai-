/**
 * Streaming repetition guard for the local gateway.
 *
 * The guard is intentionally conservative: it allows normal lists, short
 * refrains, and code indentation, but stops clear degenerate loops (the same
 * sentence/line/8-gram emitted three times, or a long single-token run).
 * It returns a cut index in the original text so already-streamed prefixes
 * remain valid and the third repetition is never forwarded to the browser.
 */

const MIN_LINE_CHARS = 12;
const MIN_SENTENCE_CHARS = 20;
const NGRAM_SIZE = 8;
const MAX_REPEATS = 3;
const MAX_WORD_RUN = 12;
const MAX_CHAR_RUN = 48;

function normalize(text) {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function findRepeatedSegment(full) {
	let cut = null;
	const consider = (index) => {
		if (cut === null || index < cut) cut = index;
	};

	// Consecutive identical lines (including whitespace-only loops).
	const lines = [];
	let offset = 0;
	for (const line of full.split('\n')) {
		lines.push({ text: line, start: offset });
		offset += line.length + 1;
	}
	let run = 1;
	for (let i = 1; i < lines.length; i++) {
		const prev = normalize(lines[i - 1].text);
		const curr = normalize(lines[i].text);
		const same = curr.length > 0 && curr === prev;
		const blankLoop = lines[i].text.trim() === '' && lines[i - 1].text.trim() === '';
		if (same || blankLoop) {
			run++;
			if (run >= MAX_REPEATS && (curr.length >= MIN_LINE_CHARS || blankLoop)) {
				consider(lines[i - MAX_REPEATS + 1].start);
			}
		} else {
			run = 1;
		}
	}

	// Repeated complete sentences, even when separated by other text.
	const sentences = [...full.matchAll(/[^.!?\n]+[.!?]+/g)].map((match) => ({
		key: normalize(match[0]),
		start: match.index,
	}));
	const sentenceCounts = new Map();
	for (const sentence of sentences) {
		if (sentence.key.length < MIN_SENTENCE_CHARS) continue;
		const count = (sentenceCounts.get(sentence.key) || 0) + 1;
		sentenceCounts.set(sentence.key, count);
		if (count >= MAX_REPEATS) consider(sentence.start);
	}

	// Repeated word n-grams catch loops without punctuation.
	const words = [...full.matchAll(/\S+/g)].map((match) => ({
		key: normalize(match[0]),
		start: match.index,
	}));
	const ngramCounts = new Map();
	let wordRun = 1;
	for (let i = 0; i < words.length; i++) {
		if (i > 0 && words[i].key && words[i].key === words[i - 1].key) {
			wordRun++;
			if (wordRun >= MAX_WORD_RUN) consider(words[i - MAX_WORD_RUN + 1].start);
		} else {
			wordRun = 1;
		}
		if (i + NGRAM_SIZE > words.length) continue;
		const slice = words.slice(i, i + NGRAM_SIZE);
		if (slice.some((word) => !word.key)) continue;
		const key = slice.map((word) => word.key).join(' ');
		const previous = ngramCounts.get(key);
		if (previous) {
			// Count non-overlapping occurrences only.
			if (slice[0].start >= previous.end) {
				previous.count++;
				previous.end = slice[NGRAM_SIZE - 1].start + words[i + NGRAM_SIZE - 1].key.length;
				if (previous.count >= MAX_REPEATS) consider(slice[0].start);
			}
		} else {
			ngramCounts.set(key, {
				count: 1,
				end: slice[NGRAM_SIZE - 1].start + words[i + NGRAM_SIZE - 1].key.length,
			});
		}
	}

	// Long runs of a single character (e.g. "!!!!!!!!" or "──────").
	const charRun = full.match(/([^\s])\1{47,}/u);
	if (charRun) consider(charRun.index);

	return cut;
}

function safeStreamingEnd(text) {
	// Hold back enough tail text to retract a loop before it reaches the browser:
	// the current line/sentence, the last 12 words, and the last 48 characters.
	let end = text.length;
	const lastLine = text.lastIndexOf('\n');
	if (lastLine !== -1) end = Math.min(end, lastLine + 1);
	const sentenceBoundary = [...text.matchAll(/[.!?](?:\s|$)/g)].pop();
	if (sentenceBoundary) end = Math.min(end, sentenceBoundary.index + sentenceBoundary[0].length);
	const words = [...text.matchAll(/\S+/g)];
	if (words.length >= MAX_WORD_RUN) {
		end = Math.min(end, words[words.length - MAX_WORD_RUN].index);
	}
	return Math.max(0, Math.min(end, text.length - MAX_CHAR_RUN));
}

export function createRepetitionGuard() {
	let full = '';
	let emitted = 0;
	let stopped = false;
	return {
		get stopped() {
			return stopped;
		},
		push(text) {
			if (stopped || typeof text !== 'string' || text.length === 0) {
				return { text: '', stopped };
			}
			const candidate = full + text;
			const cut = findRepeatedSegment(candidate);
			let end;
			if (cut !== null) {
				stopped = true;
				// Normally the held-back tail guarantees cut >= emitted. If a very long
				// repeated unit is detected late, never try to "unsend" browser text.
				end = Math.max(emitted, Math.min(cut, candidate.length));
			} else {
				end = Math.max(emitted, safeStreamingEnd(candidate));
			}
			const delta = candidate.slice(emitted, end);
			full = candidate;
			emitted = end;
			return { text: delta, stopped };
		},
		flush() {
			if (stopped) return { text: '', stopped: true };
			const delta = full.slice(emitted);
			emitted = full.length;
			return { text: delta, stopped: false };
		},
	};
}

export const REPETITION_NOTICE =
	'Pengulangan terdeteksi; jawaban dihentikan agar tidak berulang. Coba preset Fokus, naikkan Repeat/Frequency Penalty, atau mulai chat baru.';
