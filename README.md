# docker.networks

Docker Networks manager plugin for Unraid.

This repository now follows the same structure and local workflow style as compose.manager:

- Root plugin manifest: `docker.networks.plg`
- Flat plugin source: `source/docker.networks/`
- Package builder entrypoint: `source/pkg_build.sh`
- Local automation scripts in repo root:
  - `build.sh` / `build.ps1`
  - `test.sh` / `test.ps1`
  - `deploy.sh` / `deploy.ps1`
  - `install.sh`

## Build

```bash
./build.sh
./build.sh -Version 2026.06.09.1234
./build.sh -Dev
```

Artifacts are written to `archive/`.

## Test

```bash
./test.sh
./test.sh -phpstan
./test.sh -phplint
./test.sh -shellcheck
```

## Deploy

```bash
./deploy.sh -RemoteHost 192.168.1.10
./deploy.sh -Dev -RemoteHost 192.168.1.10
./deploy.sh -SkipBuild -RemoteHost 192.168.1.10
./deploy.sh -Quick -RemoteHost 192.168.1.10
```

`-Quick` deploys only tracked changed files under `source/docker.networks/` directly to `/usr/local/emhttp/plugins/docker.networks`.

## Release Channel

This repo is stable-only by design. No beta release channel flow is included.
