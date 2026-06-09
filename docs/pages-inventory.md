# Page Inventory

## Current Pages

- `DockerNetworks.page`
  - Route: `Docker/DockerNetworks`.
  - Purpose: primary network management UI when `MENU_LOCATION=Docker` (`Menu="Docker:2"`, `Type="php"`, `Nchan="docker_load"`).
  - Pattern: stub page loading CSS/JS + include fragment.
- `DockerNetworksTools.page`
  - Route: `Tools/DockerNetworks`.
  - Purpose: same network manager UI when `MENU_LOCATION=Tools`.
- `Networks.page`
  - Route: `Networks`.
  - Purpose: same network manager UI when `MENU_LOCATION=Tab` as its own top-level tab.
- `docker.networks.settings.page`
  - Route: `Settings/docker.networks.settings`.
  - Purpose: plugin settings for menu location preference.
- `DockerNetwork-Dashboard.page`
  - Route: dashboard tile.
  - Purpose: quick visibility and launch link (route follows menu location setting).
  - Pattern: stub page loading include fragment.

## Supporting UI Files (Now Split)

- `include/DockerNetworksPage.php`
- `include/DockerNetworkDashboard.php`
- `include/Exec.php` (request entrypoint)
- `include/ExecFunctions.php` (testable action handlers)
- `javascript/dockerNetworksPage.js`
- `sheets/DockerNetworks.css`

## Proposed Next Pages

- `DockerNetworksDiagnostics.page` (optional)
  - Route candidate: `Tools/DockerNetworksDiagnostics`
  - Purpose: quick diagnostics/log viewer for API and network state.

## Open Design Decisions

- Single page with dynamic menu location vs separate page files for Docker and Tools.
- Whether dashboard tile should show quick counts (custom networks, attached containers).
- Whether settings should include safe-guard toggles for destructive operations.
