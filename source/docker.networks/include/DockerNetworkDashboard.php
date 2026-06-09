<?php
$cardName = 'docker-networks';
$cfgPath = '/boot/config/plugins/docker.networks/docker.networks.cfg';
$cfg = file_exists($cfgPath) ? (@parse_ini_file($cfgPath) ?: []) : [];
$menuLocation = strtolower(trim((string)($cfg['MENU_LOCATION'] ?? 'docker')));

$openPath = '/Docker/DockerNetworks';
if ($menuLocation === 'tools') {
  $openPath = '/Tools/DockerNetworksTools';
} elseif ($menuLocation === 'tab') {
  $openPath = '/DockerNetworks';
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
            <span>Custom network manager</span>
          </div>
        </div>
        <div class='tile-header-right-controls'>
          <a id='{$cardName}-open-button' href='{$openPath}' title='_(Open)_'><i class='fa fa-fw fa-external-link control'></i></a>
        </div>
      </div>
    </td>
  </tr>
  <tr>
    <td><span class='w26'>Status</span> Ready</td>
  </tr>
</tbody>
EOT;
