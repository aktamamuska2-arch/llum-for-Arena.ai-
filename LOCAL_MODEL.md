# llum — model open-source lokal

Repositori asal **llum adalah antarmuka chat, bukan model AI**. Integrasi ini menambahkan model sungguhan, mesin inferensi CPU, dan gateway satu origin supaya llum dapat berjalan tanpa layanan AI berbayar.

## Yang berjalan

- **Model:** HuggingFaceTB SmolLM2-135M-Instruct.
- **Bobot:** GGUF Q4_1, 98.362.432 byte (sekitar 94 MiB).
- **Mesin:** llama.cpp melalui `llama-cpp-python` 0.3.16.
- **Perangkat:** CPU, dua thread; tidak membutuhkan GPU/CUDA.
- **Konteks:** 2.048 token. Jawaban default 256 token, maksimum 512.
- **UI:** build produksi Svelte/Vite dari repositori ini, termasuk panel parameter generasi.
- **Anti-pengulangan:** instruksi sistem keras, penalti sampling, dan penjeda streaming di gateway.
- **Alamat lokal:** `http://localhost:5173`.
- **API browser:** `/local-api/v1/chat/completions`, dengan streaming SSE.

Model kecil ini merupakan demo inferensi ringan, **bukan pengganti model besar**. Jawaban bahasa Inggris pendek adalah penggunaan yang paling sesuai. Bahasa Indonesia, matematika, coding, dan fakta spesifik sering kurang akurat. Tidak ada tool calling, input gambar, atau pencarian web untuk model lokal. Periksa jawaban penting secara mandiri.

## Menjalankan di sandbox Arena

Server sudah disiapkan dan dijalankan melalui proses bernama **llum · Local AI**. Buka panel **Live Preview** di Arena, bukan alamat localhost komputer Anda: localhost di sini merujuk pada sandbox yang berbeda dari perangkat Anda.

Tidak perlu memasukkan API key. Model lokal dipilih otomatis. Klik salah satu contoh prompt, lalu kirim. Tombol berhenti membatalkan permintaan browser; riwayat tersimpan di IndexedDB browser.

Server hanya aktif selama sandbox/proses berjalan. Jika sandbox dihentikan atau di-reset, siapkan kembali dengan perintah di bawah. Gunakan kontrol Stop pada proses live preview untuk menghentikannya. Live preview adalah lingkungan demonstrasi, bukan deployment produksi dengan autentikasi pengguna.

## Instalasi ulang

Target setup yang diuji: **Linux x86_64, Python 3.11, Node.js 22**. Diperlukan compiler C/C++, Python venv, dan koneksi ke GitHub/API GitHub serta PyPI. Pembangunan CPU pertama dapat memakan beberapa menit.

Dari root repositori:

```bash
npm ci
npm run setup:local
npm run local
```

`setup:local`:

1. Membuat virtual environment terisolasi di `.runtime/venv`.
2. Membangun llama.cpp dari distribusi sumber yang dipin, tanpa CUDA atau libcurl.
3. Mengunduh bobot dari blob Git yang dipin pada repositori publik `simonw/llm-smollm2`.
4. Memverifikasi ukuran dan SHA-256 sebelum menggunakan bobot.
5. Menyimpan bobot dan lisensinya di `.runtime/models`.

`local` membangun UI, memuat model, menunggu health check, kemudian menjalankan gateway. Gateway mengikat `0.0.0.0:5173` agar live preview berfungsi. Mesin Python hanya mendengarkan `127.0.0.1:8080` dan memakai token acak yang dibuat saat startup; token itu tidak dikirim ke browser atau disimpan di Git.

Untuk menghentikan server yang dijalankan di terminal, tekan **Ctrl+C**. Gateway meneruskan penghentian ke proses model.

Bobot, virtual environment, dan hasil pengujian berada di `.runtime/` yang diabaikan Git. Jangan menghapus folder tersebut jika ingin menjalankan ulang tanpa instalasi kembali. Folder ini bukan penyimpanan permanen jika sandbox di-reset.

### Port lain

```bash
PORT=3000 LOCAL_MODEL_PORT=8082 npm run local
```

Gunakan dua port berbeda antara 1024 dan 65535. Jangan mengekspos port mesin Python secara langsung; buka port gateway saja.

## Arsitektur

