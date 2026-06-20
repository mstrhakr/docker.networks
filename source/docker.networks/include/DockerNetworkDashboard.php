<?php
$cardName = 'docker-networks';
$cfgPath = '/boot/config/plugins/docker.networks/docker.networks.cfg';
$defaultCfgPath = '/usr/local/emhttp/plugins/docker.networks/default.cfg';

function dockerNetworksDashboardLoadCfg(string $path): array
{
  $raw = @file_get_contents($path);
  if ($raw === false) {
    return [];
  }

  $sanitized = preg_replace('/^#[^\n]*(\n|$)/m', '', $raw);
  $parsed = @parse_ini_string((string)$sanitized, false, INI_SCANNER_RAW);
  return is_array($parsed) ? $parsed : [];
}

function dockerNetworksDashboardCfgBool(array $cfg, string $key, bool $default = false): bool
{
  if (!isset($cfg[$key])) {
    return $default;
  }

  $value = strtolower(trim((string)$cfg[$key], " \t\n\r\0\x0B\"'"));
  return in_array($value, ['1', 'true', 'yes', 'on', 'enabled'], true);
}

function dockerNetworksDashboardRun(string $command): array
{
  $output = [];
  $exitCode = 0;
  exec($command . ' 2>&1', $output, $exitCode);

  return [
    'exitCode' => $exitCode,
    'output' => trim(implode("\n", $output)),
  ];
}

function dockerNetworksDashboardNetworkSummaries(): array
{
  $listResult = dockerNetworksDashboardRun("docker network ls --format='{{.Name}}'");
  if ($listResult['exitCode'] !== 0 || $listResult['output'] === '') {
    return [];
  }

  $summaries = [];
  $names = array_filter(array_map('trim', explode("\n", (string)$listResult['output'])));
  foreach ($names as $name) {
    $inspectResult = dockerNetworksDashboardRun(
      "docker network inspect --format='{{json .Containers}}' " . escapeshellarg((string)$name)
    );

    $connections = 0;
    if ($inspectResult['exitCode'] === 0) {
      $containers = json_decode((string)$inspectResult['output'], true);
      if (is_array($containers)) {
        $connections = count($containers);
      }
    }

    $summaries[] = [
      'name' => (string)$name,
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

  return $summaries;
}

$cfg = file_exists($defaultCfgPath) ? dockerNetworksDashboardLoadCfg($defaultCfgPath) : [];
if (file_exists($cfgPath)) {
  $cfg = array_replace($cfg, dockerNetworksDashboardLoadCfg($cfgPath));
}

$dashboardTileEnabled = dockerNetworksDashboardCfgBool($cfg, 'DASHBOARD_TILE_ENABLED', true);
if (!$dashboardTileEnabled) {
  return;
}

$menuLocation = strtolower(trim((string)($cfg['MENU_LOCATION'] ?? 'docker')));

$openPath = '/Docker/DockerNetworks';
if ($menuLocation === 'tools') {
  $openPath = '/Tools/DockerNetworks';
} elseif ($menuLocation === 'tab') {
  $openPath = '/Networks';
}

$jsCardName = json_encode($cardName);

$networkRows = '';
$networkSummaries = dockerNetworksDashboardNetworkSummaries();
$totalNetworks = count($networkSummaries);
$activeNetworks = 0;
if ($networkSummaries === []) {
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
}

$mytiles[$cardName]['column1'] = <<<EOT
<tbody title="Docker Networks">
  <tr>
    <td>
      <div class='tile-header' id='{$cardName}-dashboard-card'>
        <div class='tile-header-left'>
          <i class='fa fa-sitemap fa-2x'></i>
          <div class='section'>
            <h3 class='tile-header-main' id='{$cardName}-dashboard-title'>Docker Networks</h3>
            <span class='apps button'>
              <input type='checkbox' id='{$cardName}-active-only-toggle'>
            </span>
            <br>
          </div>
        </div>
        <div class='tile-header-right-controls'>
          <a id='{$cardName}-settings-button' href='/Settings/docker.networks.settings' title='_(Settings)_'><i class='fa fa-fw fa-cog control'></i></a>
          <a id='{$cardName}-open-button' href='{$openPath}' title='_(Open)_'><i class='fa fa-fw fa-external-link control'></i></a>
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
  #{$cardName}-dashboard-card .section {
    min-width: 0;
  }

  #{$cardName}-dashboard-title {
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
<script>
  (function () {
    var cardId = {$jsCardName};
    var toggle = document.getElementById(cardId + '-active-only-toggle');
    if (!toggle) {
      return;
    }

    function applyFilter() {
      var activeOnly = !!toggle.checked;

      var rows = document.querySelectorAll('tr.dn-dash-network-row');
      rows.forEach(function (row) {
        var count = parseInt(row.getAttribute('data-connections') || '0', 10);
        row.style.display = (!activeOnly || count > 0) ? '' : 'none';
      });
    }

    if (window.jQuery) {
      var \$toggle = window.jQuery('#' + cardId + '-active-only-toggle');
      if (typeof \$toggle.switchButton === 'function' && !\$toggle.data('switchbutton-initialized')) {
        \$toggle.switchButton({
          labels_placement: 'right',
          off_label: 'All Networks',
          on_label: 'Active only',
          checked: false
        });
        \$toggle.data('switchbutton-initialized', true);
      }

      \$toggle.off('change.dndash').on('change.dndash', applyFilter);
    } else {
      toggle.addEventListener('change', applyFilter);
    }

    applyFilter();
  }());
</script>
EOT;
