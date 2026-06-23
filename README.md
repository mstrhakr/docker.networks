# Docker Networks

![GitHub Repo stars](https://img.shields.io/github/stars/mstrhakr/docker.networks)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/mstrhakr/docker.networks/release.yml)
![GitHub Downloads (all assets, latest release)](https://img.shields.io/github/downloads/mstrhakr/docker.networks/latest/total)
![GitHub Closed Issues](https://img.shields.io/github/issues-closed/mstrhakr/docker.networks)
![GitHub Closed Pull Requests](https://img.shields.io/github/issues-pr-closed/mstrhakr/docker.networks)

Manage Docker networks directly from the Unraid web UI.

## Install

### Option 1: Unraid Community Applications

In Unraid, go to **Apps** and search for:

```text
docker networks
```

### Option 2: Unraid Plugin Manager

In Unraid, go to **Plugins → Install Plugin** and paste:

```text
https://raw.githubusercontent.com/mstrhakr/docker.networks/main/docker.networks.plg
```


## Basic Usage

1. Open **Docker → Networks**.
2. Click **Refresh** to load current networks.
3. Click **+ Create Network** to add a new network.
4. Use **Edit** to update network description/metadata.
5. Use **Manage** to connect or disconnect containers.
6. Use **Delete** to remove custom networks.

> Default/system networks (for example `bridge`, `host`, `none`, and parent-interface system networks like `bond0`/`eth0`) are protected and cannot be deleted.

## Troubleshooting

- If the UI looks stale after an update, do a hard refresh: **Ctrl+Shift+R**.
- If network actions fail, ensure Docker is running on Unraid.

## Support

- Issues: [GitHub Issues](https://github.com/mstrhakr/docker.networks/issues)