```text
Browser / Live Preview Arena
          |
          | URL relatif, origin yang sama
          v
Gateway Node.js :5173
  ├── file produksi llum dari dist/
  └── /local-api/* ──> API Python loopback :8080
                         └── llama.cpp ──> bobot GGUF di .runtime/models
```

Gateway hanya meneruskan health, daftar model, dan chat. Ia tidak meneruskan kredensial buatan browser, tidak menyediakan akses file bobot, dan membatasi satu generasi aktif. Ukuran request dibatasi 32 KiB; waktu generasi dibatasi 120 detik. Parameter gambar/tools ditolak dengan pesan yang jelas. Permintaan browser lintas situs ditolak.

Endpoint backend yang tidak diperlukan, termasuk dokumentasi interaktif dan utilitas tokenisasi, tidak tersedia melalui gateway. Log akses dan pencatatan prompt oleh gateway dinonaktifkan.

Provider cloud llum yang lama tetap ada dan memerlukan API key yang Anda masukkan sendiri. Jangan mengaktifkan sinkronisasi pihak ketiga jika menginginkan seluruh riwayat tetap lokal. Tombol share untuk percakapan lokal membuat URL berisi data percakapan, **bukan** mengunggahnya ke pemendek URL lama; siapa pun yang menerima URL itu dapat membaca isinya.

Aset KaTeX sekarang dibundel lokal. Pada pengujian browser default, tidak ada permintaan jaringan eksternal saat membuka UI dan melakukan chat lokal.

## Parameter generasi dan anti-pengulangan

Buka ikon **parameter generasi** di kanan atas. Untuk model lokal tersedia:

| Parameter         | Default | Rentang | Fungsi singkat                                               |
| ----------------- | ------: | ------: | ------------------------------------------------------------ |
| Temperature       |    0.65 |     0–2 | Rendah lebih fokus, tinggi lebih bervariasi.                 |
| Top P             |    0.90 |     0–1 | Membatasi kandidat token berdasarkan probabilitas kumulatif. |
| Top K             |      40 |   0–200 | Membatasi jumlah kandidat token teratas; 0 menonaktifkan.    |
| Repeat Penalty    |    1.15 |     1–2 | Menurunkan peluang token yang sudah muncul.                  |
| Frequency Penalty |    0.25 |     0–1 | Penalti berdasarkan frekuensi token.                         |

Preset **Fokus**, **Seimbang**, dan **Kreatif** mengubah kelima parameter sekaligus. Pengaturan disimpan di browser dan dipakai untuk permintaan berikutnya. Tombol **Reset ke default** mengembalikan nilai awal.

Model 135M mudah terjebak loop, terutama pada roleplay/dialog panjang. Karena itu perlindungan ini tidak hanya mengandalkan prompt:

1. **Instruksi keras:** backend menambahkan aturan ke pesan sistem pertama: jawab sekali, jangan mengulang kalimat/frasa, jangan meneruskan giliran user, lalu berhenti.
2. **Penalti sampling:** `repeat_penalty` dan `frequency_penalty` diteruskan ke llama.cpp, dengan jendela penalti 128 token terakhir.
3. **Penjeda streaming:** gateway memantau teks yang keluar. Jika kalimat/baris yang sama muncul tiga kali, n-gram 8 kata berulang, atau ada run token/karakter panjang, gateway menghentikan upstream, mengirim `finish_reason: "stop"`, dan menampilkan pemberitahuan. Ekor teks ditahan sebentar agar pengulangan ketiga tidak sempat terkirim ke browser.

Penjeda ini bisa dimatikan lewat checkbox **Hentikan pengulangan otomatis** atau field API `anti_repetition: false`. Matikan hanya jika memang membutuhkan refrain/pengulangan sengaja; risiko loop kembali lebih besar. Ini bukan filter konten dan tidak memblokir topik tertentu. Untuk menguji, tidak perlu mengirim log vulgar; cukup prompt netral yang sengaja mengulang kalimat.

Jika masih berulang: pakai preset **Fokus**, naikkan Repeat Penalty ke sekitar 1.2 dan Frequency Penalty ke sekitar 0.3–0.4, pendekkan riwayat, atau mulai chat baru. Menaikkan temperature terlalu tinggi justru dapat membuat model kecil makin tidak stabil.

## Contoh API

Melalui gateway, tanpa API key:

