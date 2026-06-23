(function () {
    function init() {
        var toggle = window.document.getElementById('docker-networks-active-only-toggle');
        if (!toggle) {
            dnLogError('Failed to find active-only toggle element for dashboard card', { cardId: 'docker-networks-active-only-toggle', toggle: toggle }, 'dashboard');
            return;
        }

        function applyFilter() {
            var activeOnly = !!toggle.checked;

            var rows = window.document.querySelectorAll('tr.dn-dash-network-row');
            rows.forEach(function (row) {
                var count = parseInt(row.getAttribute('data-connections') || '0', 10);
                row.style.display = (!activeOnly || count > 0) ? '' : 'none';
            });
        }

        if (window.jQuery) {
            var $toggle = window.jQuery('#docker-networks-active-only-toggle');
            if (typeof $toggle.switchButton === 'function' && !$toggle.data('switchbutton-initialized')) {
                $toggle.switchButton({
                    labels_placement: 'right',
                    off_label: 'All Networks',
                    on_label: 'Active only',
                    checked: false
                });
                $toggle.data('switchbutton-initialized', true);
                dnLogDebug('Initialized switchButton for active-only toggle', { cardId: 'docker-networks-active-only-toggle', toggle: $toggle }, 'dashboard');
            }

            $toggle.off('change.dndash').on('change.dndash', applyFilter);
            dnLogDebug('Attached change event handler for active-only toggle', { cardId: 'docker-networks-active-only-toggle', toggle: $toggle }, 'dashboard');
        } else {
            toggle.removeEventListener('change', applyFilter);
            toggle.addEventListener('change', applyFilter);
            dnLogDebug('Attached change event listener for active-only toggle', { cardId: 'docker-networks-active-only-toggle', toggle: toggle }, 'dashboard');
        }

        applyFilter();
    }

    // Try for a short period in case the dashboard HTML is injected after this script loads.
    var tries = 25; // ~1.25s with 50ms interval
    var t = window.setInterval(function () {
        if (window.document.getElementById('docker-networks-active-only-toggle')) {
            window.clearInterval(t);
            init();
            return;
        }
        tries--;
        if (tries <= 0) {
            window.clearInterval(t);
            init(); // will log the error
        }
    }, 50);
}());
