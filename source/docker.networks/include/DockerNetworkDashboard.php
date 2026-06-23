<?php
require_once __DIR__ . '/Logger.php';
$cfgPath = '/boot/config/plugins/docker.networks/docker.networks.cfg';
$defaultCfgPath = '/usr/local/emhttp/plugins/docker.networks/default.cfg';

function dockerNetworksDashboardCfgBool(array $cfg, string $key, bool $default = false): bool
{
  if (!isset($cfg[$key])) {
    dnLogDebug("Cfg key '{$key}' not found, using default: " . ($default ? 'true' : 'false'), [], 'dashboard');
    return $default;
  }

  $value = strtolower(trim((string)$cfg[$key], " \t\n\r\0\x0B\"'"));
  dnLogDebug("Cfg key '{$key}' found, value: '{$value}'", [], 'dashboard');
  return in_array($value, ['1', 'true', 'yes', 'on', 'enabled'], true);
}

function dockerNetworksDashboardRun(string $command): array
{
  $output = [];
  $exitCode = 0;
  dnLogDebug("Running command: {$command}", [], 'dashboard');
  exec($command . ' 2>&1', $output, $exitCode);

  return [
    'exitCode' => $exitCode,
    'output' => trim(implode("\n", $output)),
  ];
}

function dockerNetworksDashboardIsSystemStyleName(string $name): bool
{
  $name = strtolower(trim($name));
  if ($name === '') {
    dnLogDebug("Network name is empty, not a system-style name", ['name' => $name], 'dashboard');
    return false;
  }

  if (preg_match('/[^a-z0-9]/', $name)) {
    dnLogDebug("Network name '{$name}' contains invalid characters, not a system-style name", ['name' => $name], 'dashboard'); 
    return false;
  }

  dnLogDebug("Network name '{$name}' is a system-style name", ['name' => $name], 'dashboard');
  return (bool)preg_match('/^(?:wg|br|bond|vlan|virbr|docker|podman|tun|tap|zt|tailscale)\d+$/', $name);
}

function dockerNetworksDashboardIsSystemNetwork(array $network): bool
{
  $name = strtolower(trim((string)($network['Name'] ?? '')));
  if ($name !== '' && dockerNetworksDashboardIsSystemStyleName($name)) {
    dnLogDebug("Network '{$name}' is a system network based on its name", ['name' => $name], 'dashboard');
    return true;
  }

  $driver = strtolower(trim((string)($network['Driver'] ?? '')));
  $options = isset($network['Options']) && is_array($network['Options']) ? $network['Options'] : [];
  $parent = trim((string)($options['parent'] ?? ''));
  if ($parent !== '' && in_array($driver, ['macvlan', 'ipvlan'], true)) {
    dnLogDebug("Network '{$name}' is a system network based on its driver and parent", ['name' => $name, 'driver' => $driver, 'parent' => $parent], 'dashboard');
    return true;
  }

  dnLogDebug("Network '{$name}' is not a system network", ['name' => $name, 'driver' => $driver, 'options' => $options], 'dashboard');
  return false;
}

function dockerNetworksDashboardIsDefaultNetwork(array $network): bool
{
  $name = isset($network['Name']) ? strtolower(trim((string)$network['Name'])) : '';
  dnLogDebug("Checking if network '{$name}' is a default network", ['name' => $name], 'dashboard');
  return in_array($name, ['bridge', 'host', 'none'], true);
}

function dockerNetworksDashboardNetworkSummaries(bool $showSystemNetworks = true, bool $showDefaultNetworks = true): array
{
  $listResult = dockerNetworksDashboardRun("docker network ls --format='{{.Name}}'");
  dnLogDebug("Docker network list result", ['exitCode' => $listResult['exitCode'], 'output' => $listResult['output']], 'dashboard');
  if ($listResult['exitCode'] !== 0 || $listResult['output'] === '') {
    return [];
  }

  $summaries = [];
  $names = array_filter(array_map('trim', explode("\n", (string)$listResult['output'])));

  foreach ($names as $name) {
    $inspectResult = dockerNetworksDashboardRun(
      "docker network inspect --format='{{json .}}' " . escapeshellarg((string)$name)
    );

    dnLogDebug(
      "Docker network inspect result for '{$name}'",
      ['exitCode' => $inspectResult['exitCode'], 'output' => $inspectResult['output']],
      'dashboard'
    );

    if ($inspectResult['exitCode'] !== 0) {
      continue;
    }

    $decoded = json_decode((string)$inspectResult['output'], true);
    if (!is_array($decoded)) {
      dnLogDebug(
        "Docker network inspect output for '{$name}' is not valid JSON",
        ['output' => $inspectResult['output']],
        'dashboard'
      );
      continue;
    }

    // With --format='{{json .}}' Docker prints a single object, not an array.
    // Still support array output just in case.
    $network = isset($decoded[0]) ? $decoded[0] : $decoded;

    if (!is_array($network)) {
      dnLogDebug(
        "Docker network inspect output for '{$name}' is not a usable network object",
        ['output' => $inspectResult['output']],
        'dashboard'
      );
      continue;
    }

    if (!$showSystemNetworks && dockerNetworksDashboardIsSystemNetwork($network)) {
      dnLogDebug("Skipping system network '{$name}' because showSystemNetworks is false", ['name' => $name], 'dashboard');
      continue;
    }

    if (!$showDefaultNetworks && dockerNetworksDashboardIsDefaultNetwork($network)) {
      dnLogDebug("Skipping default network '{$name}' because showDefaultNetworks is false", ['name' => $name], 'dashboard');
      continue;
    }

    $containers = isset($network['Containers']) && is_array($network['Containers']) ? $network['Containers'] : [];
    $connections = count($containers);

    dnLogDebug("Network '{$name}' has {$connections} connections", ['name' => $name, 'connections' => $connections], 'dashboard');
    $summaries[] = [
      'name' => (string)($network['Name'] ?? $name),
      'connections' => $connections,
    ];
  }

  usort($summaries, static function (array $a, array $b): int {
    $aConnections = (int)($a['connections'] ?? 0);
    $bConnections = (int)($b['connections'] ?? 0);

    if ($aConnections !== $bConnections) {
      return $bConnections <=> $aConnections;
    }

    return strcasecmp((string)($a['name'] ?? ''), (string)($b['name'] ?? ''));
  });

  dnLogDebug("Final sorted network summaries", ['summaries' => $summaries], 'dashboard');
  return $summaries;
}

