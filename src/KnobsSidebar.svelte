<script>
	import { createEventDispatcher } from 'svelte';
	import { params } from './stores.js';
	import { DEFAULT_PARAMS, LOCAL_LIMITS, LOCAL_PRESETS, normalizeParams } from './generation.js';
	import { feX } from './feather.js';
	import Icon from './Icon.svelte';

	export let knobsOpen = false;
	export let model = null;
	const dispatch = createEventDispatcher();

	$: isLocal = model?.provider === 'Local';
	$: presetName = isLocal
		? Object.entries(LOCAL_PRESETS).find(([, preset]) =>
				Object.entries(preset).every(([key, value]) => $params[key] === value)
			)?.[0] || 'custom'
		: 'custom';

	function applyPreset(name) {
		params.update((current) => normalizeParams({ ...current, ...LOCAL_PRESETS[name] }));
	}
	function reset() {
		params.update((current) =>
			normalizeParams({
				...DEFAULT_PARAMS,
				messagesContextLimit: current.messagesContextLimit,
				reasoningEffort: current.reasoningEffort,
			})
		);
	}
	function setParam(key, value) {
		params.update((current) => normalizeParams({ ...current, [key]: value }));
	}
</script>

<svelte:window
	on:keydown={(event) => {
		if (knobsOpen && event.key === 'Escape') dispatch('close');
	}}
/>

<aside
	data-sidebar="knobs"
	aria-label="Parameter generasi"
	aria-hidden={!knobsOpen}
	inert={!knobsOpen ? true : undefined}
	class="{knobsOpen
		? ''
		: 'translate-x-full'} fixed right-0 top-0 z-[100] flex h-full w-[min(320px,100vw)] flex-col border-l border-slate-200 bg-white transition-transform duration-300 ease-in-out"
