<?php
$docroot = $docroot ?? ($_SERVER['DOCUMENT_ROOT'] ?: '/usr/local/emhttp');
require_once __DIR__ . '/Logger.php';

function dockerNetworksPageNormalizeCfgValue(string $value): string
{
  return strtolower(trim($value, " \t\n\r\0\x0B\"'"));
}

function dockerNetworksPageCfgBool(array $cfg, string $key, bool $default = false): bool
{
  if (!isset($cfg[$key])) {
    return $default;
  }

  $value = dockerNetworksPageNormalizeCfgValue((string)$cfg[$key]);
  return in_array($value, ['1', 'true', 'yes', 'on', 'preserve', 'enabled'], true);
}

function dockerNetworksPageRenderActions(): string
{
  return <<<HTML
<div class="docker-networks-actions" data-location="page-controls">
  <button class="button orange-button dn-page-action" data-action="create" type="button">+ Create Network</button>
  <button class="button dn-page-action" data-action="refresh" type="button">Refresh</button>
  <button class="button dn-page-action" data-action="settings" type="button">Settings</button>
</div>
HTML;
}

// Plugin settings: use Unraid-idiomatic parse_plugin_cfg (merges default.cfg + user cfg,
// strips # comments, same behaviour as the rest of the Unraid framework).
$cfg = function_exists('parse_plugin_cfg') ? ((array)(parse_plugin_cfg('docker.networks') ?: [])) : [];

$refreshInterval = isset($cfg['REFRESH_INTERVAL']) ? (int)$cfg['REFRESH_INTERVAL'] : 30;
if ($refreshInterval <= 0) {
    $refreshInterval = 30;
}
$showSystemNetworks = dockerNetworksPageCfgBool($cfg, 'SHOW_SYSTEM_NETWORKS', true);
$showDefaultNetworks = dockerNetworksPageCfgBool($cfg, 'SHOW_DEFAULT_NETWORKS', true);
$xmlTemplatePersist = dockerNetworksPageCfgBool($cfg, 'XML_TEMPLATE_PERSIST', false);

// Docker settings: mirror DockerClient.php — merge dynamix.docker.manager defaults with
// the live docker.cfg so the result is identical to what Unraid itself sees.
$dockerCfgDefaults = function_exists('my_parse_ini_file')
    ? ((array)(@my_parse_ini_file("$docroot/plugins/dynamix.docker.manager/default.cfg") ?: []))
    : [];
$dockerCfgLive = function_exists('my_parse_ini_file')
    ? ((array)(@my_parse_ini_file('/boot/config/docker.cfg') ?: []))
    : [];
$dockerCfg = array_replace_recursive($dockerCfgDefaults, $dockerCfgLive);
$userNetworksPersist = (($dockerCfg['DOCKER_USER_NETWORKS'] ?? 'remove') === 'preserve');

if (function_exists('dockerNetworksLogger')) {
  dockerNetworksLogger('Page settings snapshot', [
    'pluginCfgPath' => '/boot/config/plugins/docker.networks/docker.networks.cfg',
    'pluginCfg' => [
      'REFRESH_INTERVAL' => $cfg['REFRESH_INTERVAL'] ?? null,
      'XML_TEMPLATE_PERSIST' => $cfg['XML_TEMPLATE_PERSIST'] ?? null,
    ],
    'dockerDefaultsPath' => "$docroot/plugins/dynamix.docker.manager/default.cfg",
    'dockerCfgPath' => '/boot/config/docker.cfg',
    'dockerCfg' => [
      'DOCKER_USER_NETWORKS' => $dockerCfg['DOCKER_USER_NETWORKS'] ?? null,
    ],
    'derived' => [
      'refreshInterval' => $refreshInterval,
      'showSystemNetworks' => $showSystemNetworks,
      'showDefaultNetworks' => $showDefaultNetworks,
      'userNetworksPersist' => $userNetworksPersist,
      'xmlTemplatePersist' => $xmlTemplatePersist,
    ],
  ], 'daemon', 'debug', 'settings');
}
?>
<script>
window.dockerNetworksApiUrl = '/plugins/docker.networks/include/Exec.php';
window.dockerNetworksRefreshInterval = <?= (int)$refreshInterval ?>;
window.dockerNetworksShowSystemNetworks = <?= $showSystemNetworks ? 'true' : 'false' ?>;
window.dockerNetworksShowDefaultNetworks = <?= $showDefaultNetworks ? 'true' : 'false' ?>;
window.dockerNetworksUserNetworksPersist = <?= $userNetworksPersist ? 'true' : 'false' ?>;
window.dockerNetworksXmlTemplatePersist = <?= $xmlTemplatePersist ? 'true' : 'false' ?>;
window.dockerNetworksSettingsUrl = '/Settings/DockerSettings';
window.dockerNetworksPluginSettingsUrl = '/Settings/docker.networks.settings';
</script>

