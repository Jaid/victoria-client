Maintain readme content in `docs/tldw` and the automatically included `docs/api.md`, `docs/architecture.md` and `docs/notes.md`. Do not edit `readme.md` directly.

`bun tldw` regenerates it.

# validation

`bun run test`, `bun run typecheck` and `bun run lint` check the source. Backend integration tests require explicit disposable backend URLs.

# package builds

Run `bun run build`. The pipeline regenerates the readme, uses Vite/Rolldown to emit complete per-flavor intermediate projects and declarations with the pinned TypeScript compiler, then invokes `build_lib.exe` in precompiled production mode.

| Package | Production directory |
| --- | --- |
| Core | `dist/package/victoria-client/production` |
| Browser | `dist/package/victoria-browser-client/production` |
| Bun | `dist/package/victoria-bun-client/production` |

Intermediates live in `out/intermediate/{package}`. Shared runtime chunks preserve class identity across exported entry points. Their package manifests already contain the complete export map and declaration paths; build_lib preserves those subpath exports while applying its final production optimization and metadata normalization. Nothing is published by the build.

The build requires your `build_lib.exe` command on Windows (`build_lib` elsewhere). `BUILD_LIB_BIN` may name an alternate installed executable. There is no silently different fallback.

Run `bun run test:packages` to build all flavors, pack them, install the tarballs into an isolated temporary consumer and verify public imports, declarations and runtime behavior. Portable/browser declarations are checked without Node or Bun ambient types. The temporary consumer is removed afterward.
