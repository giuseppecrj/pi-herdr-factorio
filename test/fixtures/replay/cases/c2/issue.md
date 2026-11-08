# [F10-A] viewer --port accepts values that are not plain port numbers

`node server/cli.ts viewer --port` should only take a plain decimal port number from 1 to 65535, as the usage line says. Today values like `0x1F90`, `1e4`, `" 8080 "`, `8080.0` and `+8080` are accepted and the viewer tries to start on them. Those should be refused with the usage message and exit code 2, the same as `--port abc` is now. `--port 8080` and `--port 1` must keep working.
Please add a test that checks the accepted and refused values through `runViewerCli`.