$cfg = function_exists('parse_plugin_cfg') ? ((array)(parse_plugin_cfg('docker.networks') ?: [])) : [];

$dashboardTileEnabled = dockerNetworksDashboardCfgBool($cfg, 'DASHBOARD_TILE_ENABLED', true);
if (!$dashboardTileEnabled) {
  dnLogDebug("Dashboard tile is disabled via configuration", ['dashboardTileEnabled' => $dashboardTileEnabled], 'dashboard');
  return;
}

$showSystemNetworks = dockerNetworksDashboardCfgBool($cfg, 'SHOW_SYSTEM_NETWORKS', true);
$showDefaultNetworks = dockerNetworksDashboardCfgBool($cfg, 'SHOW_DEFAULT_NETWORKS', true);

$menuLocation = strtolower(trim((string)($cfg['MENU_LOCATION'] ?? 'docker')));

$openPath = '/Docker';
if ($menuLocation === 'tools') {
  $openPath = '/Tools/DockerNetworks';
} elseif ($menuLocation === 'tab') {
  $openPath = '/Networks';
}
dnLogDebug("Dashboard menu location set", ['menuLocation' => $menuLocation, 'openPath' => $openPath], 'dashboard');

$networkRows = '';
$networkSummaries = dockerNetworksDashboardNetworkSummaries($showSystemNetworks, $showDefaultNetworks);
$totalNetworks = count($networkSummaries);
$activeNetworks = 0;
if ($networkSummaries === []) {
  dnLogDebug("No networks found to display on the dashboard", [], 'dashboard');
  $networkRows = "  <tr class='dn-dash-empty'>\n    <td>\n      <div class='dn-dash-empty-text'>No networks found</div>\n    </td>\n  </tr>\n";
} else {
  foreach ($networkSummaries as $summary) {
    $name = htmlspecialchars((string)($summary['name'] ?? ''), ENT_QUOTES, 'UTF-8');
    $connections = (int)($summary['connections'] ?? 0);
    if ($connections > 0) {
      $activeNetworks++;
    }
    $label = $connections === 1 ? 'connection' : 'connections';
    $networkRows .= "  <tr class='dn-dash-network-row' data-connections='{$connections}'>\n    <td>\n      <div class='dn-dash-network-row-inner'>\n        <div class='dn-dash-network-name' title='{$name}'>{$name}</div>\n        <div class='dn-dash-network-count'>{$connections} {$label}</div>\n      </div>\n    </td>\n  </tr>\n";
  }
  dnLogDebug("Network summaries processed for dashboard", ['totalNetworks' => $totalNetworks, 'activeNetworks' => $activeNetworks], 'dashboard');
}

$mytiles['docker-networks']['column1'] = <<<EOT
<tbody title="Docker Networks">
  <tr>
    <td>
      <div class='tile-header' id='docker-networks-dashboard-card'>
        <div class='tile-header-left'>
          <i class='fa fa-sitemap fa-2x'></i>
          <div class='section'>
            <h3 class='tile-header-main' id='docker-networks-dashboard-title'>Docker Networks</h3>
            <span class='apps button'>
              <input type='checkbox' id='docker-networks-active-only-toggle'>
            </span>
            <br>
          </div>
        </div>
        <div class='tile-header-right-controls'>
          <a id='docker-networks-settings-button' href='/Settings/docker.networks.settings' title='_(Settings)_'><i class='fa fa-fw fa-cog control'></i></a>
          <a id='docker-networks-open-button' href='{$openPath}' title='_(Open)_'><i class='fa fa-fw fa-external-link control'></i></a>
        </div>
      </div>
    </td>
  </tr>
  <tr>
    <td>
      <div class='dn-dash-summary-row'>
        <span><strong>Status</strong> Ready</span>
        <span><strong>Total</strong> {$totalNetworks}</span>
        <span><strong>Active</strong> {$activeNetworks}</span>
      </div>
    </td>
  </tr>
{$networkRows}</tbody>
<style>
  #docker-networks-dashboard-card .section {
    min-width: 0;
  }

  #docker-networks-dashboard-title {
    white-space: nowrap;
  }

  .dn-dash-summary-row {
    display: flex;
    gap: 14px;
    font-size: 0.9em;
    color: var(--alt-text-color);
    padding-top: 2px;
  }

  .dn-dash-summary-row strong {
    color: var(--text-color);
    margin-right: 4px;
    font-weight: 600;
  }

  .dn-dash-network-row td {
    padding: 2px 0;
  }

  .dn-dash-network-row-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 7px 9px;
    border-radius: 4px;
  }

  .dn-dash-network-row-inner:hover {
    background: var(--dynamix-tablesorter-tbody-row-alt-bg-color);
  }

  .dn-dash-network-name {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
  }

  .dn-dash-network-count {
    flex-shrink: 0;
    color: var(--alt-text-color);
    font-size: 0.9em;
  }

  .dn-dash-empty-text {
    color: var(--alt-text-color);
    font-style: italic;
    padding: 7px 9px;
  }
</style>
EOT;
