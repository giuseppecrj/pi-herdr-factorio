# extension

`index.ts` is the Pi extension that `package.json` registers under `pi.extensions`. It adds the `/factory` command. `/factory status` reads the controller's state. `/factory run <issue>` is an admission dry run through `src/`: it records nothing and writes no marker. Only the controller on the VM dispatches runs. `test/extension.test.ts` tests the command.

The published package ships `extension/`, `src/` and `skills/`, not `server/`. Keep this folder to the extension entry point, and keep its logic in `src/`.
