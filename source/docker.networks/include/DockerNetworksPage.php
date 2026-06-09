<?php
$cfgPath = '/boot/config/plugins/docker.networks/docker.networks.cfg';
$cfg = file_exists($cfgPath) ? (@parse_ini_file($cfgPath) ?: []) : [];
$refreshInterval = isset($cfg['REFRESH_INTERVAL']) ? (int)$cfg['REFRESH_INTERVAL'] : 30;
if ($refreshInterval <= 0) {
    $refreshInterval = 30;
}

$dockerCfgPath = '/boot/config/docker.cfg';
$dockerCfg = file_exists($dockerCfgPath) ? (@parse_ini_file($dockerCfgPath) ?: []) : [];
$userNetworksMode = isset($dockerCfg['DOCKER_USER_NETWORKS']) ? strtolower(trim((string)$dockerCfg['DOCKER_USER_NETWORKS'])) : 'remove';
$userNetworksPersist = ($userNetworksMode === 'preserve');
?>
<script>
window.dockerNetworksApiUrl = '/plugins/docker.networks/include/Exec.php';
window.dockerNetworksRefreshInterval = <?= (int)$refreshInterval ?>;
window.dockerNetworksUserNetworksPersist = <?= $userNetworksPersist ? 'true' : 'false' ?>;
window.dockerNetworksSettingsUrl = '/Settings/Docker';
</script>

<div id="docker-networks-page">
<div class="alert alert-success" id="successMsg" style="display:none;"></div>
<div class="alert alert-error" id="errorMsg" style="display:none;"></div>
<div class="alert" id="dockerUserNetworksWarning" style="display:none;"></div>

<div class="docker-networks-actions">
  <button class="button orange-button" id="btnCreateNetwork" type="button">+ Create Network</button>
  <button class="button orange-button" id="btnRefreshNetworks" type="button">Refresh</button>
</div>

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
      <th>Actions</th>
    </tr>
  </thead>
  <tbody id="networksBody"></tbody>
</table>

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

<div id="editModal" class="modal">
  <div class="modal-content">
    <div class="modal-header">
      <h2>Edit Network</h2>
      <span class="close" id="closeEditModal">&times;</span>
    </div>
    <form id="editNetworkForm">
      <input type="hidden" id="editNetworkId">
      <div class="form-group">
        <label>Network Name:</label>
        <p id="editNetworkName"></p>
      </div>
      <div class="form-group">
        <label>Driver:</label>
        <p id="editNetworkDriver"></p>
      </div>
      <div class="form-group">
        <label for="editNetworkDesc">Description:</label>
        <input type="text" id="editNetworkDesc" name="description" placeholder="Optional description">
      </div>
      <button type="submit" class="button orange-button">Save</button>
      <button type="button" class="button" id="btnCancelEdit">Cancel</button>
    </form>
  </div>
</div>

<div id="manageModal" class="modal">
  <div class="modal-content modal-wide manage-modal-content">
    <div class="modal-header">
      <h2>Manage Network Attachments</h2>
      <span class="close" id="closeManageModal">&times;</span>
    </div>

    <div class="form-group">
      <label>Network:</label>
      <p id="manageNetworkName"></p>
    </div>

    <div class="form-group">
      <label for="connectContainerSelect">Attach Container:</label>
      <select id="connectContainerSelect" name="connectContainerSelect"></select>
      <div style="margin-top:10px;">
        <button type="button" class="button orange-button" id="btnConnectContainer">Connect</button>
      </div>
    </div>

    <div class="loading manage-loading" id="manageLoading">
      <div class="docker-networks-spinner"></div>
      <p>Loading network attachments...</p>
    </div>

    <h3>Connected Containers</h3>
    <div class="manage-table-wrap" id="manageTableWrap">
      <table id="connectedContainersTable" class="small-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Container ID</th>
            <th>Address</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="connectedContainersBody"></tbody>
      </table>
    </div>

    <div style="margin-top:15px;">
      <button type="button" class="button" id="btnCloseManage">Close</button>
    </div>
  </div>
</div>
</div>
