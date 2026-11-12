# extension

`index.ts` is the Pi extension that `package.json` registers under `pi.extensions`. It adds the `/factory` command, which reads controller state and admits tickets through `src/`. `test/extension.test.ts` tests it.

The published package ships `extension/`, `src/` and `skills/`, not `server/`. Keep this folder to the extension entry point, and keep its logic in `src/`.
