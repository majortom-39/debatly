<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/debatly-logo-white.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/debatly-logo-black.png">
  <img alt="Debatly" src="docs/debatly-logo-black.png" width="340">
</picture>

### Watch any debate. See who's actually telling the truth.

**Debatly** listens to a live debate (or an uploaded recording), transcribes it with per-speaker labels, fact-checks the claims against the web, tracks contradictions, and turns it all into a clear **credibility score** and a readable post-debate report — no winner declared, just the facts and an honest reading.

<br/>

![React](https://img.shields.io/badge/React-20232a?logo=react&logoColor=61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646cff?logo=vite&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ecf8e?logo=supabase&logoColor=white)
![Google Cloud](https://img.shields.io/badge/Vertex_AI-4285f4?logo=googlecloud&logoColor=white)

</div>

---

## 🎬 Demo

<p align="center">
  <video src="https://github.com/user-attachments/assets/9c60a4b5-516f-4638-8bb3-2f93314d84b9" controls width="80%"></video>
</p>

---

## ✨ What it does

- **🎙️ Live capture** — Streams your mic to the server over a WebSocket. **Words** are transcribed in real time by Speechmatics; **who is speaking** is decided by a **local diarization engine** (Silero VAD + pyannote/wespeaker voice embeddings with persistent speaker profiles). Each transcribed word is matched to a voice fingerprint, so a speaker keeps the same label across the whole debate.
- **📁 Import a recording** — Upload an audio/video file or paste a video URL. Debatly extracts the audio, diarizes and transcribes the whole thing, then runs it through the exact same analysis pipeline as a live debate.
- **🧠 Live Debate Desk** — As people talk, the app builds the board:
  - **Debate points** grouped into themed, collapsible families per side.
  - **Claims & fact-checks** with a verdict (Verified / False / Misleading / Unverified), a one-line reason, and real sources.
  - **Self-contradictions & double standards** caught across the debate.
- **⚖️ Credibility score** — A deterministic score that rewards verified claims and penalizes false/misleading ones and self-contradictions, so volume never beats accuracy. It measures honesty, **not** who talked more or whose opinion you like.
- **📊 Post-debate report** — Generated when the debate ends:
  - A plain-English verdict (**no winner is declared** — you decide).
  - A **score-over-time chart** with markers for when each speaker entered.
  - A **per-speaker breakdown** with stats, a judging note, and a standout quote.
  - Side summaries, turning points (with gained/lost-ground impact), and the scoring methodology.
- **📄 Native PDF export** — Download the whole report as a text-based PDF with vector charts.
- **🔁 Long, uninterrupted sessions** — Built to run for hours without dropping the connection.

---

## 🛠️ How it works

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontFamily":"ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif","fontSize":"14px","lineColor":"#8a847c","clusterBkg":"#0c0a09","clusterBorder":"#2b2724"}}}%%
flowchart TD
    U(["🎙️ Browser — live mic · file · video URL"])
    API["⚙️ Node · Express · WebSocket"]
    U == "audio · file · link" ==> API

    subgraph LIVE["⚡ Live"]
      direction LR
      SM["Speechmatics<br/>realtime words · STT"]
      LD["Local diarizer · Python<br/>Silero VAD + pyannote/wespeaker<br/>online speaker clustering"]
    end

    MERGE{{"Word → speaker merge<br/>persistent labels"}}

    subgraph BATCH["📦 Upload / URL"]
      PY["pyannote.ai<br/>precision-2 diarize + Whisper"]
    end

    API -- "live audio" --> SM
    API -- "live audio" --> LD
    API -- "upload / URL" --> PY
    SM --> MERGE
    LD --> MERGE

    subgraph PIPE["🧠 Analysis pipeline"]
      direction TB
      SB["Side Builder"] --> DP["Debate-Point Builder"] --> CB["Claim Builder"] --> FC["Fact Checker · Firecrawl + Gemini"] --> IW["Inconsistency Watch"] --> SE["Scoring Engine"]
    end

    MERGE ==> SB
    PY ==> SB

    DB[("🗄️ Supabase · Postgres")]
    UI["🖥️ Debate Desk + Report"]
    SE ==> DB
    SE ==> UI
    DB <--> UI

    classDef input fill:#0c0a09,stroke:#5b8aa0,stroke-width:1.5px,color:#f5f5f4
    classDef core fill:#1c1917,stroke:#a8a29e,stroke-width:1.5px,color:#f5f5f4
    classDef live fill:#13212b,stroke:#5b8aa0,stroke-width:1.4px,color:#e8eef2
    classDef batch fill:#241318,stroke:#a4626a,stroke-width:1.4px,color:#f3e8ea
    classDef pipe fill:#1c1917,stroke:#8a8378,stroke-width:1.2px,color:#f1efe9
    classDef store fill:#0e1d17,stroke:#5b8a6f,stroke-width:1.5px,color:#e7f2ec
    classDef ui fill:#1c1917,stroke:#c9a96a,stroke-width:1.5px,color:#f5f5f4

    class U input
    class API,MERGE core
    class SM,LD live
    class PY batch
    class SB,DP,CB,FC,IW,SE pipe
    class DB store
    class UI ui
```

---

## 🧩 Tech stack

| Layer | Tools |
|---|---|
| **Frontend** | React + TypeScript, Vite, Recharts (charts), Lucide (icons), jsPDF (native PDF export) |
| **Backend** | Node.js, Express, `ws` (WebSocket), Zod |
| **Realtime STT (live words)** | Speechmatics realtime transcription |
| **Live diarization** | Local Python worker — Silero VAD + `pyannote/wespeaker` voice embeddings + online clustering with persistent speaker profiles (PyTorch, CPU) |
| **Batch diarize + transcribe** | pyannote.ai `precision-2` + Whisper (for imports) |
| **Reasoning & fact-checks** | Google Vertex AI (Gemini) + Firecrawl web search |
| **Audio / media** | `ffmpeg-static`, `youtube-dl-exec` |
| **Data & auth** | Supabase (Postgres + authentication) |
| **Hosting** | GCP Compute Engine VM + Caddy (automatic HTTPS) |

---

## 🚀 Getting started

### Prerequisites
- **Node.js 20+**
- Accounts/keys for the services you want to use (Vertex AI / Gemini, Speechmatics, Firecrawl, Supabase, pyannote.ai). See **`.env.example`** for the full list.

### 1. Install
```bash
npm install
```

### 2. Configure
Copy the template and fill in your own keys:
```bash
cp .env.example .env
```
> `.env` is gitignored — secrets never get committed, and the browser never receives them.

### 3. Run (dev)
Starts the API + live WebSocket server and the Vite dev server together:
```bash
npm run dev
```
Then open **http://127.0.0.1:5173** (the API runs on `127.0.0.1:8787`).

### Other scripts
| Command | What it does |
|---|---|
| `npm run dev` | Run API + web together (hot reload) |
| `npm run build` | Build the frontend for production |
| `npm run start` | Run the production API/WebSocket server |
| `npm run check` | TypeScript type-check (no emit) |
| `npm run preview` | Preview a production build |

---

## 📁 Project structure

```
.
├── src/              # React + TypeScript frontend (App.tsx, styles, types)
├── server/           # Node API + WebSocket server
│   ├── index.mjs       # HTTP/WS entry point
│   ├── pipeline.mjs    # live analysis pipeline
│   ├── nodes/          # claim builder, fact-checker, scoring engine, report builder, …
│   └── shared/         # STT, audio extraction, db helpers
├── public/           # static assets (logos, favicons)
├── supabase/         # database migrations
├── docs/             # README media
└── .env.example      # all configuration keys (copy to .env)
```

---

## ☁️ Deployment

Debatly runs on a **GCP Compute Engine VM** with **Caddy** as a reverse proxy that handles automatic HTTPS, serves the built frontend, and proxies `/api` + `/live` to the Node server. A VM (rather than a serverless platform) is used deliberately so a single live debate can run for hours without the connection being cut. The Node server spawns the **local diarization worker** (PyTorch) as a child process per live session, so the VM is CPU-sized to run the speaker-embedding model in real time (no GPU required). Persistence uses Supabase's IPv4 connection pooler.

---

## ⚠️ Known limitations

- **Overlapping speech & fast interruptions.** Live diarization decides who is speaking from short rolling audio windows, so when two people talk over each other or hand off rapidly, a speaker change can be detected slightly late — the new speaker's first word or two can land on the previous speaker. Single-microphone audio can't truly separate overlapping voices.
- **Live latency.** Live transcript bubbles lag a couple of seconds behind real speech: the diarization label is given a short delay to settle so the speaker attribution is reliable. Words are buffered per speaker turn and shown when the speaker changes.
- **Live is CPU-bound (concurrency).** Each live debate spawns its own speaker-embedding worker on the server CPU. That comfortably handles a handful of simultaneous debates, but it isn't free — heavy concurrent load needs a bigger machine or a GPU.
- **Uploads are still the most accurate.** The import path runs **batch diarization + transcription via pyannote.ai (`precision-2`) + Whisper**, which has the full recording to work with and is the gold standard for speaker separation. If you need the cleanest possible speaker labels, import a recording rather than capturing live.
- **Audio quality matters.** Close mic placement, low background noise, and minimal reverb noticeably improve live results.

---

## 🔒 A note on privacy & keys

- All API keys live in `.env` and stay server-side. The browser never receives Google, Speechmatics, Firecrawl, or database credentials.

---

<div align="center">
<sub>Built with care. Debatly presents the facts and its reading — you decide who came out ahead.</sub>
</div>