<div id="docker-networks-page">
<div class="alert alert-success" id="successMsg" style="display:none;"></div>
<div class="alert alert-error" id="errorMsg" style="display:none;"></div>
<div class="alert" id="dockerUserNetworksWarning" style="display:none;"></div>
<div class="alert" id="dockerTemplatePersistenceWarning" style="display:none;"></div>

<?= dockerNetworksPageRenderActions() ?>

<div class="loading" id="loading">
  <div class="docker-networks-spinner"></div>
  <p>Loading networks...</p>
</div>

<table id="networksTable" style="display:none;">
  <thead>
    <tr>
      <th>Network Name</th>
      <th>Driver</th>
      <th>Subnet</th>
      <th>Containers</th>
      <th>Pending</th>
      <th>Actions</th>
    </tr>
  </thead>
  <tbody id="networksBody"></tbody>
</table>

<?= dockerNetworksPageRenderActions() ?>

<div id="createModal" class="modal">
  <div class="modal-content">
    <div class="modal-header">
      <h2>Create New Docker Network</h2>
      <span class="close" id="closeCreateModal">&times;</span>
    </div>
    <form id="createNetworkForm">
      <div class="form-group">
        <label for="networkName">Network Name:</label>
        <input type="text" id="networkName" name="networkName" required>
      </div>
      <div class="form-group">
        <label for="networkDriver">Driver:</label>
        <select id="networkDriver" name="networkDriver">
          <option value="bridge">bridge (default)</option>
          <option value="host">host</option>
          <option value="overlay">overlay</option>
        </select>
      </div>
      <div class="form-group">
        <label for="networkSubnet">Subnet (optional):</label>
        <input type="text" id="networkSubnet" name="networkSubnet" placeholder="e.g., 172.20.0.0/16">
      </div>
      <button type="submit" class="button orange-button">Create</button>
      <button type="button" class="button" id="btnCancelCreate">Cancel</button>
    </form>
  </div>
</div>

<div id="manageModal" class="modal">
  <div class="modal-content modal-wide manage-modal-content">
    <div class="modal-header">
      <h2 class="manage-modal-title">Network Details &amp; Attachments</h2>
      <span class="close" id="closeManageModal">&times;</span>
    </div>

    <div class="dn-manage-meta-grid">
      <div class="form-group">
        <label>Network Name:</label>
        <p id="manageEditNetworkName"></p>
      </div>
      <div class="form-group">
        <label>Driver:</label>
        <p id="manageEditNetworkDriver"></p>
      </div>
      <div class="form-group">
        <label>Subnet:</label>
        <p id="manageEditNetworkSubnet"></p>
      </div>
    </div>

    <form id="manageNetworkDetailsForm">
      <div class="form-group">
        <label for="manageNetworkDesc">Description:</label>
        <div class="dn-inline-save-row">
          <input type="text" id="manageNetworkDesc" name="description" placeholder="Optional description">
          <button type="submit" class="button orange-button dn-inline-save-btn" id="btnSaveManageDetails" title="Save description" aria-label="Save description">
            <i class="fa fa-save" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </form>

    <div class="loading manage-loading" id="manageLoading">
      <div class="docker-networks-spinner"></div>
      <p>Loading network attachments...</p>
    </div>

    <h3>Container Attachments</h3>
    <div class="manage-table-wrap" id="manageTableWrap">
      <div class="dn-transfer-wrap">
        <div class="dn-transfer-col">
          <label for="availableContainersSelect">Available Containers</label>
          <select id="availableContainersSelect" name="availableContainersSelect" multiple size="14"></select>
        </div>

        <div class="dn-transfer-actions" aria-label="Transfer controls">
          <button type="button" class="button orange-button" id="btnMoveSelectedRight" title="Attach selected">Attach Selected</button>
          <button type="button" class="button" id="btnMoveAllRight" title="Attach all">Attach All</button>
          <button type="button" class="button" id="btnMoveSelectedLeft" title="Detach selected">Detach Selected</button>
          <button type="button" class="button" id="btnMoveAllLeft" title="Detach all">Detach All</button>
        </div>

        <div class="dn-transfer-col">
          <label for="attachedContainersSelect">Attached Containers</label>
          <select id="attachedContainersSelect" name="attachedContainersSelect" multiple size="14"></select>
        </div>
      </div>
      <small style="display: block; margin-top: 8px; color: #666;">Use Ctrl or Shift to select multiple containers.</small>
    </div>

    <div class="form-group">
      <label for="connectContainerIpInput">IP Address For Single Attach (Optional):</label>
      <input type="text" id="connectContainerIpInput" name="connectContainerIpInput" placeholder="Used only when moving one container to Attached" />
      <small style="display: block; margin-top: 5px; color: #666;">Format: xxx.xxx.xxx.xxx (must be within network subnet)</small>
    </div>

    <div style="margin-top:15px;">
      <button type="button" class="button" id="btnCloseManage">Close</button>
    </div>
  </div>
</div>
</div>