```bash
curl http://localhost:5173/local-api/health

curl http://localhost:5173/local-api/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "smollm2-135m-instruct",
    "messages": [{"role": "user", "content": "Write one short sentence about the moon."}],
    "max_tokens": 64,
    "temperature": 0.35,
    "top_p": 0.8,
    "top_k": 30,
    "repeat_penalty": 1.2,
    "frequency_penalty": 0.35,
    "anti_repetition": true,
    "stream": false
  }'
```

Untuk streaming, gunakan `"stream": true` dan `curl -N`. Format mengikuti chat completions OpenAI, tetapi hanya parameter teks dasar yang didukung. `anti_repetition` adalah ekstensi gateway lokal; field ini tidak diteruskan ke mesin llama.cpp. Jika penjeda menghentikan loop, respons/stream menyertakan `notice` dan tetap berakhir normal dengan `finish_reason: "stop"`. Ini bukan server OpenAI cloud dan tidak mencakup seluruh API OpenAI.

## Pengujian

Dengan server lokal tetap berjalan, jalankan di terminal lain:

```bash
npm run test:local
```

Tes mencakup health/model discovery, file UI, inferensi non-streaming dan streaming nyata, parameter sampling, penjeda pengulangan, migrasi pengaturan browser, parser SSE yang terpotong di tengah UTF-8, validasi input, penolakan lintas situs, serta batas konkurensi. Gunakan `LOCAL_TEST_URL` jika port gateway berbeda.

Pemeriksaan tambahan yang dilakukan saat integrasi:

- Build produksi berhasil.
- Chat browser desktop dan ponsel menghasilkan teks nyata.
- Tidak ada error JavaScript atau permintaan eksternal pada alur lokal default.
- Riwayat bertahan setelah reload.
- Tombol berhenti mengembalikan UI ke keadaan siap.
- Dua belas tes otomatis lulus.
- Proses model menggunakan sekitar 270 MB RSS setelah dimuat pada sandbox pengujian; angka ini dapat berubah.

## Sumber dan lisensi

- Model dasar: [HuggingFaceTB/SmolLM2-135M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct), Apache-2.0.
- Kemasan bobot Q4_1: [simonw/llm-smollm2](https://github.com/simonw/llm-smollm2), commit `afed0963b3a8bcca17c83f451a161eb2edbc59fe`.
- SHA-256 bobot: `b179c9523d0e6a0f98a330c7562b682750a6f8c8c15e5bc70ea373728110db53`.
- Mesin: [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp), MIT; binding [abetlen/llama-cpp-python](https://github.com/abetlen/llama-cpp-python), MIT.
- UI asal: llum oleh zakkor, MIT; lihat `LICENSE`.

Identitas bobot, sumber, dan checksum dicatat di `scripts/local-model.json`. Lisensi Apache bobot diunduh ke `.runtime/models/LICENSE.Apache-2.0.txt`.

## Pemecahan masalah

- **Model belum terhubung:** pastikan proses `npm run local` masih hidup dan menampilkan `llum local is ready`. Klik **Coba lagi** pada UI atau muat ulang halaman.
- **Checksum mismatch:** jangan gunakan file itu; jalankan ulang setup untuk mengunduh bobot yang benar.
- **429:** satu jawaban sedang berjalan. Tunggu atau hentikan dulu.
- **400 / konteks terlalu panjang:** mulai chat baru atau pendekkan pesan. Batas konteks mencakup prompt dan jawaban.
- **Jawaban berhenti sebelum selesai:** batas token tercapai; UI menampilkan pemberitahuan. Naikkan batas sampai maksimal 512 atau minta jawaban lebih pendek.
- **Jawaban berhenti dengan pemberitahuan pengulangan:** penjeda streaming menghentikan loop. Coba preset Fokus, naikkan penalti, pendekkan riwayat, atau mulai chat baru.
- **Masih berulang:** pastikan checkbox anti-pengulangan aktif. Jika sengaja dimatikan, hidupkan kembali. Model 135M tetap dapat menghasilkan teks yang kurang koheren meskipun loop dihentikan.
- **Port sudah dipakai:** pilih `PORT`/`LOCAL_MODEL_PORT` lain.
- **`npm run dev` tidak menemukan model:** perintah itu hanya menjalankan Vite untuk pengembangan UI. Gunakan `npm run local` untuk paket lengkap UI + gateway + model.
- **Setup di macOS/Windows:** setup otomatis ini sengaja menolak platform selain Linux x86_64. Gunakan Linux/WSL2 atau sesuaikan build llama-cpp-python dan path virtual environment secara manual.
