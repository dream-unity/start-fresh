# Dream Unity · Start Fresh

A new implementation of the [original Crystal Nexus brief](https://chatgpt.com/share/6ac05873-6728-83ec-a932-66616dcb794a). This repository is independent of the existing Dream Unity websites.

One continuous crystalline space connects **Dream Machine** (possibility), **Dream Maker** (agency) and **Dream World** (encounter and consequences), through **Unity**. A real conversational model answers your words and proposes movement through the space. The transcript stays at the edge. Personal threads enter your constellation only when you keep them.

## Run it

Install Node.js 22 or newer. No npm dependencies or build step are needed to start the application:

```sh
git clone https://github.com/dream-unity/start-fresh.git
cd start-fresh
npm start
```

Open **http://localhost:4173**. Choose one conversation runtime on first entry:

| Runtime | What it needs | Where conversation text goes |
| --- | --- | --- |
| Browser model | A WebGPU-compatible browser/device, about 1 GB initial model download and roughly 2 GB available graphics memory | Inference runs on your device in a worker. Model files come from public distribution hosts. |
| Local Ollama | [Ollama](https://ollama.com), running on the same computer as this server | To the loopback Ollama process. This app does not send it to a cloud AI provider. |

For the local option, install the model before connecting:

```sh
ollama pull qwen2.5:1.5b
npm start
```

If the Ollama application is not already serving, run `ollama serve` in another terminal. Choose **Connect local model** in the experience. To use another installed model, set `OLLAMA_MODEL` when starting the server. The default is deliberately small enough for ordinary computers; larger compatible instruction models can give stronger answers. No API key, API credits, Vercel account or external database is required.

## Enter the experience

After the model is ready, **Speak to enter** starts the opening invitation, “Tell me why you are here.” The guide listens for a turn, answers, speaks, and then offers the next listening turn. A silence, permission error, service failure, explicit pause or backgrounded page pauses the conversation; it cannot start an endless retry loop. A quiet text field uses the same model and scene.

Try:

- “I do not know what I want to do with my life.”
- “Actually, I know what I want. Starting is the problem.”
- “I tried it, but the people I depend on objected.”
- “How do possibility, action and consequence fit together?”

The guide can propose a region and a memory. Region names are validated against a fixed allowlist; the model cannot execute code, open arbitrary destinations, or save your notes. Invalid navigation leaves the scene unchanged. You can explicitly write or say **“go to Dream Machine”**, **“return to Unity”**, **“show my constellation”**, or **“pause”**.

## Your constellation

The default is **session only**. Notes stay in application memory, including when browser storage is unavailable. You can edit, connect, archive, recover, delete, import and export threads. Remembering on this device requires an explicit setting. A future visit offers **Restore my saved constellation**; saved notes are not silently loaded into a new conversation. Turning device saving off removes this app’s saved copy and keeps the current notes in the session. Browser storage is not encrypted; use session mode on a shared device.

Conversation transcripts are held only in the current page and can be exported. Confirmed, active constellation notes can be supplied to the selected model as context. The application stores no audio recordings. Browser speech recognition may use the browser vendor’s network service; local language-model inference does **not** make browser speech recognition offline. Browser support and permission policies vary. Text remains available when recognition is absent.

## Build and verify

```sh
npm test
npm run build
```

`dist/` contains the independent static application. It can be served from any HTTPS static host, including under a repository subpath. Browser inference works there on compatible devices; the local Ollama option requires `npm start` and is not a cloud backend. Opening `index.html` directly with `file://` is not supported.

The GitHub Actions workflow runs unit/security tests, a Chromium end-to-end suite with **simulated speech and model responses**, and a separate **real Ollama inference** smoke test. Results and screenshots are retained as workflow artifacts; the `verification-evidence` branch carries readable evidence tied to the source commit. Browser-model GPU execution and a physical microphone are distinct from those tests and must be checked on a compatible device. See [acceptance criteria](docs/acceptance.md), [architecture](docs/architecture.md) and [runtime details](docs/model-runtime.md).

The original conversation mentioned historical games and Become without defining their implementation. This build does not claim to ship those unknown experiences. There is no Earth-view application, map embed, or connection to an existing Dream Unity deployment.

## Technical boundaries

The local server listens on `127.0.0.1`, only proxies to loopback Ollama, rejects cross-origin chat requests, bounds request size, cancels upstream generation when the caller leaves, and serves only public app assets. Do not expose it as an unauthenticated public model endpoint. This repository has no service worker or availability polling that can leave an old deployment controlling the interface.

Three.js 0.185.1 is vendored with its MIT licence. WebLLM is pinned to 0.2.85. Model weights retain their respective upstream licences. The small local models can misunderstand an intention; their movement is an interpretation you can correct, never a diagnosis or measured state of mind.
