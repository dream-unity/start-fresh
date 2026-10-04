# Conversation runtime

The new experience uses an actual generative model. It does not turn dictation into a scripted answer, silently call a paid API, or depend on a deployed Vercel backend. Model selection and initial download must be explicit user actions.

## Browser AI

`src/model.js` pins `@mlc-ai/web-llm` to **0.2.85**, verified against the project's published release and npm package on 4 October 2026. It imports the release from jsDelivr and runs inference in a module Web Worker, leaving the scene's main thread available for animation and controls.

The selected model is **Qwen2.5-1.5B-Instruct**, quantized to 4 bits. The `q4f16_1` variant is used where the adapter advertises `shader-f16`; otherwise it selects `q4f32_1`. Both exact model IDs are in the pinned WebLLM registry. The registry estimates 1,630 MB and 1,889 MB of graphics memory respectively. Allow roughly 2 GB of free graphics memory and approximately 1 GB for the initial model download; actual resource use varies with device and runtime. The upstream Qwen model is Apache-2.0 licensed.

The runtime checks WebGPU before starting that download, reports real initialization progress, and surfaces compatibility, memory, network and worker failures. Cached weights can reduce later downloads; cached weights alone do not guarantee the whole application works offline. An unsupported device remains unsupported until the person selects another runtime. There is no background polling that repeatedly switches voice availability.

The model computes text on the device. Downloads contact jsDelivr, Hugging Face and the model-library origin declared in WebLLM. This is **not** a blanket claim that microphone audio stays on the device: browser speech recognition is a separate capability and may use the browser vendor's service. Speech input, model inference and speech playback must be described separately in the interface.

## Local AI

The second adapter talks to this project's own same-origin server. The server can connect to an Ollama model running on the user's computer without a paid model API. The browser adapter never probes arbitrary LAN addresses, accepts remote API keys, or silently switches to this provider.

The contract is:

| Request | Response |
| --- | --- |
| `GET /api/health` | JSON `{ "ready": true, "model": "installed-model-name" }`; non-ready responses may include a helpful `message`. |
| `POST /api/chat` with `{ "messages": [...] }` | Ollama-style newline-delimited JSON containing `message.content` deltas and a final `{ "done": true }`. The server owns streaming and model options. |

The server selects the model and applies its own limits; the browser does not supply an arbitrary upstream URL. A stream that closes without its final marker is an error, not a completed answer. Loading this static site on GitHub Pages does not create a local server: the local option requires running the project server and Ollama on the same computer.

## Application integration

```js
const model = new ConversationModel();
await model.initialize({ provider: 'browser', onProgress });
const result = await model.reply({ messages, signal, onToken });
model.interrupt(); // Stop the active answer, or cancel initialization.
model.dispose();   // Close this instance and terminate its worker.
```

`onToken(delta, accumulatedText)` receives raw generated text. The response ends with a navigation suggestion:

```text
Let us look at the possibilities you have not yet tested.
<navigation>{"region":"machine","focus":"Untested possibilities","memory":null}</navigation>
```

Regions are `machine`, `maker`, `world` and `unity`. An optional memory is `{ "kind": "goal|insight|tension|project", "text": "..." }`. The app must strip the marker before displaying or speaking, validate its fields, and require explicit approval before saving a memory. Model text is untrusted content, never HTML or executable code. A malformed suggestion must not invent a diagnosis, force a scene transition, or become a saved fact.

The canonical system prompt grounds replies in the three worlds, revisable interpretations, practical agency and the possibility-to-revision loop. The adapter retains recent conversation within a bounded context, not unlimited autobiographical memory. Approved constellation notes may be supplied as bounded application context. The small model can still misunderstand or hallucinate: this implementation does not promise frontier-model reasoning or perfect semantic routing.

Only one generation can run at a time. Cancellation calls WebLLM's `interruptGenerate()` and continues consuming its stopped stream without forwarding more tokens, releasing its generation lock before another turn. Worker termination settles waiting callers, and inactivity timeouts turn a stalled operation into a recoverable error. The app owns whether and when listening resumes.

## Verification boundary

Adapter fixtures verify UTF-8 stream splitting, incomplete stream rejection, canonical context, interruption without late tokens, a following turn after interruption, disposal and unavailable WebGPU. These fixtures are **not evidence of actual model quality, GPU compatibility, or a successful live microphone session**. A release should separately exercise a real downloaded browser model and/or a real local model, then check the complete spoken turn on a supported device.

## Primary references

- [WebLLM v0.2.85 release](https://github.com/mlc-ai/web-llm/releases/tag/v0.2.85)
- [WebLLM initialization and streaming](https://webllm.mlc.ai/docs/user/basic_usage.html)
- [WebLLM worker API](https://webllm.mlc.ai/docs/user/advanced_usage.html)
- [Pinned model registry](https://github.com/mlc-ai/web-llm/blob/v0.2.85/src/config.ts)
- [Pinned engine cancellation and stream implementation](https://github.com/mlc-ai/web-llm/blob/v0.2.85/src/engine.ts)
- [Qwen model card and license](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct)
- [Ollama chat protocol](https://docs.ollama.com/api/chat)