>
	<div class="flex items-center justify-between border-b border-slate-200 px-4 py-3">
		<h2 class="text-sm font-semibold text-slate-800">Parameter generasi</h2>
		<button
			type="button"
			aria-label="Tutup parameter"
			class="rounded-full p-1.5 text-slate-600 hover:bg-slate-100"
			on:click={() => dispatch('close')}
		>
			<Icon icon={feX} class="h-4 w-4" />
		</button>
	</div>

	<div class="flex-1 overflow-y-auto px-4 py-4">
		{#if isLocal}
			<div class="mb-5 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
				<p class="text-xs font-semibold text-emerald-900">Anti-pengulangan aktif</p>
				<p class="mt-1 text-[11px] leading-4 text-emerald-800">
					Instruksi keras, penalti sampling, dan penjeda streaming bekerja bersama. Jika model
					mengulang kalimat/frasa yang sama, jawaban dihentikan otomatis.
				</p>
				<label class="mt-2 flex items-center gap-2 text-[11px] text-emerald-900">
					<input
						type="checkbox"
						bind:checked={$params.antiRepetition}
						class="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
					/>
					Hentikan pengulangan otomatis
				</label>
			</div>

			<div class="mb-5">
				<p class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Preset</p>
				<div class="grid grid-cols-3 gap-1.5">
					{#each [['focused', 'Fokus'], ['balanced', 'Seimbang'], ['creative', 'Kreatif']] as [key, label]}
						<button
							type="button"
							class="rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors {presetName ===
							key
								? 'border-emerald-500 bg-emerald-50 text-emerald-800'
								: 'border-slate-200 text-slate-600 hover:bg-slate-50'}"
							on:click={() => applyPreset(key)}
						>
							{label}
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<div class="space-y-5">
			<label class="block">
				<div class="mb-1.5 flex items-baseline justify-between text-xs text-slate-700">
					<span>Temperature</span>
					<input
						type="number"
						aria-label="Temperature value"
						min={LOCAL_LIMITS.temperature.min}
						max={LOCAL_LIMITS.temperature.max}
						step={LOCAL_LIMITS.temperature.step}
						value={$params.temperature}
						on:change={(event) => setParam('temperature', event.currentTarget.value)}
						class="w-16 rounded border border-slate-200 px-1 py-0.5 text-right text-[11px]"
					/>
				</div>
				<input
					type="range"
					aria-label="Temperature"
					min={LOCAL_LIMITS.temperature.min}
					max={LOCAL_LIMITS.temperature.max}
					step={LOCAL_LIMITS.temperature.step}
					bind:value={$params.temperature}
					class="w-full accent-emerald-600"
				/>
				<p class="mt-1 text-[10px] leading-4 text-slate-500">
					Rendah = lebih fokus; tinggi = lebih bervariasi. Untuk mengurangi loop, coba 0.35–0.7.
				</p>
			</label>

			{#if isLocal}
				<label class="block">
					<div class="mb-1.5 flex items-baseline justify-between text-xs text-slate-700">
						<span>Top P</span>
						<input
							type="number"
							aria-label="Top P value"
							min={LOCAL_LIMITS.topP.min}
							max={LOCAL_LIMITS.topP.max}
							step={LOCAL_LIMITS.topP.step}
							value={$params.topP}
							on:change={(event) => setParam('topP', event.currentTarget.value)}
							class="w-16 rounded border border-slate-200 px-1 py-0.5 text-right text-[11px]"
						/>
					</div>
					<input
						type="range"
						aria-label="Top P"
						min={LOCAL_LIMITS.topP.min}
						max={LOCAL_LIMITS.topP.max}
						step={LOCAL_LIMITS.topP.step}
						bind:value={$params.topP}
						class="w-full accent-emerald-600"
					/>
					<p class="mt-1 text-[10px] leading-4 text-slate-500">
						Membatasi kandidat token berdasarkan probabilitas kumulatif. 0.8–0.95 biasanya stabil.
					</p>
				</label>

				<label class="block">
					<div class="mb-1.5 flex items-baseline justify-between text-xs text-slate-700">
						<span>Top K</span>
						<input
							type="number"
							aria-label="Top K value"
							min={LOCAL_LIMITS.topK.min}
							max={LOCAL_LIMITS.topK.max}
							step={LOCAL_LIMITS.topK.step}
							value={$params.topK}
							on:change={(event) => setParam('topK', event.currentTarget.value)}
							class="w-16 rounded border border-slate-200 px-1 py-0.5 text-right text-[11px]"
						/>
					</div>
					<input
						type="range"
						aria-label="Top K"
						min={LOCAL_LIMITS.topK.min}
						max={LOCAL_LIMITS.topK.max}
						step={LOCAL_LIMITS.topK.step}
						bind:value={$params.topK}
						class="w-full accent-emerald-600"
					/>
					<p class="mt-1 text-[10px] leading-4 text-slate-500">
						Jumlah kandidat token teratas. 0 = nonaktif; 30–60 sering membantu model kecil.
					</p>
				</label>

				<label class="block">
					<div class="mb-1.5 flex items-baseline justify-between text-xs text-slate-700">
						<span>Repeat Penalty</span>
						<input
							type="number"
							aria-label="Repeat Penalty value"
							min={LOCAL_LIMITS.repeatPenalty.min}
							max={LOCAL_LIMITS.repeatPenalty.max}
							step={LOCAL_LIMITS.repeatPenalty.step}
							value={$params.repeatPenalty}
							on:change={(event) => setParam('repeatPenalty', event.currentTarget.value)}
							class="w-16 rounded border border-slate-200 px-1 py-0.5 text-right text-[11px]"
						/>
					</div>
					<input
						type="range"
						aria-label="Repeat Penalty"
						min={LOCAL_LIMITS.repeatPenalty.min}
						max={LOCAL_LIMITS.repeatPenalty.max}
						step={LOCAL_LIMITS.repeatPenalty.step}
						bind:value={$params.repeatPenalty}
						class="w-full accent-emerald-600"
					/>
					<p class="mt-1 text-[10px] leading-4 text-slate-500">
						Menurunkan peluang token yang sudah muncul. 1 = netral; 1.15–1.25 untuk mengurangi loop.
					</p>
				</label>

				<label class="block">
					<div class="mb-1.5 flex items-baseline justify-between text-xs text-slate-700">
						<span>Frequency Penalty</span>
						<input
							type="number"
							aria-label="Frequency Penalty value"
							min={LOCAL_LIMITS.frequencyPenalty.min}
							max={LOCAL_LIMITS.frequencyPenalty.max}
							step={LOCAL_LIMITS.frequencyPenalty.step}
							value={$params.frequencyPenalty}
							on:change={(event) => setParam('frequencyPenalty', event.currentTarget.value)}
							class="w-16 rounded border border-slate-200 px-1 py-0.5 text-right text-[11px]"
						/>
					</div>
					<input
						type="range"
						aria-label="Frequency Penalty"
						min={LOCAL_LIMITS.frequencyPenalty.min}
						max={LOCAL_LIMITS.frequencyPenalty.max}
						step={LOCAL_LIMITS.frequencyPenalty.step}
						bind:value={$params.frequencyPenalty}
						class="w-full accent-emerald-600"
					/>
					<p class="mt-1 text-[10px] leading-4 text-slate-500">
						Penalti berdasarkan seberapa sering token muncul. 0 = netral; 0.2–0.4 membantu variasi.
					</p>
				</label>
			{/if}

			<label class="block">
				<span class="mb-1.5 block text-xs text-slate-700">Max Tokens Generated</span>
				<input
					type="number"
					min={0}
					max={model?.maxTokensLimit || undefined}
					bind:value={$params.maxTokens}
					class="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-slate-800 focus:border-slate-400 focus:outline-none"
				/>
				{#if isLocal}
					<span class="mt-1 block text-[10px] leading-4 text-slate-500">
						0 = otomatis (256). Maksimum 512 token per jawaban.
					</span>
				{/if}
			</label>

			<label class="block">
				<span class="mb-1.5 block text-xs text-slate-700">Messages context limit</span>
				<input
					type="number"
					min={0}
					bind:value={$params.messagesContextLimit}
					class="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-slate-800 focus:border-slate-400 focus:outline-none"
				/>
				<span class="mt-1 block text-[10px] leading-4 text-slate-500">
					0 = semua pesan. Untuk model lokal, riwayat panjang dapat melebihi konteks 2.048 token.
				</span>
			</label>
		</div>
	</div>

	<div class="border-t border-slate-200 p-3">
		<button
			type="button"
			class="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
			on:click={reset}
		>
			Reset ke default
		</button>
	</div>
</aside>
