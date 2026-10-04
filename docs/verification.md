# Verification record

## Anonymous public release — 4 October 2026

The new public architecture removes visitor sign-in, subscriptions, local launchers and model downloads from the entry flow. Its frontend calls `/api/nexus` for status, chat and recorded-audio transcription. The owner deployment supplies Gateway identity and allowance. Session-only constellation memory and explicit saving consent remain part of the acceptance contract.

**This is not yet a verified live public AI release.** The current release blockers are:

| Gate | Observed state |
| --- | --- |
| New repository hosting access | Vercel's connected project-creation tool rejected `dream-unity/start-fresh` with `repo_no_access`; its GitHub installation needs repository access. The CLI was not signed in. |
| Usable model allowance | Gateway dashboard showed $0. A displayed $5 credit offer required new card verification and was not activated; selected-model eligibility was not established. |
| Public backend deployment | Direct deployment `dpl_6BmSaA9n7EAqKzuz6oAhYHAzg8m2` was built, claimed into the owner’s new `start-fresh` project, and made public. Frontend HTTP 200 and backend configuration-required HTTP 503 observed. Deployment identity needs reconfiguration/redeployment; successful inference is still unverified. |
| Actual GPT response | No completed real owner-funded public chat has been verified. |
| Actual voice turn | No physical microphone recording, live transcription and audible reply have been verified together. |

The anonymous public implementation passes **227 automated tests** and the static build locally. These cover public request contracts, strict model output, accepted-note context, raw audio upload, cancellation, origin checks, error redaction, and recorder lifecycle. Chromium CI results will be attached to the published source revision. Historical test counts below do not certify changed public code. Mock provider responses prove application contracts only; they cannot prove allowance, provider entitlement or microphone hardware.

## Required release checks

1. Deploy the new project with Node.js 24, static build output and its Node API function, using the owner's enabled OIDC/Gateway connection and project spending controls.
2. Check `/api/nexus?op=status`. A configured response means a deployment token is available; it does **not** prove positive credits or a successful provider request.
3. In a private/signed-out browser, open the site without supplying any account or credentials. Complete an actual typed reply, then a correction that changes the meaning or intended region. Check that GPT completion, scene movement and proposal handling agree.
4. On real desktop and mobile hardware, record speech, send manually, finish by silence and reach the recording time limit. Verify the actual transcript and audible reply. Confirm permission denial and unsupported capture leave text usable.
5. Pause during recording, transcription and reply generation, and hide the page during capture. Verify microphone tracks stop, delayed results are discarded and no cancelled turn reopens listening.
6. Keep a proposed note, reject another, reload in session-only mode, explicitly enable/restore device notes and turn saving off. Check archive/recovery/export/delete and storage failure behavior.
7. Exercise provider unavailable, insufficient allowance, rate limit, invalid input and malformed output paths. Ensure safe messages, no secrets in responses and no automatic retry or billing fallback.
8. If GitHub Pages remains the frontend, set `PUBLIC_API_BASE` only to the verified backend and repeat the anonymous cross-origin chat/audio checks from the published Pages URL.

Real public checks must record their source revision, URL and outcome. A status-only response, screenshot of the scene, or passing fixture is insufficient evidence of a completed release.

## Historical local-subscription evidence

The preceding local ChatGPT OAuth revision had **165 passing unit/security tests**, a passing static build and syntax checks. OpenAI's public OIDC discovery metadata was reachable; this was not an account sign-in. Chromium acceptance [passed for revision `856fd2f`](https://github.com/dream-unity/start-fresh/actions/runs/37178305707), with OAuth, speech and GPT replies explicitly simulated while real WebGL and interaction flows were exercised.

That implementation did **not** verify a real ChatGPT account grant or inference, and requiring visitor sign-in did not meet the anonymous public product requirement. Those results remain historical evidence, not proof of the replacement public backend.

## Preserved local-model evidence

At revision `4baf123ab24c20463d2a9569937969cc8cb48d33`, real Ollama `qwen2.5:1.5b` returned valid structured JSON but selected World for a possibility-oriented case expected to select Machine. This is a **failed semantic check**. The strict smoke test remains available through `npm run test:inference` or the manual workflow's `verify_ollama` option; it is not presented as successful primary GPT verification.

## Scope and evidence storage

Source changes are confined to `dream-unity/start-fresh`. The GitHub Pages copy is static until a verified backend origin is configured. No existing Dream Unity production site or domain is part of this release, and God's Earth View is excluded.

Workflow artifacts and the `verification-evidence` branch retain revision-specific reports/screenshots where produced. Automated browser speech, recording or model fixtures must remain labelled as simulations in those reports.
