// Shared generation defaults/limits for the local CPU model.
// Keep these in sync with scripts/local_server.py and LOCAL_MODEL.md.
export const DEFAULT_PARAMS = {
	temperature: 0.65,
	topP: 0.9,
	topK: 40,
	repeatPenalty: 1.15,
	frequencyPenalty: 0.25,
	antiRepetition: true,
	maxTokens: 0,
	messagesContextLimit: 0,
	reasoningEffort: {
		'low-medium-high': 'high',
		range: 64000,
	},
};

export const LOCAL_LIMITS = {
	temperature: { min: 0, max: 2, step: 0.05 },
	topP: { min: 0, max: 1, step: 0.01 },
	topK: { min: 0, max: 200, step: 1 },
	repeatPenalty: { min: 1, max: 2, step: 0.01 },
	frequencyPenalty: { min: 0, max: 1, step: 0.05 },
};

export const LOCAL_PRESETS = {
	balanced: {
		temperature: 0.65,
		topP: 0.9,
		topK: 40,
		repeatPenalty: 1.15,
		frequencyPenalty: 0.25,
	},
	focused: {
		temperature: 0.35,
		topP: 0.8,
		topK: 30,
		repeatPenalty: 1.2,
		frequencyPenalty: 0.35,
	},
	creative: {
		temperature: 0.9,
		topP: 0.95,
		topK: 80,
		repeatPenalty: 1.1,
		frequencyPenalty: 0.15,
	},
};

function clampNumber(value, fallback, min, max, integer = false) {
	const number = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(number)) return fallback;
	const clamped = Math.min(max, Math.max(min, number));
	return integer ? Math.round(clamped) : clamped;
}

/** Merge older persisted params with new sampling fields without discarding user settings. */
export function normalizeParams(value) {
	const source = value && typeof value === 'object' ? value : {};
	const reasoning =
		source.reasoningEffort && typeof source.reasoningEffort === 'object'
			? source.reasoningEffort
			: {};
	return {
		...DEFAULT_PARAMS,
		temperature: clampNumber(source.temperature, DEFAULT_PARAMS.temperature, 0, 2),
		topP: clampNumber(source.topP, DEFAULT_PARAMS.topP, 0, 1),
		topK: clampNumber(source.topK, DEFAULT_PARAMS.topK, 0, 200, true),
		repeatPenalty: clampNumber(source.repeatPenalty, DEFAULT_PARAMS.repeatPenalty, 1, 2),
		frequencyPenalty: clampNumber(source.frequencyPenalty, DEFAULT_PARAMS.frequencyPenalty, 0, 1),
		antiRepetition:
			typeof source.antiRepetition === 'boolean'
				? source.antiRepetition
				: DEFAULT_PARAMS.antiRepetition,
		maxTokens: clampNumber(source.maxTokens, 0, 0, 128000, true),
		messagesContextLimit: clampNumber(source.messagesContextLimit, 0, 0, 1000, true),
		reasoningEffort: {
			'low-medium-high': ['low', 'medium', 'high'].includes(reasoning['low-medium-high'])
				? reasoning['low-medium-high']
				: DEFAULT_PARAMS.reasoningEffort['low-medium-high'],
			range: clampNumber(reasoning.range, DEFAULT_PARAMS.reasoningEffort.range, 0, 64000, true),
		},
	};
}

/** Only the local llama.cpp backend receives the llama-specific sampling fields. */
export function localSamplingParams(param) {
	const normalized = normalizeParams(param);
	return {
		top_p: normalized.topP,
		top_k: normalized.topK,
		repeat_penalty: normalized.repeatPenalty,
		frequency_penalty: normalized.frequencyPenalty,
	};
}
