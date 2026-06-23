(function () {
  'use strict';

  function readWindowBool(value, defaultValue) {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return value !== 0;
    }

    if (typeof value === 'string') {
      var normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on', 'enabled'].indexOf(normalized) !== -1) {
        return true;
      }
      if (['0', 'false', 'no', 'off', 'disabled'].indexOf(normalized) !== -1) {
        return false;
      }
    }

    return defaultValue;
  }

  var apiBase = window.dockerNetworksApiUrl || '/plugins/docker.networks/include/Exec.php';
  var refreshMs = (window.dockerNetworksRefreshInterval || 30) * 1000;
  var showSystemNetworks = readWindowBool(window.dockerNetworksShowSystemNetworks, true);
  var showDefaultNetworks = readWindowBool(window.dockerNetworksShowDefaultNetworks, true);
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

  function networkIsSystem(net) {
    var label = (net && net.ProtectionLabel) ? String(net.ProtectionLabel).toLowerCase() : '';
    return label === 'system';
  }

  function networkIsDefault(net) {
    var label = (net && net.ProtectionLabel) ? String(net.ProtectionLabel).toLowerCase() : '';
    return label === 'default';
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
    function decodeEscapedJsonString(value) {
      try {
        return JSON.parse('"' + String(value).replace(/"/g, '\\"') + '"');
      } catch (e) {
        return String(value);
      }
    }

    if (xhr && xhr.responseJSON && typeof xhr.responseJSON === 'object') {
      if (xhr.responseJSON.error) {
        return String(xhr.responseJSON.error).trim();
      }
    }

    var responseText = xhr && xhr.responseText ? String(xhr.responseText) : '';
    if (responseText) {
      try {
        var parsed = JSON.parse(responseText);
        if (parsed && typeof parsed === 'object' && parsed.error) {
          return String(parsed.error).trim();
        }
      } catch (parseErr) {
        var errorMatch = responseText.match(/"error"\s*:\s*"((?:\\.|[^"\\])*)"/i);
        if (errorMatch && errorMatch[1]) {
          var extracted = decodeEscapedJsonString(errorMatch[1]).trim();
          if (extracted) {
            return extracted;
          }
        }
      }
    }

    if (error) {
      return String(error).trim();
    }

    var statusText = xhr && xhr.statusText ? String(xhr.statusText).trim() : '';
    if (statusText) {
      return statusText;
    }

    if (status) {
      return String(status).trim();
    }

    if (responseText) {
      return responseText.slice(0, 240).trim();
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

      var displayMessage = (message && String(message).trim()) ? String(message).trim() : 'Unknown API error';
      showActionResult('API Error', '<div class="swal-text-block">Error: ' + escapeHtml(displayMessage) + '</div>', false);
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

  function showActionResult(title, messageHtml, isSuccess, onClose, options) {
    var runtime = getSwalRuntime();
    var hasAttemptTable = String(messageHtml || '').indexOf('dn-attempt-table') !== -1;
    var preferredWidth = options && options.preferredWidth ? Number(options.preferredWidth) : 0;

    if (!isFinite(preferredWidth) || preferredWidth <= 0) {
      preferredWidth = 0;
    }

    function clampPopupWidth(value) {
      var minWidth = 520;
      var maxWidth = 980;
      return Math.max(minWidth, Math.min(maxWidth, Math.round(value)));
    }

    if (runtime && runtime.version === 2) {
      var swal2Options = {
        title: title,
        html: messageHtml,
        icon: isSuccess ? 'success' : 'error',
        confirmButtonText: 'OK'
      };

      if (hasAttemptTable) {
        swal2Options.width = preferredWidth > 0 ? (clampPopupWidth(preferredWidth) + 'px') : 'auto';
        swal2Options.customClass = { popup: 'dn-result-popup' };
      }

      runtime.api.fire(swal2Options).then(function () {
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

      if (hasAttemptTable) {
        setTimeout(function () {
          var legacyPopup = $('.sweet-alert:visible');
          if (legacyPopup.length) {
            var cssWidth = preferredWidth > 0 ? (clampPopupWidth(preferredWidth) + 'px') : 'auto';
            legacyPopup.addClass('dn-result-popup');
            legacyPopup.css({
              width: cssWidth,
              'max-width': '96vw'
            });
          }
        }, 0);
      }

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

    logClient('Filtering networks', { total: (networks || []).length, showSystemNetworks: showSystemNetworks }, 'debug', 'filter');

    var visibleNetworks = (networks || []).filter(function (net) {
      if (!showSystemNetworks && networkIsSystem(net)) {
        logClient('Filtering out system network', { name: net.Name, label: net.ProtectionLabel }, 'debug', 'filter');
        return false;
      }
      if (!showDefaultNetworks && networkIsDefault(net)) {
        logClient('Filtering out default network', { name: net.Name, label: net.ProtectionLabel }, 'debug', 'filter');
        return false;
      }
      return true;
    });

    logClient('After filter', { visible: visibleNetworks.length }, 'debug', 'filter');

    if (!visibleNetworks.length) {
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

    visibleNetworks.forEach(function (net) {
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
    $('#manageEditNetworkName').text((refreshedNetwork.Name || '') + ' (' + (refreshedNetwork.Id || '').substring(0, 12) + ')');
    $('#manageEditNetworkDriver').text(refreshedNetwork.Driver || '');
    $('#manageEditNetworkSubnet').text(networkSubnet(refreshedNetwork));
    $('#manageNetworkDesc').val(refreshedNetwork.Description || '');
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

  function openManageModal(network) {
    currentNetwork = network;
    $('#manageEditNetworkName').text((network.Name || '') + ' (' + (network.Id || '').substring(0, 12) + ')');
    $('#manageEditNetworkDriver').text(network.Driver || '');
    $('#manageEditNetworkSubnet').text(networkSubnet(network));
    $('#manageNetworkDesc').val(network.Description || '');
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
    if (currentEventSource) {
      currentEventSource.close();
      currentEventSource = null;
    }
    activeBatchRequestId = '';
    batchFinalizeScheduled = false;
    setActionInProgress(false);
    $('#manageModal').hide();
    $('#manageNetworkDetailsForm')[0].reset();
    setManageLoading(false);
  }

  function setManageLoading(isLoading) {
    var loading = !!isLoading;
    $('#manageLoading').toggle(loading);
    $('#manageTableWrap').toggle(!loading);
    var disabled = loading || actionInProgress;
    $('#manageNetworkDesc').prop('disabled', disabled);
    $('#btnSaveManageDetails').prop('disabled', disabled);
    $('#availableContainersSelect').prop('disabled', disabled);
    $('#attachedContainersSelect').prop('disabled', disabled);
    $('#btnMoveSelectedRight').prop('disabled', disabled);
    $('#btnMoveAllRight').prop('disabled', disabled);
    $('#btnMoveSelectedLeft').prop('disabled', disabled);
    $('#btnMoveAllLeft').prop('disabled', disabled);
  }

  var manageTransferState = {
    available: [],
    attached: []
  };

  var actionInProgress = false;
  var currentEventSource = null;
  var sseUpdateCount = 0;
  var syncTransferStateTimer = null;
  var activeBatchRequestId = '';
  var batchFinalizeScheduled = false;

  function isManageLoading() {
    return $('#manageLoading').is(':visible');
  }

  function scheduleTransferStateSync() {
    if (syncTransferStateTimer) {
      clearTimeout(syncTransferStateTimer);
      syncTransferStateTimer = null;
    }

    syncTransferStateTimer = setTimeout(function () {
      if (actionInProgress) {
        // Never run state reconciliation during an active batch action.
        scheduleTransferStateSync();
        return;
      }

      syncTransferStateTimer = null;
      loadContainers().then(function () {
        return loadNetworks({ refreshContainers: false });
      }).then(function () {
        var networkId = currentNetwork ? currentNetwork.Id : null;
        if (networkId) {
          return loadScheduledNetworks(networkId);
        }
      }).then(function () {
        if (currentNetwork) {
          refreshManageModal();
        }
      }).catch(function (err) {
        logClient('Background refresh failed', { error: String(err) }, 'debug', 'api');
      });
    }, 350);
  }

  function setActionInProgress(isInProgress) {
    actionInProgress = !!isInProgress;
    var disabled = actionInProgress || isManageLoading();
    $('#manageNetworkDesc').prop('disabled', disabled);
    $('#btnSaveManageDetails').prop('disabled', disabled);
    $('#btnMoveSelectedRight').prop('disabled', disabled);
    $('#btnMoveAllRight').prop('disabled', disabled);
    $('#btnMoveSelectedLeft').prop('disabled', disabled);
    $('#btnMoveAllLeft').prop('disabled', disabled);
    $('#availableContainersSelect').prop('disabled', disabled);
    $('#attachedContainersSelect').prop('disabled', disabled);
  }

  function finalizeActiveBatch(reason) {
    if (!actionInProgress || batchFinalizeScheduled) {
      return;
    }

    batchFinalizeScheduled = true;
    logClient('Finalizing batch', { reason: reason, requestId: activeBatchRequestId }, 'debug', 'sse');

    if (currentEventSource) {
      currentEventSource.close();
      currentEventSource = null;
    }

    activeBatchRequestId = '';
    setActionInProgress(false);
    scheduleTransferStateSync();
    batchFinalizeScheduled = false;
  }

  function signalBatchComplete(requestId) {
    if (!requestId) {
      finalizeActiveBatch('missing_request_id');
      return;
    }

    requestAction('signalBatchComplete', { requestId: requestId }).catch(function (err) {
      logClient('Failed to signal batch complete', { requestId: requestId, error: String(err) }, 'debug', 'sse');
      setTimeout(function () {
        finalizeActiveBatch('signal_fallback_timeout');
      }, 2000);
    });
  }

  function listenForSSEUpdates(requestId) {
    if (currentEventSource) {
      currentEventSource.close();
    }

    sseUpdateCount = 0;
    var sseUrl = apiBase + '?action=listenUpdates&requestId=' + encodeURIComponent(requestId);
    currentEventSource = new EventSource(sseUrl);

    currentEventSource.addEventListener('containerUpdate', function (event) {
      try {
        var update = JSON.parse(event.data);
        if (update.type === 'connect' && update.success) {
          sseUpdateCount++;
          updateTransferStateAfterConnect([update.item]);
        } else if (update.type === 'disconnect' && update.success) {
          sseUpdateCount++;
          updateTransferStateAfterDisconnect([update.item]);
        }
        logClient('SSE update received', { type: update.type, success: update.success }, 'debug', 'sse');
      } catch (e) {
        logClient('SSE parse error', { error: String(e) }, 'debug', 'sse');
      }
    });

    currentEventSource.addEventListener('complete', function (event) {
      if (requestId !== activeBatchRequestId) {
        return;
      }
      logClient('SSE stream completed', {}, 'debug', 'sse');
      finalizeActiveBatch('sse_complete');
    });

    currentEventSource.addEventListener('error', function (event) {
      var state = currentEventSource ? currentEventSource.readyState : null;
      logClient('SSE error', { readyState: state }, 'debug', 'sse');
      if (currentEventSource && currentEventSource.readyState === EventSource.CLOSED) {
        currentEventSource.close();
        currentEventSource = null;
      }
    });
  }

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
    var attempts = [];

    return items.reduce(function (chain, item) {
      return chain.then(function () {
        return executor(item).then(function (data) {
          var payload = data || {};
          var successEntry = { item: item, data: payload };
          successes.push(successEntry);
          attempts.push({
            item: item,
            status: 'success',
            data: payload,
            message: payload.message || ''
          });
        }).catch(function (error) {
          var errorText = String(error || 'Unknown error');
          var failureEntry = { item: item, error: errorText };
          failures.push(failureEntry);
          attempts.push({
            item: item,
            status: 'failed',
            error: errorText,
            message: errorText
          });
        });
      });
    }, Promise.resolve()).then(function () {
      return { successes: successes, failures: failures, attempts: attempts };
    });
  }

  function resolveBatchTitle(baseVerb, result) {
    var total = result.attempts.length;
    var successCount = result.successes.length;

    if (successCount === 0 && total > 0) {
      return baseVerb + ' Failed';
    }
    if (successCount < total) {
      return baseVerb + ' Incomplete';
    }
    return baseVerb + ' Complete';
  }

  function estimateBatchPopupWidth(result) {
    var maxNameLen = 0;
    var maxDetailLen = 0;

    (result.attempts || []).forEach(function (entry) {
      var name = entry && entry.item ? (entry.item.name || entry.item.id || '') : '';
      var detail = entry && entry.message ? String(entry.message) : '';
      maxNameLen = Math.max(maxNameLen, String(name).length);
      maxDetailLen = Math.max(maxDetailLen, String(detail).length);
    });

    var width = 420;
    width += Math.min(180, maxNameLen * 5);
    width += Math.min(360, maxDetailLen * 3.5);

    return width;
  }

  function showBatchResult(baseVerb, actionWord, result, onClose) {
    var total = result.attempts.length;
    var successCount = result.successes.length;
    var failureCount = result.failures.length;
    var title = resolveBatchTitle(baseVerb, result);
    var html = '<div class="swal-text-block">';
    html += '<strong>' + successCount + ' of ' + total + '</strong> container(s) ' + escapeHtml(actionWord) + '.';
    if (failureCount > 0) {
      html += '<br><strong class="dn-failure-summary">' + failureCount + ' of ' + total + ' failed.</strong>';
    }

    html += '<br><br><strong>Attempt report:</strong>';
    html += '<div class="dn-attempt-table-wrap">';
    html += '<table class="dn-attempt-table">';
    html += '<thead><tr><th>Status</th><th>Container</th><th>Details</th></tr></thead>';
    html += '<tbody>';
    result.attempts.forEach(function (entry) {
      var name = entry.item && (entry.item.name || entry.item.id) ? (entry.item.name || entry.item.id) : 'Unknown';
      var isSuccess = entry.status === 'success';
      var iconClass = isSuccess ? 'dn-attempt-icon dn-attempt-icon-success' : 'dn-attempt-icon dn-attempt-icon-failed';
      var symbol = isSuccess ? '&#10003;' : '&#10005;';
      var statusLabel = isSuccess ? 'Success' : 'Failed';
      var detail = entry.message ? String(entry.message) : 'No details';
      html += '<tr>';
      html += '<td><span class="' + iconClass + '" title="' + statusLabel + '">' + symbol + '</span></td>';
      html += '<td>' + escapeHtml(name) + '</td>';
      html += '<td>' + escapeHtml(detail) + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    html += '</div>';

    html += '</div>';
    showActionResult(title, html, failureCount === 0, onClose, {
      preferredWidth: estimateBatchPopupWidth(result)
    });
  }

  function updateTransferStateAfterConnect(successfulItems) {
    // Remove successfully connected items from available list
    manageTransferState.available = manageTransferState.available.filter(function (availItem) {
      return !successfulItems.some(function (succItem) {
        return succItem.id === availItem.id;
      });
    });

    // Add successfully connected items to attached list (mark as not scheduled since they're now connected)
    successfulItems.forEach(function (item) {
      var existing = manageTransferState.attached.find(function (attItem) {
        return attItem.id === item.id;
      });

      if (!existing) {
        var isScheduledOnly = !!item.scheduledOnly;
        var resolvedAddress = isScheduledOnly
          ? 'Will connect on startup'
          : (item.ipAddress && item.ipAddress !== 'auto-assigned' ? item.ipAddress : (item.ipAddress || 'N/A'));
        manageTransferState.attached.push({
          id: item.id,
          name: item.name,
          address: resolvedAddress,
          scheduledOnly: isScheduledOnly
        });
      } else {
        // Update item mode from incoming result.
        existing.scheduledOnly = !!item.scheduledOnly;
        existing.address = existing.scheduledOnly
          ? 'Will connect on startup'
          : (item.ipAddress && item.ipAddress !== 'auto-assigned' ? item.ipAddress : (item.ipAddress || 'N/A'));
      }
    });

    // Re-sort and re-render
    manageTransferState.attached.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    renderTransferSelect('#availableContainersSelect', manageTransferState.available, 'available');
    renderTransferSelect('#attachedContainersSelect', manageTransferState.attached, 'attached');

  }

  function updateTransferStateAfterDisconnect(successfulItems) {
    // Remove successfully disconnected items from attached list
    manageTransferState.attached = manageTransferState.attached.filter(function (attItem) {
      return !successfulItems.some(function (succItem) {
        return succItem.id === attItem.id;
      });
    });

    // Add successfully disconnected items back to available list
    successfulItems.forEach(function (item) {
      var containerMeta = findContainerMeta(item);
      var existing = manageTransferState.available.find(function (availItem) {
        return availItem.id === item.id;
      });

      if (!existing) {
        manageTransferState.available.push({
          id: item.id,
          name: item.name,
          address: containerMeta && containerMeta.state ? containerMeta.state : '',
          scheduledOnly: false
        });
      }
    });

    // Re-sort and re-render
    manageTransferState.available.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    renderTransferSelect('#availableContainersSelect', manageTransferState.available, 'available');
    renderTransferSelect('#attachedContainersSelect', manageTransferState.attached, 'attached');

  }

  function connectContainersBatch(items, ipAddress) {
    if (actionInProgress) {
      return;
    }

    if (!currentNetwork || !currentNetwork.Id) {
      showActionResult('Error', '<div class="swal-text-block">No selected network</div>', false);
      return;
    }

    if (!items.length) {
      showActionResult('Nothing Selected', '<div class="swal-text-block">Select one or more containers to attach.</div>', false);
      return;
    }

    setActionInProgress(true);
    var requestId = 'connect-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    activeBatchRequestId = requestId;
    batchFinalizeScheduled = false;
    listenForSSEUpdates(requestId);

    runSequential(items, function (item) {
      var meta = findContainerMeta(item);
      var payload = {
        networkId: currentNetwork.Id,
        containerId: item.id,
        requestId: requestId
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
        if (sseUpdateCount === 0) {
          // Fallback for environments where SSE events are unavailable
          updateTransferStateAfterConnect(result.successes.map(function (s) {
            var data = s.data || {};
            var isScheduledOnly = data.ipAddress === 'pending' || (data.message && String(data.message).toLowerCase().indexOf('startup') !== -1);
            return {
              id: s.item.id,
              name: s.item.name,
              scheduledOnly: isScheduledOnly,
              ipAddress: data.ipAddress || ''
            };
          }));
        }
      }

      showBatchResult('Attach', 'attached', result);
    }).catch(function (err) {
      logClient('Connect batch failed', { error: String(err) }, 'error', 'api');
      showActionResult('Error', '<div class="swal-text-block">Failed to attach containers</div>', false);
    }).finally(function () {
      signalBatchComplete(requestId);
    });
  }

  function disconnectContainersBatch(items) {
    if (actionInProgress) {
      return;
    }

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
      setActionInProgress(true);
      var requestId = 'disconnect-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      activeBatchRequestId = requestId;
      batchFinalizeScheduled = false;
      listenForSSEUpdates(requestId);

      runSequential(items, function (item) {
        var payload = {
          networkId: currentNetwork.Id,
          containerId: item.id,
          requestId: requestId
        };
        if (item.name) {
          payload.containerName = item.name;
        }
        return requestAction('disconnect', payload);
      }).then(function (result) {
        if (result.successes.length > 0) {
          if (sseUpdateCount === 0) {
            // Fallback for environments where SSE events are unavailable
            updateTransferStateAfterDisconnect(result.successes.map(function (s) { return s.item; }));
          }
        }

        showBatchResult('Detach', 'detached', result);
      }).catch(function (err) {
        logClient('Disconnect batch failed', { error: String(err) }, 'error', 'api');
        showActionResult('Error', '<div class="swal-text-block">Failed to detach containers</div>', false);
      }).finally(function () {
        signalBatchComplete(requestId);
      });
    });
  }

  function moveSelectedRight() {
    if (actionInProgress) {
      return;
    }

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
    if (actionInProgress) {
      return;
    }

    if (!manageTransferState.available.length) {
      showActionResult('Nothing to Add', '<div class="swal-text-block">No available containers to attach.</div>', false);
      return;
    }

    var confirmHtml = '<div class="swal-text-block">Attach <strong>' + manageTransferState.available.length + '</strong> container(s) to <strong>' + escapeHtml(currentNetwork.Name || currentNetwork.Id) + '</strong>?</div>';
    confirmAction('Attach All Containers', confirmHtml, 'Attach All', function () {
      connectContainersBatch(manageTransferState.available.slice(), '');
    });
  }

  function moveSelectedLeft() {
    if (actionInProgress) {
      return;
    }

    disconnectContainersBatch(getSelectedTransferItems('attached'));
  }

  function moveAllLeft() {
    if (actionInProgress) {
      return;
    }

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
    var networkId = currentNetwork ? currentNetwork.Id : null;
    loadNetworks({ refreshContainers: true }).then(function () {
      // Reload scheduled networks after containers are loaded
      if (networkId) {
        return loadScheduledNetworks(networkId);
      }
    }).then(function () {
      // Re-render the modal with updated scheduled networks
      refreshManageModal();
    }).catch(function (err) {
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

  function updateManageNetworkDetails(event) {
    event.preventDefault();
    if (!currentNetwork || !currentNetwork.Id) {
      showActionResult('Update Failed', '<div class="swal-text-block">No selected network</div>', false);
      return;
    }

    var payload = {
      id: currentNetwork.Id,
      description: $('#manageNetworkDesc').val()
    };

    apiCall('update', payload, function (data) {
      if (data.success) {
        logClient('Network updated', { id: payload.id }, 'info', 'network');
        showActionResult('Updated', '<div class="swal-text-block">Network updated</div>', true, function () {
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

    $('#docker-networks-page').on('click', '.dn-page-action', function () {
      var action = $(this).data('action');

      if (action === 'create') {
        openCreateModal();
        return;
      }

      if (action === 'refresh') {
        if (actionInProgress || $('#manageModal').is(':visible')) {
          return;
        }
        loadNetworks({ showLoading: true, refreshContainers: !!currentNetwork });
        return;
      }

      if (action === 'settings') {
        window.location.href = pluginSettingsUrl;
      }
    });
    $('#closeCreateModal').on('click', closeCreateModal);
    $('#btnCancelCreate').on('click', closeCreateModal);
    $('#closeManageModal').on('click', closeManageModal);
    $('#btnCloseManage').on('click', closeManageModal);
    $('#btnMoveSelectedRight').on('click', moveSelectedRight);
    $('#btnMoveAllRight').on('click', moveAllRight);
    $('#btnMoveSelectedLeft').on('click', moveSelectedLeft);
    $('#btnMoveAllLeft').on('click', moveAllLeft);

    $('#createNetworkForm').on('submit', createNetwork);
  $('#manageNetworkDetailsForm').on('submit', updateManageNetworkDetails);

    loadNetworks({ showLoading: true, refreshContainers: false }).catch(function () {
      return undefined;
    });
    loadContainers();
    logClient('Docker Networks UI initialized', { refreshMs: refreshMs }, 'info', 'ui');
    setInterval(function () {
      if (actionInProgress || $('#manageModal').is(':visible')) {
        return;
      }
      loadNetworks({ refreshContainers: !!currentNetwork }).catch(function () {
        return undefined;
      });
    }, refreshMs);
  });
})();