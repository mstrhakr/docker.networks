(function () {
  'use strict';

  var apiBase = window.dockerNetworksApiUrl || '/plugins/docker.networks/include/Exec.php';
  var refreshMs = (window.dockerNetworksRefreshInterval || 30) * 1000;
  var userNetworksPersist = false;
  var xmlTemplatePersist = false;
  var dockerSettingsUrl = window.dockerNetworksSettingsUrl || '/Settings/DockerSettings';
  var pluginSettingsUrl = window.dockerNetworksPluginSettingsUrl || '/Settings/docker.networks.settings';
  var allContainers = [];
  var currentNetwork = null;
  var networksById = {};
  var scheduledNetworksForCurrentNetwork = {};

  function networkKey(net) {
    if (!net) {
      return '';
    }
    return net.Id || net.Name || '';
  }

  function networkSubnet(net) {
    if (net && net.IPAM && Array.isArray(net.IPAM.Config) && net.IPAM.Config[0] && net.IPAM.Config[0].Subnet) {
      return net.IPAM.Config[0].Subnet;
    }
    return 'N/A';
  }

  function networkContainerCount(net) {
    return Object.keys((net && net.Containers) || {}).length;
  }

  function networkPendingCount(net) {
    var value = net && net.PendingCount;
    if (value == null) {
      return 0;
    }
    var parsed = parseInt(value, 10);
    return isNaN(parsed) ? 0 : parsed;
  }

  function networkSignature(net) {
    return JSON.stringify({
      name: net && net.Name,
      id: net && net.Id,
      driver: net && net.Driver,
      subnet: networkSubnet(net),
      description: net && net.Description,
      containerCount: networkContainerCount(net),
      pendingCount: networkPendingCount(net),
      isDefault: !!(net && net.IsDefault),
      isProtected: !!(net && net.IsProtected),
      protectionLabel: net && net.ProtectionLabel
    });
  }

  function showMessage(msg, isError) {
    if (isError) {
      $('#errorMsg').text(msg).show();
      $('#successMsg').hide();
      setTimeout(function () { $('#errorMsg').fadeOut(); }, 5000);
    } else {
      $('#successMsg').text(msg).show();
      $('#errorMsg').hide();
      setTimeout(function () { $('#successMsg').fadeOut(); }, 5000);
    }
  }

  function ensureDismissibleBanner(selector) {
    var banner = $(selector);
    if (!banner.length || banner.data('dismissibleInit')) {
      return banner;
    }

    banner.addClass('dn-banner');
    var message = $('<div class="dn-banner-message"></div>');
    var close = $('<button type="button" class="dn-banner-close" aria-label="Close">&times;</button>');

    close.on('click', function () {
      banner.data('dismissed', true).hide();
    });

    banner.empty().append(message).append(close);
    banner.data('dismissibleInit', true);
    return banner;
  }

  function showBanner(selector, html) {
    var banner = ensureDismissibleBanner(selector);
    if (!banner.length || banner.data('dismissed')) {
      return;
    }
    banner.find('.dn-banner-message').html(html);
    banner.show();
  }

  function hideBanner(selector) {
    var banner = $(selector);
    banner.hide();
  }

  function updateUserNetworksWarning() {
    if (userNetworksPersist) {
      logClient('User networks banner hidden', { userNetworksPersist: userNetworksPersist }, 'info', 'settings');
      hideBanner('#dockerUserNetworksWarning');
      return;
    }

    logClient('User networks banner shown', { userNetworksPersist: userNetworksPersist }, 'info', 'settings');
    showBanner('#dockerUserNetworksWarning', 'Docker setting <strong>"Preserve user defined networks"</strong> is currently disabled. Connections may be lost when Docker/server restarts. <a href="' + escapeHtml(dockerSettingsUrl) + '">Open Docker Settings</a> to enable it.');
  }

  function updateTemplatePersistenceWarning() {
    if (xmlTemplatePersist) {
      logClient('Template persistence banner hidden', { xmlTemplatePersist: xmlTemplatePersist }, 'info', 'settings');
      hideBanner('#dockerTemplatePersistenceWarning');
      return;
    }

    logClient('Template persistence banner shown', { xmlTemplatePersist: xmlTemplatePersist }, 'info', 'settings');
    showBanner('#dockerTemplatePersistenceWarning', 'Template XML persistence is <strong>disabled</strong>. Network changes apply at runtime only. Enable it explicitly in <a href="' + escapeHtml(pluginSettingsUrl) + '">Docker Networks Settings</a> if you want template edits for restart persistence.');
  }

  function logClient(msg, data, level, category) {
    if (typeof window.dockerNetworksLogger === 'function') {
      window.dockerNetworksLogger(msg, data, 'user', level || 'info', category || 'ui');
    }
  }

  function syncBannerSettings() {
    userNetworksPersist = !!window.dockerNetworksUserNetworksPersist;
    xmlTemplatePersist = !!window.dockerNetworksXmlTemplatePersist;
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  /**
   * Validate IPv4 address format
   */
  function validateIpAddress(ip) {
    if (ip === '' || ip === null) {
      return { valid: true, error: '' }; // empty is OK (auto-assign)
    }

    // IPv4 validation regex
    var ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    var match = String(ip).trim().match(ipv4Regex);
    if (!match) {
      return { valid: false, error: 'Invalid IP address format' };
    }

    // Validate each octet is 0-255
    for (var i = 1; i <= 4; i++) {
      var octet = parseInt(match[i], 10);
      if (octet < 0 || octet > 255) {
        return { valid: false, error: 'IP octets must be between 0 and 255' };
      }
    }

    return { valid: true, error: '' };
  }


  function extractApiErrorMessage(xhr, status, error) {
    if (xhr && xhr.responseJSON && typeof xhr.responseJSON === 'object') {
      if (xhr.responseJSON.error) {
        return String(xhr.responseJSON.error);
      }
    }

    if (xhr && xhr.responseText) {
      try {
        var parsed = JSON.parse(xhr.responseText);
        if (parsed && typeof parsed === 'object' && parsed.error) {
          return String(parsed.error);
        }
      } catch (parseErr) {
        // Ignore parse failure and keep fallback handling.
      }
    }

    if (error) {
      return String(error);
    }

    if (status) {
      return String(status);
    }

    return 'Unknown API error';
  }

  function apiCall(action, payload, onSuccess, onError) {
    var requestBody = payload || {};
    requestBody.action = action;

    $.post(apiBase, requestBody, onSuccess, 'json').fail(function (xhr, status, error) {
      var message = extractApiErrorMessage(xhr, status, error);
      logClient('API call failed', {
        action: action,
        status: status,
        error: error,
        parsedError: message,
        response: xhr && xhr.responseText ? xhr.responseText : ''
      }, 'error', 'api');

      if (typeof onError === 'function') {
        onError(message, xhr, status, error);
        return;
      }

      showActionResult('API Error', '<div class="swal-text-block">Error: ' + escapeHtml(message) + '</div>', false);
    });
  }

  function requestData(action, payload) {
    return new Promise(function (resolve, reject) {
      apiCall(
        action,
        payload,
        function (data) {
          if (data && data.success) {
            resolve(data);
            return;
          }
          reject((data && data.error) || 'Unknown error');
        },
        function (message) {
          reject(message || 'Unknown error');
        }
      );
    });
  }

  function requestAction(action, payload) {
    return new Promise(function (resolve, reject) {
      apiCall(
        action,
        payload,
        function (data) {
          if (data && data.success) {
            resolve(data || {});
            return;
          }
          reject((data && data.error) || 'Unknown error');
        },
        function (message) {
          reject(message || 'Unknown error');
        }
      );
    });
  }

  function createActionButton(label, classes, handler, disabled, disabledReason) {
    var button = $('<button type="button"></button>');
    button.addClass(classes);
    button.text(label);
    if (disabled) {
      button.prop('disabled', true);
      if (disabledReason) {
        button.attr('title', disabledReason);
      }
      return button;
    }
    button.on('click', handler);
    return button;
  }

  function getSwalRuntime() {
    if (typeof window !== 'undefined' && window.Swal && typeof window.Swal.fire === 'function') {
      return { version: 2, api: window.Swal };
    }

    if (typeof swal === 'function') {
      return { version: 1, api: swal };
    }

    return null;
  }

  function htmlToText(html) {
    return $('<div>').html(html || '').text();
  }

  function confirmAction(title, messageHtml, confirmText, onConfirm) {
    var runtime = getSwalRuntime();
    if (runtime && runtime.version === 2) {
      runtime.api.fire({
        title: title,
        html: messageHtml,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: confirmText,
        cancelButtonText: 'Cancel'
      }).then(function (result) {
        if (result && result.isConfirmed) {
          onConfirm();
        }
      });
      return;
    }

    if (runtime && runtime.version === 1) {
      runtime.api({
        title: title,
        text: messageHtml,
        html: true,
        type: 'warning',
        showCancelButton: true,
        confirmButtonText: confirmText,
        cancelButtonText: 'Cancel'
      }, function (confirmed) {
        if (confirmed) {
          onConfirm();
        }
      });
      return;
    }

    if (confirm(htmlToText(messageHtml))) {
      onConfirm();
    }
  }

  function showActionResult(title, messageHtml, isSuccess, onClose) {
    var runtime = getSwalRuntime();
    if (runtime && runtime.version === 2) {
      runtime.api.fire({
        title: title,
        html: messageHtml,
        icon: isSuccess ? 'success' : 'error',
        confirmButtonText: 'OK'
      }).then(function () {
        if (onClose) {
          onClose();
        }
      });
      return;
    }

    if (runtime && runtime.version === 1) {
      runtime.api({
        title: title,
        text: messageHtml,
        html: true,
        type: isSuccess ? 'success' : 'error',
        confirmButtonText: 'OK'
      }, function () {
        if (onClose) {
          onClose();
        }
      });
      return;
    }

    alert(htmlToText(messageHtml));
    if (onClose) {
      onClose();
    }
  }

  function showLoadingModal(title, messageHtml) {
    var runtime = getSwalRuntime();
    if (runtime && runtime.version === 2) {
      runtime.api.fire({
        title: title,
        html: messageHtml,
        icon: 'info',
        showConfirmButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
        didOpen: function () {
          runtime.api.showLoading();
        }
      });
      return;
    }

    if (runtime && runtime.version === 1) {
      runtime.api({
        title: title,
        text: messageHtml,
        type: 'info',
        showConfirmButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false
      });
      return;
    }
  }

  function closeModal() {
    var runtime = getSwalRuntime();
    if (runtime && runtime.version === 2) {
      runtime.api.close();
      return;
    }

    if (runtime && runtime.version === 1 && typeof swal.close === 'function') {
      swal.close();
    }
  }

  function renderNetworkRow(row, net) {
    var key = networkKey(net);
    var nameHtml = '<strong class="network-name">' + escapeHtml(net.Name || '') + '</strong>';

    if (net.IsProtected) {
      nameHtml += ' <span class="network-badge">' + escapeHtml(net.ProtectionLabel || 'Protected') + '</span>';
    }

    nameHtml += '<br><span class="network-id">' + escapeHtml((net.Id || '').substring(0, 12)) + '</span>';

    if (net.Description) {
      nameHtml += '<br><span class="network-desc">' + escapeHtml(net.Description) + '</span>';
    }

    row.attr('data-network-id', key);
    row.attr('data-network-signature', networkSignature(net));
    row.empty();

    row.append($('<td></td>').html(nameHtml));
    row.append($('<td></td>').text(net.Driver || ''));
    row.append($('<td></td>').text(networkSubnet(net)));
    row.append($('<td></td>').text(String(networkContainerCount(net))));
    row.append($('<td></td>').text(String(networkPendingCount(net))));

    var actions = $('<td class="network-actions"></td>');
    actions.append(createActionButton('Edit', 'button', function () { openEditModal(net); }));
    actions.append(createActionButton('Manage', 'button', function () { openManageModal(net); }));
    
    // Determine if delete button should be disabled and why
    var canDelete = !net.IsProtected && networkContainerCount(net) === 0 && networkPendingCount(net) === 0;
    var deleteDisabledReason = '';
    if (net.IsProtected) {
      deleteDisabledReason = 'Protected Docker networks cannot be deleted';
    } else if (networkContainerCount(net) > 0 || networkPendingCount(net) > 0) {
      deleteDisabledReason = 'Disconnect all containers from this network before deleting. Use the Manage tab.';
    }
    
    actions.append(createActionButton('Delete', 'button orange-button', function () { deleteNetwork(net.Id, net.Name, !!net.IsProtected, net.ProtectionLabel); }, !canDelete, deleteDisabledReason));

    row.append(actions);
  }

  function syncNetworksTable(networks) {
    var tbody = $('#networksBody');
    networksById = {};

    if (!networks || networks.length === 0) {
      tbody.empty();
      tbody.html('<tr><td colspan="6" style="text-align:center;">No networks found</td></tr>');
      return;
    }

    tbody.find('tr[data-network-empty="true"]').remove();

    var existingRows = {};
    tbody.find('tr[data-network-id]').each(function () {
      var row = $(this);
      existingRows[row.attr('data-network-id')] = row;
    });

    var seen = {};

    networks.forEach(function (net) {
      var key = networkKey(net);
      if (!key) {
        return;
      }

      networksById[key] = net;
      seen[key] = true;

      var row = existingRows[key];
      var signature = networkSignature(net);
      if (!row || !row.length) {
        row = $('<tr></tr>');
        renderNetworkRow(row, net);
        tbody.append(row);
        return;
      }

      if (row.attr('data-network-signature') !== signature) {
        renderNetworkRow(row, net);
      }

      tbody.append(row);
    });

    Object.keys(existingRows).forEach(function (key) {
      if (!seen[key]) {
        existingRows[key].remove();
      }
    });
  }

  function loadContainers() {
    return requestData('containers', {}).then(function (data) {
      allContainers = data.containers || [];
      logClient('Containers loaded', { count: allContainers.length }, 'debug', 'api');
    }).catch(function (err) {
      allContainers = [];
      logClient('Load containers failed', { error: String(err) }, 'error', 'api');
      showActionResult('Load Failed', '<div class="swal-text-block">Unable to load containers: ' + escapeHtml(String(err)) + '</div>', false);
    });
  }

  function loadScheduledNetworks(networkId) {
    return requestData('checkScheduledNetworks', { networkId: networkId }).then(function (data) {
      scheduledNetworksForCurrentNetwork = {};
      if (data.scheduledContainers && Array.isArray(data.scheduledContainers)) {
        data.scheduledContainers.forEach(function (container) {
          scheduledNetworksForCurrentNetwork[container.id] = container;
          scheduledNetworksForCurrentNetwork[container.name] = container;
        });
      }
      logClient('Scheduled networks loaded', { networkId: networkId, count: data.scheduledContainers ? data.scheduledContainers.length : 0 }, 'debug', 'api');
    }).catch(function (err) {
      scheduledNetworksForCurrentNetwork = {};
      logClient('Load scheduled networks failed', { error: String(err) }, 'debug', 'api');
      // Don't show error for scheduled networks—it's optional
    });
  }

  function refreshManageModal() {
    if (!currentNetwork) {
      return;
    }

    var refreshedNetwork = networksById[networkKey(currentNetwork)];
    if (!refreshedNetwork) {
      closeManageModal();
      return;
    }

    currentNetwork = refreshedNetwork;
    $('#manageNetworkName').text((refreshedNetwork.Name || '') + ' (' + (refreshedNetwork.Id || '').substring(0, 12) + ')');
    renderManageTransferLists(refreshedNetwork);
  }

  function loadNetworks(options) {
    var settings = $.extend({ showLoading: false, refreshContainers: false }, options || {});

    if (settings.showLoading) {
      $('#loading').show();
      $('#networksTable').hide();
    }

    var tasks = [requestData('list', {})];
    if (settings.refreshContainers) {
      tasks.unshift(loadContainers());
    }

    return Promise.all(tasks).then(function (results) {
      var data = results[results.length - 1];
      syncNetworksTable(data.networks || []);
      $('#networksTable').show();
      refreshManageModal();
      return data;
    }).catch(function (err) {
      logClient('Load networks failed', { error: String(err) }, 'error', 'api');
      showActionResult('Load Failed', '<div class="swal-text-block">' + escapeHtml(String(err)) + '</div>', false);
      throw err;
    }).finally(function () {
      if (settings.showLoading) {
        $('#loading').hide();
      }
    });
  }

  function openCreateModal() {
    $('#createNetworkForm')[0].reset();
    $('#createModal').show();
  }

  function closeCreateModal() {
    $('#createModal').hide();
  }

  function openEditModal(network) {
    $('#editNetworkId').val(network.Id || '');
    $('#editNetworkName').text(network.Name || '');
    $('#editNetworkDriver').text(network.Driver || '');
    $('#editNetworkDesc').val(network.Description || '');
    $('#editModal').show();
  }

  function closeEditModal() {
    $('#editModal').hide();
  }

  function openManageModal(network) {
    currentNetwork = network;
    $('#manageNetworkName').text((network.Name || '') + ' (' + (network.Id || '').substring(0, 12) + ')');
    setManageLoading(true);
    $('#manageModal').show();

    loadContainers().then(function () {
      return loadScheduledNetworks(network.Id);
    }).then(function () {
      renderManageTransferLists(currentNetwork || network);
    }).finally(function () {
      setManageLoading(false);
    });
  }

  function closeManageModal() {
    currentNetwork = null;
    $('#manageModal').hide();
    setManageLoading(false);
  }

  function setManageLoading(isLoading) {
    var loading = !!isLoading;
    $('#manageLoading').toggle(loading);
    $('#manageTableWrap').toggle(!loading);
    $('#availableContainersSelect').prop('disabled', loading);
    $('#attachedContainersSelect').prop('disabled', loading);
    $('#btnMoveSelectedRight').prop('disabled', loading);
    $('#btnMoveAllRight').prop('disabled', loading);
    $('#btnMoveSelectedLeft').prop('disabled', loading);
    $('#btnMoveAllLeft').prop('disabled', loading);
  }

  var manageTransferState = {
    available: [],
    attached: []
  };

  function connectedContainerList(network) {
    var map = (network && network.Containers) || {};
    return Object.keys(map).map(function (key) {
      var c = map[key] || {};
      return {
        id: c.Name || key,
        endpointId: key,
        name: c.Name || key,
        ipv4: c.IPv4Address || '',
        ipv6: c.IPv6Address || ''
      };
    }).sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
  }

  function shortId(value) {
    return String(value || '').substring(0, 12);
  }

  function buildManageTransferState(network) {
    var connected = connectedContainerList(network);
    var attached = [];
    var attachedKeys = {};

    connected.forEach(function (item) {
      attached.push({
        id: item.id,
        name: item.name,
        address: item.ipv4 || item.ipv6 || 'N/A',
        scheduledOnly: false
      });
      attachedKeys[item.id] = true;
      attachedKeys[item.name] = true;
    });

    var uniqueScheduled = {};
    Object.keys(scheduledNetworksForCurrentNetwork).forEach(function (key) {
      var container = scheduledNetworksForCurrentNetwork[key];
      if (!container || !container.id) {
        return;
      }
      uniqueScheduled[container.id] = container;
    });

    Object.keys(uniqueScheduled).forEach(function (containerId) {
      var container = uniqueScheduled[containerId];
      if (attachedKeys[containerId] || attachedKeys[container.name]) {
        return;
      }
      attached.push({
        id: containerId,
        name: container.name || containerId,
        address: 'Will connect on startup',
        scheduledOnly: true
      });
      attachedKeys[containerId] = true;
      attachedKeys[container.name || containerId] = true;
    });

    var available = [];
    allContainers.forEach(function (container) {
      if (!container || !container.id || !container.name) {
        return;
      }
      if (attachedKeys[container.id] || attachedKeys[container.name]) {
        return;
      }
      available.push({
        id: container.id,
        name: container.name,
        address: container.state || '',
        scheduledOnly: false
      });
    });

    available.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    attached.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });

    return {
      available: available,
      attached: attached
    };
  }

  function optionLabelForItem(item, side) {
    var parts = [];
    parts.push(item.name || item.id || 'Unnamed');
    parts.push('[' + shortId(item.id) + ']');
    if (side === 'attached') {
      parts.push(item.scheduledOnly ? '(scheduled)' : '(' + (item.address || 'N/A') + ')');
    }
    return parts.join(' ');
  }

  function renderTransferSelect(selectId, items, side) {
    var select = $(selectId);
    select.empty();

    if (!items.length) {
      var emptyOpt = $('<option></option>');
      emptyOpt.text(side === 'available' ? 'No available containers' : 'No attached containers');
      emptyOpt.prop('disabled', true);
      select.append(emptyOpt);
      return;
    }

    items.forEach(function (item, index) {
      var option = $('<option></option>');
      option.val(String(index));
      option.text(optionLabelForItem(item, side));
      select.append(option);
    });
  }

  function renderManageTransferLists(network) {
    manageTransferState = buildManageTransferState(network);
    renderTransferSelect('#availableContainersSelect', manageTransferState.available, 'available');
    renderTransferSelect('#attachedContainersSelect', manageTransferState.attached, 'attached');
  }

  function getSelectedTransferItems(side) {
    var selectId = side === 'available' ? '#availableContainersSelect' : '#attachedContainersSelect';
    var source = side === 'available' ? manageTransferState.available : manageTransferState.attached;
    var raw = $(selectId).val() || [];
    return raw.map(function (value) {
      var index = parseInt(value, 10);
      return source[index];
    }).filter(function (item) {
      return !!item;
    });
  }

  function findContainerMeta(item) {
    return allContainers.find(function (container) {
      if (!container) {
        return false;
      }
      return container.id === item.id || container.name === item.name;
    }) || null;
  }

  function runSequential(items, executor) {
    var successes = [];
    var failures = [];

    return items.reduce(function (chain, item) {
      return chain.then(function () {
        return executor(item).then(function (data) {
          successes.push({ item: item, data: data || {} });
        }).catch(function (error) {
          failures.push({ item: item, error: String(error) });
        });
      });
    }, Promise.resolve()).then(function () {
      return { successes: successes, failures: failures };
    });
  }

  function showBatchResult(title, actionWord, result, onClose) {
    var successCount = result.successes.length;
    var failureCount = result.failures.length;
    var html = '<div class="swal-text-block">';
    html += '<strong>' + successCount + '</strong> container(s) ' + escapeHtml(actionWord) + '.';

    if (failureCount > 0) {
      html += '<br><br><strong>' + failureCount + '</strong> failed:';
      result.failures.slice(0, 5).forEach(function (entry) {
        html += '<br>- ' + escapeHtml(entry.item.name || entry.item.id || 'Unknown') + ': ' + escapeHtml(entry.error);
      });
      if (failureCount > 5) {
        html += '<br>- ...';
      }
    }

    html += '</div>';
    showActionResult(title, html, failureCount === 0, onClose);
  }

  function connectContainersBatch(items, ipAddress) {
    if (!currentNetwork || !currentNetwork.Id) {
      showActionResult('Error', '<div class="swal-text-block">No selected network</div>', false);
      return;
    }

    if (!items.length) {
      showActionResult('Nothing Selected', '<div class="swal-text-block">Select one or more containers to attach.</div>', false);
      return;
    }

    setManageLoading(true);
    runSequential(items, function (item) {
      var meta = findContainerMeta(item);
      var payload = {
        networkId: currentNetwork.Id,
        containerId: item.id
      };

      if (meta && meta.name) {
        payload.containerName = meta.name;
      }
      if (meta && meta.state) {
        payload.containerState = meta.state;
      }
      if (ipAddress) {
        payload.ipAddress = ipAddress;
      }

      return requestAction('connect', payload);
    }).then(function (result) {
      if (result.successes.length > 0) {
        $('#connectContainerIpInput').val('');
      }

      showBatchResult('Attach Complete', 'attached', result, function () {
        if (result.successes.length > 0) {
          reloadDataAndRefreshManageModal();
        }
      });
    }).finally(function () {
      setManageLoading(false);
    });
  }

  function disconnectContainersBatch(items) {
    if (!currentNetwork || !currentNetwork.Id) {
      showActionResult('Error', '<div class="swal-text-block">No selected network</div>', false);
      return;
    }

    if (!items.length) {
      showActionResult('Nothing Selected', '<div class="swal-text-block">Select one or more containers to detach.</div>', false);
      return;
    }

    var confirmHtml = '<div class="swal-text-block">Detach <strong>' + items.length + '</strong> container(s) from <strong>' + escapeHtml(currentNetwork.Name || currentNetwork.Id) + '</strong>?</div>';
    confirmAction('Detach Containers', confirmHtml, 'Detach', function () {
      setManageLoading(true);
      runSequential(items, function (item) {
        var payload = {
          networkId: currentNetwork.Id,
          containerId: item.id
        };
        if (item.name) {
          payload.containerName = item.name;
        }
        return requestAction('disconnect', payload);
      }).then(function (result) {
        showBatchResult('Detach Complete', 'detached', result, function () {
          if (result.successes.length > 0) {
            reloadDataAndRefreshManageModal();
          }
        });
      }).finally(function () {
        setManageLoading(false);
      });
    });
  }

  function moveSelectedRight() {
    var selected = getSelectedTransferItems('available');
    var ipAddress = $.trim($('#connectContainerIpInput').val() || '');

    if (ipAddress !== '') {
      var validation = validateIpAddress(ipAddress);
      if (!validation.valid) {
        showActionResult('Invalid IP Address', '<div class="swal-text-block">' + escapeHtml(validation.error) + '</div>', false);
        return;
      }
      if (selected.length !== 1) {
        showActionResult('IP Requires Single Selection', '<div class="swal-text-block">Provide an IP only when attaching exactly one container.</div>', false);
        return;
      }
    }

    connectContainersBatch(selected, ipAddress);
  }

  function moveAllRight() {
    connectContainersBatch(manageTransferState.available.slice(), '');
  }

  function moveSelectedLeft() {
    disconnectContainersBatch(getSelectedTransferItems('attached'));
  }

  function moveAllLeft() {
    disconnectContainersBatch(manageTransferState.attached.slice());
  }

  var deleteInProgress = false;

  function deleteNetwork(id, name, isProtected, protectionLabel) {
    // Prevent double-delete race condition
    if (deleteInProgress) {
      return;
    }

    if (isProtected) {
      showActionResult('Cannot Delete', '<div class="swal-text-block">This network is protected and cannot be deleted.</div>', false);
      return;
    }

    var confirmHtml = '<div class="swal-text-block">';
    confirmHtml += 'Are you sure you want to delete <strong>' + escapeHtml(name) + '</strong>?';
    confirmHtml += '<br><br><span style="color: #ff9800;">This action cannot be undone.</span>';
    confirmHtml += '</div>';

    confirmAction(
      'Delete Network',
      confirmHtml,
      'Delete',
      function () {
        deleteInProgress = true;
        showLoadingModal('Deleting Network', 'Removing network...');
        performDeleteNetwork(id, name);
      }
    );
  }

  function performDeleteNetwork(id, name) {
    apiCall('delete', { id: id }, function (data) {
      deleteInProgress = false;
      if (data.success) {
        logClient('Network deleted', { id: id, name: name }, 'info', 'network');
        showActionResult('Deleted', '<div class="swal-text-block">Network deleted successfully</div>', true, function () {
          if (currentNetwork && currentNetwork.Id === id) {
            closeManageModal();
          }
          loadNetworks({ refreshContainers: false });
        });
      } else {
        logClient('Network delete failed', { id: id, error: data.error }, 'error', 'network');
        showActionResult('Delete Failed', '<div class="swal-text-block">' + escapeHtml(data.error || 'Failed to delete network') + '</div>', false);
      }
    });
  }

  function reloadDataAndRefreshManageModal() {
    setManageLoading(true);
    loadNetworks({ refreshContainers: true }).catch(function (err) {
      showActionResult('Refresh Failed', '<div class="swal-text-block">' + escapeHtml(String(err)) + '</div>', false);
    }).finally(function () {
      setManageLoading(false);
    });
  }

  function createNetwork(event) {
    event.preventDefault();
    var payload = {
      name: $('#networkName').val(),
      driver: $('#networkDriver').val(),
      subnet: $('#networkSubnet').val()
    };

    apiCall('create', payload, function (data) {
      if (data.success) {
        logClient('Network created', { payload: payload, id: data.id }, 'info', 'network');
        showActionResult('Created', '<div class="swal-text-block">Network created successfully</div>', true, function () {
          closeCreateModal();
          loadNetworks({ refreshContainers: false });
        });
      } else {
        logClient('Network create failed', { payload: payload, error: data.error }, 'error', 'network');
        showActionResult('Create Failed', '<div class="swal-text-block">' + escapeHtml(data.error || 'Failed to create network') + '</div>', false);
      }
    });
  }

  function updateNetwork(event) {
    event.preventDefault();
    var payload = {
      id: $('#editNetworkId').val(),
      description: $('#editNetworkDesc').val()
    };

    apiCall('update', payload, function (data) {
      if (data.success) {
        logClient('Network updated', { id: payload.id }, 'info', 'network');
        showActionResult('Updated', '<div class="swal-text-block">Network updated</div>', true, function () {
          closeEditModal();
          loadNetworks({ refreshContainers: false });
        });
      } else {
        logClient('Network update failed', { id: payload.id, error: data.error }, 'error', 'network');
        showActionResult('Update Failed', '<div class="swal-text-block">' + escapeHtml(data.error || 'Failed to update network') + '</div>', false);
      }
    });
  }

  $(function () {
    syncBannerSettings();
    logClient('Banner settings snapshot', {
      userNetworksPersist: userNetworksPersist,
      xmlTemplatePersist: xmlTemplatePersist,
      dockerSettingsUrl: dockerSettingsUrl,
      pluginSettingsUrl: pluginSettingsUrl
    }, 'info', 'settings');
    updateUserNetworksWarning();
    updateTemplatePersistenceWarning();

    $('#btnCreateNetwork').on('click', openCreateModal);
    $('#btnRefreshNetworks').on('click', function () {
      loadNetworks({ showLoading: true, refreshContainers: !!currentNetwork });
    });
    $('#btnPluginSettings').on('click', function () {
      window.location.href = pluginSettingsUrl;
    });
    $('#closeCreateModal').on('click', closeCreateModal);
    $('#btnCancelCreate').on('click', closeCreateModal);
    $('#closeEditModal').on('click', closeEditModal);
    $('#btnCancelEdit').on('click', closeEditModal);
    $('#closeManageModal').on('click', closeManageModal);
    $('#btnCloseManage').on('click', closeManageModal);
    $('#btnMoveSelectedRight').on('click', moveSelectedRight);
    $('#btnMoveAllRight').on('click', moveAllRight);
    $('#btnMoveSelectedLeft').on('click', moveSelectedLeft);
    $('#btnMoveAllLeft').on('click', moveAllLeft);

    $('#createNetworkForm').on('submit', createNetwork);
    $('#editNetworkForm').on('submit', updateNetwork);

    loadNetworks({ showLoading: true, refreshContainers: false }).catch(function () {
      return undefined;
    });
    loadContainers();
    logClient('Docker Networks UI initialized', { refreshMs: refreshMs }, 'info', 'ui');
    setInterval(function () {
      loadNetworks({ refreshContainers: !!currentNetwork }).catch(function () {
        return undefined;
      });
    }, refreshMs);
  });
})();