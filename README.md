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

<video src="https://github.com/majortom-39/debatly/raw/main/docs/demo.mp4" controls width="100%"></video>

> If the player doesn't load above, **[▶ watch the demo here](https://github.com/majortom-39/debatly/raw/main/docs/demo.mp4)**.

---

## ✨ What it does

- **🎙️ Live capture** — Streams your microphone to the server over a WebSocket and transcribes it in real time with speaker diarization, so you can see who said what as the debate happens.
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
flowchart TD
    U["🎙️ Browser<br/>live mic · file upload · video URL"]
    API["⚙️ Node · Express · ws"]
    SM["Speechmatics<br/>realtime STT — live"]
    PY["pyannote.ai<br/>batch diarize + transcribe — upload / URL"]
    DB[("🗄️ Supabase · Postgres")]
    UI["🖥️ Live Debate Desk<br/>+ Post-debate Report"]

    U -->|"audio over WebSocket · file · link"| API
    API -->|live| SM
    API -->|"upload / URL"| PY
    SM --> P
    PY --> P

    subgraph P["🧠 Clean node pipeline"]
        direction TB
        SB["Side Builder<br/>assigns speakers to sides"]
        DP["Debate-Point Builder<br/>groups arguments into themes"]
        CB["Claim Builder<br/>extracts checkable claims"]
        FC["Fact Checker<br/>Firecrawl search, Gemini verdict"]
        IW["Inconsistency Watch<br/>self-contradictions, double standards"]
        SE["Scoring Engine<br/>deterministic credibility score"]
        SB --> DP --> CB --> FC --> IW --> SE
    end

    P --> DB
    P --> UI
    DB <--> UI
```

---

## 🧩 Tech stack

| Layer | Tools |
|---|---|
| **Frontend** | React + TypeScript, Vite, Recharts (charts), Lucide (icons), jsPDF (native PDF export) |
| **Backend** | Node.js, Express, `ws` (WebSocket), Zod |
| **Realtime STT** | Speechmatics (live transcription + diarization) |
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

Debatly runs on a **GCP Compute Engine VM** with **Caddy** as a reverse proxy that handles automatic HTTPS, serves the built frontend, and proxies `/api` + `/live` to the Node server. A VM (rather than a serverless platform) is used deliberately so a single live debate can run for hours without the connection being cut. Persistence uses Supabase's IPv4 connection pooler.

---

## ⚠️ Known limitations

- **Live diarization isn't accurate yet.** Live capture uses Speechmatics realtime STT, and on a single shared mic with several speakers (e.g. a one‑vs‑many debate) it frequently merges or swaps speakers. Live transcription is reliable; live *speaker attribution* is best-effort.
- **For accurate speakers, use Upload / paste a link.** The import path runs **batch diarization + transcription via pyannote.ai**, which is **ultra-accurate** at separating speakers — far better than the live path. If speaker accuracy matters, import a recording rather than capturing live.
- **No good live pyannote (yet).** pyannote's *streaming* diarization is still in beta and not yet reliable, which is why live uses Speechmatics; pyannote is used only for the (non-live) batch path.
- **Audio quality matters.** Close mic placement, low background noise, and minimal reverb noticeably improve live results.

---

## 🔒 A note on privacy & keys

- All API keys live in `.env` and stay server-side. The browser never receives Google, Speechmatics, Firecrawl, or database credentials.

---

<div align="center">
<sub>Built with care. Debatly presents the facts and its reading — you decide who came out ahead.</sub>
</div>
