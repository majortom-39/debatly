# debate.ai

Mobile-first web prototype for live debate performance analysis.

## What It Does

- Captures microphone audio in the browser and streams it to a local Node server.
- Uses Google Cloud Speech-to-Text with speaker diarization through Application Default Credentials.
- Uses pyannote as an optional rolling speaker-refinement layer when `HUGGINGFACE_TOKEN` is set.
- Sends finalized transcript turns to Vertex AI Gemini on Vertex for debate analysis.
- Uses Firecrawl Search for source retrieval, then Gemini-lite writes the fact-check verdict from those snippets.
- Groups speakers into debate sides, extracts checkable points, watches for contradictions, and estimates which side is ahead.

## Local Setup

Install dependencies:

```bash
npm install
```

Make sure ADC is available:

```bash
gcloud auth application-default login
```

This prototype is configured for:

```text
GOOGLE_CLOUD_PROJECT=project-edf64ffe-6f3d-4e13-979
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_GENAI_USE_VERTEXAI=true
```

The server intentionally does not load service account JSON files. Google client libraries use your local ADC.

## Speaker Diarization

Google Speech-to-Text provides the live transcript. pyannote can refine speaker labels on rolling audio windows.

Install the optional Python dependencies:

```bash
npm run setup:diarization
```

Then set:

```text
HUGGINGFACE_TOKEN=hf-your-token
```

You must also accept the pyannote model terms on Hugging Face for the configured model. Without a token, live transcription still works, and the UI reports that pyannote speaker refinement is disabled.

## Required Google APIs

Vertex AI is required for grounded Gemini analysis. Speech-to-Text is required for live transcription and diarization.

Check enabled services:

```bash
gcloud services list --enabled --project=project-edf64ffe-6f3d-4e13-979
```

Enable Speech-to-Text if it is not enabled:

```bash
gcloud services enable speech.googleapis.com --project=project-edf64ffe-6f3d-4e13-979
```

## Run

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

## Notes

- Keep `FIRECRAWL_API_KEY` in `.env`; it is ignored by git.
- Optional Firecrawl tuning lives in `FIRECRAWL_SEARCH_TIMEOUT_MS`, `FIRECRAWL_SEARCH_LIMIT`, and `FIRECRAWL_EXCLUDED_DOMAINS`.
- The browser never receives Google credentials or the Firecrawl key.
- Real-time diarization quality depends heavily on microphone placement, background noise, and overlapping speech.
