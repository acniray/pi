# Native Qoder adapters (Qoder / Qoder CN)

This directory carries the Qoder private wire protocol as an in-tree Pi provider.
It is adapted from [simonsmh/pi-provider-qoder](https://github.com/simonsmh/pi-provider-qoder)
at `14091470f42c4c239daaf7bb78ea3fba2e1efd93` (v0.6.7; MIT license).
Preserve that project's attribution when updating these protocol files.

## Integration boundaries

- `packages/ai/src/providers/all.ts` registers two factories.
- `packages/coding-agent/src/core/model-runtime.ts` skips Pi's pi.dev catalog
  wrapper for these two self-discovering providers.
- All Qoder-only state and protocol code lives below this directory.
- Uses Pi's native `Provider`, `ProviderStreams`, `ApiKeyAuth`,
  `OAuthAuth` and `fetchModels`. There is no extension registration,
  auth.json writer, or replacement agent/session/retry implementation.
- The on-disk `~/.pi/agent/qoder*-models-cache.json` files are retained for
  compatibility with earlier extension installations and for request-level
  catalog metadata. The native Pi model store also persists the model overlay.
- The wire protocol uses the official upstream identifiers `qoder` and
  `qoder-cn` and shares the transport implementation.

## Use

Use `/login` to authenticate the `qoder` or `qoder-cn` provider with a PAT.
Qoder Global also supports browser login. Alternatively set a token in the
same QODER_* or QODERCN_* environment variables supported by the extension.
A `pt-` PAT is exchanged for a `jt-` job token; a direct job token also works
until it expires.

Disable or uninstall the external `pi-provider-qoder` extension while using
the native implementation, otherwise both may try to register the same IDs.

After login, refresh the model catalog through Pi's normal model-refresh
functionality. The static fallback models are available without a network
refresh; dynamic models are account-specific.

## Known boundaries

- The original extension's TUI footer/credit widgets and OMP-only usage
  presentation hooks are **not** part of Pi's native `Provider` interface.
  Request usage and Qoder credit metadata remain in the stream response.
- The Qoder queue classification is carried over from the source: short
  ready/busy responses are retried in the adapter, while real queued responses
  return a retryable queued error to the host. This integration does not claim
  that Pi will preserve a Qoder server-side queue position or wait indefinitely.
- Qoder's upstream protocol is not publicly documented; live testing with
  both Qoder regions is still required before replacing an existing setup.
