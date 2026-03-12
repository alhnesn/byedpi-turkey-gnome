import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const BYEDPICTL_PATH = '/usr/local/bin/byedpictl';
const PROFILES_DIR = '/etc/byedpictl/profiles';
const DESYNC_CONF = '/etc/byedpictl/desync.conf';
const TUN_IFACE_PATH = '/sys/class/net/byedpi-tun';
const POLL_INTERVAL_SECS = 5;

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const ByeDPIToggle = GObject.registerClass(
class ByeDPIToggle extends QuickSettings.QuickMenuToggle {
    _init() {
        super._init({
            title: 'ByeDPI',
            subtitle: 'Checking\u2026',
            iconName: 'network-vpn-symbolic',
            toggleMode: true,
        });

        this._isTransitioning = false;
        this._destroyed = false;

        this.menu.setHeader('network-vpn-symbolic', 'ByeDPI Turkey', 'DPI Bypass');

        this._profileSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profileSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const restartItem = new PopupMenu.PopupMenuItem('Restart');
        restartItem.connect('activate', () => this._restart());
        this.menu.addMenuItem(restartItem);

        this.connect('clicked', () => this._onToggled());

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._loadProfiles();
                this._detectActiveProfile();
            }
        });

        this._loadProfiles();
        this._updateStatus();

        this._pollSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECS, () => {
                this._updateStatus();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _isTunnelActive() {
        const tunFile = Gio.File.new_for_path(TUN_IFACE_PATH);
        return tunFile.query_exists(null);
    }

    _updateStatus() {
        if (this._destroyed) return;

        const isActive = this._isTunnelActive();
        if (!this._isTransitioning) {
            this.checked = isActive;
            this.subtitle = isActive ? 'Connected' : 'Disconnected';
        }
        this._detectActiveProfile();
    }

    async _runCommand(...argv) {
        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            await proc.communicate_utf8_async(null, null);
            if (this._destroyed) return false;
            return proc.get_successful();
        } catch (e) {
            return false;
        }
    }

    async _runByedpictl(...args) {
        return this._runCommand('pkexec', BYEDPICTL_PATH, ...args);
    }

    async _onToggled() {
        if (this._isTransitioning) {
            this.checked = !this.checked;
            return;
        }

        this._isTransitioning = true;
        const action = this.checked ? 'start' : 'stop';
        this.subtitle = this.checked ? 'Starting\u2026' : 'Stopping\u2026';

        await this._runByedpictl('tun', action);

        if (!this._destroyed) {
            this._isTransitioning = false;
            this._updateStatus();
        }
    }

    async _restart() {
        if (this._isTransitioning) return;

        this._isTransitioning = true;
        this.subtitle = 'Restarting\u2026';

        await this._runByedpictl('tun', 'restart');

        if (!this._destroyed) {
            this._isTransitioning = false;
            this._updateStatus();
        }
    }

    _loadProfiles() {
        this._profileSection.removeAll();

        try {
            const dir = Gio.File.new_for_path(PROFILES_DIR);
            if (!dir.query_exists(null)) return;

            const enumerator = dir.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (!name.endsWith('.conf')) continue;

                const profileName = name.slice(0, -5);
                const item = new PopupMenu.PopupMenuItem(profileName);
                item.connect('activate', () => this._changeProfile(profileName));
                this._profileSection.addMenuItem(item);
            }
        } catch (e) {
            console.error(`ByeDPI: Failed to load profiles: ${e.message}`);
        }
    }

    _readFile(path) {
        try {
            const file = Gio.File.new_for_path(path);
            const [, bytes] = file.load_contents(null);
            return new TextDecoder().decode(bytes).trim();
        } catch (e) {
            return null;
        }
    }

    _detectActiveProfile() {
        const desyncText = this._readFile(DESYNC_CONF);
        if (!desyncText) return;

        const items = this._profileSection._getMenuItems();
        for (const item of items) {
            if (!item.label) continue;

            const profileText = this._readFile(
                `${PROFILES_DIR}/${item.label.text}.conf`
            );
            item.setOrnament(
                desyncText === profileText
                    ? PopupMenu.Ornament.CHECK
                    : PopupMenu.Ornament.NONE
            );
        }
    }

    async _changeProfile(profileName) {
        if (this._isTransitioning) return;

        const wasActive = this._isTunnelActive();
        this._isTransitioning = true;
        this.subtitle = `Switching to ${profileName}\u2026`;

        // byedpictl tun change has broken arg passing (drops profile name),
        // so we copy the profile file directly and restart if needed.
        if (wasActive) {
            await this._runCommand(
                'pkexec', 'bash', '-c',
                `cp "$1" "$2" && ${BYEDPICTL_PATH} tun restart`,
                '_',
                `${PROFILES_DIR}/${profileName}.conf`,
                DESYNC_CONF
            );
        } else {
            await this._runCommand(
                'pkexec', 'cp',
                `${PROFILES_DIR}/${profileName}.conf`,
                DESYNC_CONF
            );
        }

        if (!this._destroyed) {
            this._isTransitioning = false;
            this._updateStatus();
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._pollSourceId) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = null;
        }
        super.destroy();
    }
});

const ByeDPIIndicator = GObject.registerClass(
class ByeDPIIndicator extends QuickSettings.SystemIndicator {
    _init() {
        super._init();

        this._indicator = this._addIndicator();
        this._indicator.iconName = 'network-vpn-symbolic';
        this._indicator.visible = false;

        this._toggle = new ByeDPIToggle();
        this._toggle.bind_property('checked',
            this._indicator, 'visible',
            GObject.BindingFlags.SYNC_CREATE);

        this.quickSettingsItems.push(this._toggle);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class ByeDPIExtension extends Extension {
    enable() {
        this._indicator = new ByeDPIIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
