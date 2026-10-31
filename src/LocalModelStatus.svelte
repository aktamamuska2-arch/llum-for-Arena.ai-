<script>
	import { onMount } from 'svelte';
	import { createEventDispatcher } from 'svelte';
	import Icon from './Icon.svelte';
	import { feCpu, feRefreshCw } from './feather.js';

	export let compact = false;
	const dispatch = createEventDispatcher();
	let health = null;
	let state = 'loading';
	let timer;
	let disposed = false;
	let controller;

	async function check() {
		if (disposed) return;
		controller?.abort();
		controller = new AbortController();
		const current = controller;
		try {
			const response = await fetch('/local-api/health', {
				cache: 'no-store',
				signal: current.signal,
			});
			if (!response.ok) throw new Error('Model unavailable');
			const result = await response.json();
			if (result.status !== 'ready') throw new Error('Model not ready');
			if (!disposed) {
				health = result;
				state = 'ready';
			}
		} catch {
			if (!disposed && !current.signal.aborted) state = 'offline';
		}
	}
	onMount(() => {
		check();
		timer = setInterval(check, 15000);
		return () => {
			disposed = true;
			clearInterval(timer);
			controller?.abort();
		};
	});
	const examples = [
		'Explain what a CPU does in two short sentences.',
		'Write a short poem about the moon.',
		'Give me three ideas for a weekend project.',
	];
</script>

<section
	class="mx-auto w-full max-w-[660px] shrink-0 px-5 {compact ? 'py-2' : 'pb-5 pt-5 sm:pt-14'}"
	aria-label="Status model lokal"
>
	{#if !compact}
		<div
			class="mb-5 hidden h-12 w-12 items-center justify-center rounded-2xl border border-emerald-200 bg-emerald-50 text-emerald-700 sm:flex"
		>
			<Icon icon={feCpu} class="h-6 w-6" />
		</div>
		<p class="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
			llum / local playground
		</p>
		<h1
			class="mb-3 text-[28px] font-semibold leading-tight tracking-tight text-slate-800 sm:text-4xl"
		>
			Model kecil. Berjalan di sini.
		</h1>
		<p class="max-w-[530px] text-sm leading-6 text-slate-500">
			Chat dengan SmolLM2 langsung dari CPU sandbox. Tanpa API key, tanpa mengirim prompt ke layanan
			AI cloud.
		</p>
	{/if}
	<div
		class="{compact
			? ''
			: 'mt-4 sm:mt-6'} flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs"
	>
		<span class="flex items-center gap-2 font-medium text-slate-700" role="status">
			<span
				class="h-2 w-2 rounded-full {state === 'ready'
					? 'bg-emerald-500'
					: state === 'offline'
						? 'bg-red-500'
						: 'animate-pulse bg-amber-400'}"
			></span>
			{state === 'ready'
				? 'Model siap'
				: state === 'offline'
					? 'Model belum terhubung'
					: 'Memeriksa model…'}
		</span>
		<span class="text-slate-500">135M parameter · Q4_1 · 98 MB · CPU</span>
		{#if state === 'offline'}
			<button
				class="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-slate-700 hover:bg-slate-200"
				on:click={check}
			>
				<Icon icon={feRefreshCw} class="h-3 w-3" /> Coba lagi
			</button>
		{/if}
	</div>
	{#if !compact}
		<div class="mt-3 grid gap-2 sm:mt-5 sm:grid-cols-3">
			{#each examples as example, index}
				<button
					class="{index === 2
						? 'hidden sm:block'
						: ''} rounded-xl border border-slate-200 p-3 text-left text-xs leading-5 text-slate-600 transition-colors hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
					disabled={state !== 'ready'}
					on:click={() => dispatch('example', example)}
					>{example}<span class="mt-2 block font-medium text-emerald-700">Coba prompt ↗</span
					></button
				>
			{/each}
		</div>
		<p class="mt-3 text-[11px] leading-4 text-slate-500 sm:mt-5 sm:text-xs sm:leading-5">
			<strong class="font-medium text-slate-600">Eksperimen ringan, bukan model besar.</strong>
			Paling baik untuk teks pendek berbahasa Inggris; bahasa Indonesia bisa kurang akurat. Tanpa gambar,
			tool calling, atau akses web. Konteks {health?.contextTokens?.toLocaleString('id-ID') ||
				'2.048'} token. Jangan gunakan jawaban sebagai sumber fakta penting.
		</p>
	{/if}
</section>
