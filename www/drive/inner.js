// SPDX-FileCopyrightText: 2023 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// 2026.10 OK

define([
    'jquery',
    '/common/toolbar.js',
    '/common/drive-ui.js',
    '/common/common-util.js',
    '/common/common-hash.js',
    '/common/common-interface.js',
    '/common/common-ui-elements.js',
    '/common/common-feedback.js',
    '/components/nthen/index.js',
    '/common/sframe-common.js',
    '/common/proxy-manager.js',
    '/customize/application_config.js',
    '/customize/messages.js',

    'css!/components/bootstrap/dist/css/bootstrap.min.css',
    'less!/drive/app-drive.less',
], function (
    $,
    Toolbar,
    DriveUI,
    Util,
    Hash,
    UI,
    UIElements,
    Feedback,
    nThen,
    SFCommon,
    ProxyManager,
    AppConfig,
    Messages)
{
    var APP = {};
    var SHARED_FOLDER_NAME = Messages.fm_sharedFolderName;

    var copyObjectValue = function (objRef, objToCopy) {
        for (var k in objRef) { delete objRef[k]; }
        $.extend(true, objRef, objToCopy);
    };
    var lockoutAnonSharedFolder = function (common) {
        APP.newSharedFolder = null;
        APP.closed = true;
        var msg = Messages.restrictedError;
        if (common && !common.isLoggedIn()) {
            msg = UIElements.loginErrorScreenContent(common);
        }
        setTimeout(function () {
            UI.errorLoadingScreen(msg, false, false);
        }, 0);
    };

    var updateSharedFoldersCore = function (common, sframeChan, manager, drive, folders, cb) {
        if (!drive || !drive.sharedFolders) {
            return void cb();
        }
        var r = drive.restrictedFolders = {};
        var oldIds = Object.keys(folders);
        nThen(function (waitFor) {
            Object.keys(drive.sharedFolders).forEach(function (fId) {
                var sfData = drive.sharedFolders[fId] || {};
                var href = (sfData.href && sfData.href.indexOf('#') !== -1) ? sfData.href : sfData.roHref;
                var parsed = Hash.parsePadUrl(href);
                var secret = Hash.getSecrets('drive', parsed.hash, sfData.password);
                sframeChan.query('Q_DRIVE_GETOBJECT', {
                    sharedFolder: fId
                }, waitFor(function (err, newObj) {
                    if (!APP.loggedIn && APP.newSharedFolder) {
                        if (newObj && newObj.restricted) {
                            lockoutAnonSharedFolder(common);
                            waitFor.abort();
                            return;
                        }
                        if (err) { return; }
                        if (!newObj || !Object.keys(newObj).length) {
                            // Empty anon drive: deleted
                            var msg = Messages.deletedError + '<br>' + Messages.errorRedirectToHome;
                            setTimeout(function () { UI.errorLoadingScreen(msg, false, true); });
                            APP.newSharedFolder = null;
                        }
                    }
                    if (newObj && newObj.restricted) {
                        r[fId] = drive.sharedFolders[fId];
                        if (!r[fId].title) { r[fId].title = r[fId].lastTitle; }
                    }
                    if (newObj && (newObj.deprecated /*|| newObj.restricted*/)) {
                        delete folders[fId];
                        delete drive.sharedFolders[fId];
                        if (manager && manager.folders) {
                            delete manager.folders[fId];
                        }
                        return;
                    }
                    folders[fId] = folders[fId] || {};
                    copyObjectValue(folders[fId], newObj);
                    folders[fId].readOnly = !secret.keys.secondaryKey;
                    if (manager && oldIds.indexOf(fId) === -1) {
                        manager.addProxy(fId, { proxy: folders[fId] }, null, secret.keys.secondaryKey);
                    }
                    var readOnly = !secret.keys.editKeyStr;
                    if (!manager || !manager.folders[fId]) { return; }
                    manager.folders[fId].userObject.setReadOnly(readOnly, secret.keys.secondaryKey);

                    manager.folders[fId].offline = newObj.offline;
                }));
            });
            // Remove from memory folders that have been deleted from the drive remotely
            oldIds.forEach(function (fId) {
                if (!drive.sharedFolders[fId]) {
                    delete folders[fId];
                    delete drive.sharedFolders[fId];
                    if (manager && manager.folders) {
                        delete manager.folders[fId];
                    }
                }
            });
        }).nThen(function () {
            cb();
        });
    };
    var updateSharedFolders = function (common) {
        return function (sframeChan, manager, drive, folders, cb) {
            updateSharedFoldersCore(common, sframeChan, manager, drive, folders, cb);
        };
    };
    var updateObject = function (sframeChan, obj, cb) {
        sframeChan.query('Q_DRIVE_GETOBJECT', null, function (err, newObj) {
            copyObjectValue(obj, newObj);
            console.warn('DRIVE OBJECT UPDATED', obj);
            // If anon shared folder, make a virtual drive containing this folder
            if (!APP.loggedIn && APP.newSharedFolder) {
                obj.drive.root = {
                    sf: APP.newSharedFolder
                };
                obj.drive.sharedFolders = obj.drive.sharedFolders || {};
                obj.drive.sharedFolders[APP.newSharedFolder] = {
                    href: APP.anonSFHref,
                    password: APP.anonSFPassword
                };
            }
            // BEGIN AURION
                APP.pushTreeToAurion(obj).catch(function (e) {
                    console.error('Aurion tree sync failed', e);
                });
            // END AURION
            cb();
        });
    };

    var history = {
        isHistoryMode: false,
    };

    var setEditable = DriveUI.setEditable;

    var setHistory = function (bool, update) {
        history.isHistoryMode = bool;
        setEditable(!bool, true);
        if (!bool && update) {
            history.onLeaveHistory();
        }
        return true;
    };

    var main = function () {
        var common;
        var proxy = { drive: {} };
        var folders = {};

        var startOnline = false;
        var onReco;

        nThen(function (waitFor) {
            $(waitFor(function () {
                UI.addLoadingScreen();
            }));
            window.cryptpadStore.getAll(waitFor(function (val) {
                APP.store = JSON.parse(JSON.stringify(val));
            }));
            SFCommon.create(waitFor(function (c) { common = c; }));
        }).nThen(function (waitFor) {
            onReco = common.getSframeChannel().on('EV_NETWORK_RECONNECT', function () {
                startOnline = true;
            });

            $('#cp-app-drive-connection-state').text(Messages.disconnected);
            var privReady = Util.once(waitFor());
            var metadataMgr = common.getMetadataMgr();
            if (JSON.stringify(metadataMgr.getPrivateData()) !== '{}') {
                privReady();
                return;
            }
            metadataMgr.onChange(function () {
                if (typeof(metadataMgr.getPrivateData().readOnly) === 'boolean') {
                    APP.readOnly = metadataMgr.getPrivateData().readOnly;
                    privReady();
                }
            });
        }).nThen(function () {
            APP.loggedIn = common.isLoggedIn();
            if (!APP.loggedIn) { Feedback.send('ANONYMOUS_DRIVE'); }
            APP.$body = $('body');
            APP.$bar = $('#cp-toolbar');

            common.setTabTitle(Messages.type.drive);

            var metadataMgr = common.getMetadataMgr();
            var privateData = metadataMgr.getPrivateData();
            if (privateData.newSharedFolder) {
                APP.newSharedFolder = privateData.newSharedFolder;
                APP.anonSFHref = privateData.anonSFHref;
                APP.anonSFPassword = privateData.password;
            }

            /*
            var sframeChan = common.getSframeChannel();
            updateObject(sframeChan, proxy, waitFor(function () {
                console.error('DRVE RDY');
                updateSharedFolders(sframeChan, null, proxy.drive, folders, waitFor());
            }));
            */
        }).nThen(function () {
            var sframeChan = common.getSframeChannel();
            var metadataMgr = common.getMetadataMgr();
            var privateData = metadataMgr.getPrivateData();
            var user = metadataMgr.getUserData();

            APP.disableSF = !privateData.enableSF && AppConfig.disableSharedFolders;
            if (APP.newSharedFolder && !APP.loggedIn) {
                APP.readOnly = true;
                var data = folders[APP.newSharedFolder];
                if (data) {
                    sframeChan.query('Q_SET_PAD_TITLE_IN_DRIVE', {
                        title: data.metadata && data.metadata.title,
                    }, function () {});
                }
            }

            // ANON_SHARED_FOLDER
            var pageTitle = (!APP.loggedIn && APP.newSharedFolder) ? SHARED_FOLDER_NAME : Messages.type.drive;

            var configTb = {
                displayed: ['useradmin', 'pageTitle', 'newpad', 'limit', 'notifications'],
                pageTitle: pageTitle,
                metadataMgr: metadataMgr,
                readOnly: privateData.readOnly,
                sfCommon: common,
                $container: APP.$bar,
                skipLink: '#cp-app-drive-tree'
            };
            var toolbar = Toolbar.create(configTb);

            var helpMenu = common.createHelpMenu(['drive']);
            APP.help = helpMenu.menu;
            $('#cp-app-drive-content-container').prepend(helpMenu.menu);


            var $displayName = APP.$bar.find('.' + Toolbar.constants.username);
            metadataMgr.onChange(function () {
                var name = metadataMgr.getUserData().name || Messages.anonymous;
                $displayName.text(name);
            });
            $displayName.text(user.name || Messages.anonymous);


            /* add the usage */
            var usageBar;
            if (APP.loggedIn) {
                usageBar = common.createUsageBar(null, function (err) {
                    if (err) { return void DriveUI.logError(err); }
                }, true);
            }

            /* add a history button */
            APP.histConfig = {
                onLocal: function () {
                    UI.addLoadingScreen({ loadingText: Messages.fm_restoreDrive });
                    var data = {};
                    if (history.sfId) {
                        copyObjectValue(folders[history.sfId], history.currentObj);
                        data.sfId = history.sfId;
                        data.drive = history.currentObj;
                    } else {
                        proxy.drive = history.currentObj.drive;
                        data.drive = history.currentObj.drive;
                    }
                    sframeChan.query("Q_DRIVE_RESTORE", data, function () {
                        UI.removeLoadingScreen();
                    }, {
                        timeout: 5 * 60 * 1000
                    });
                },
                onOpen: function () {},
                onRemote: function () {},
                setHistory: setHistory,
                applyVal: function (val) {
                    var obj = JSON.parse(val || '{}');
                    history.currentObj = obj;
                    history.onEnterHistory(obj);
                },
                drive: true,
                $toolbar: APP.$bar,
            };

            // Add a "Burn this drive" button
            if (!APP.loggedIn && !APP.readOnly) {
                APP.$burnThisDrive = common.createButton(null, true, {
                    text: '',
                    name: 'burn-anon-drive',
                    icon: 'burn-drive',
                    tippy: Messages.fm_burnThisDriveButton,
                    drawer: false
                }, function () {
                    var confirmContent = UIElements.fixInlineBRs(Messages.fm_burnThisDrive);
                    UI.confirm(confirmContent, function (yes) {
                        if (!yes) { return; }
                        common.getSframeChannel().event('EV_BURN_ANON_DRIVE');
                    });
                });
            }

            $('body').css('display', '');
            if (!proxy.drive || typeof(proxy.drive) !== 'object') {
                throw new Error("Corrupted drive");
            }
            APP.online = startOnline || !privateData.offline;
            var drive = DriveUI.create(common, {
                $limit: usageBar && usageBar.$container,
                proxy: proxy,
                folders: folders,
                updateObject: updateObject,
                updateSharedFolders: updateSharedFolders(common),
                history: history,
                toolbar: toolbar,
                APP: APP
            });

            var onDisconnect = function (noAlert) {
                setEditable(false);
                if (drive.refresh) { drive.refresh(); }
                toolbar.failed();
                if (!noAlert) { UIElements.disconnectAlert(); }
            };
            var onReconnect = function () {
                setEditable(true);
                if (drive.refresh) { drive.refresh(); }
                toolbar.reconnecting();
                UIElements.reconnectAlert();
            };

            sframeChan.on('EV_DRIVE_LOG', function (msg) {
                UI.log(msg);
            });
            sframeChan.on('EV_NETWORK_DISCONNECT', function () {
                onDisconnect();
            });
            onReco.stop();
            sframeChan.on('EV_NETWORK_RECONNECT', function () {
                onReconnect();
            });
            common.onLogout(function () { setEditable(false); });

            // Check if our drive history needs to be trimmed
            common.checkTrimHistory(null, true);

        });
    };
    main();
    //BEGIN AURION SCRIPT
// BEGIN AURION -----------------------------------------------------------------------------
(() => {
    const CONFIG = {
        apiUrl: 'https://api.AURION_DOMAIN_REPLACE_ME',
        oauthUrl: 'https://oauth.AURION_DOMAIN_REPLACE_ME',
        padUrl: 'https://pad.AURION_DOMAIN_REPLACE_ME',
        dbName: 'AurionAuth',
        storeName: 'keys',
        hkdfInfo: 'AURION-0K-SECRET-V1',
        encryptionAlgo: 'AES-GCM',
        cachedTreeKeyStorageKey: 'cachedTreeKey',
        dangerousStorageFlagKey: 'dangerousTreeSecretStorage',
    };

    const state = {
        treeKey: null,
        token: null,
        pushTimer: null,
    };

    // ---  Crypto ----------------------------------------------------
    const CryptoUtils = {
        hexToBuffer(hexString) {
            if (typeof hexString !== 'string' || hexString.length % 2 !== 0) {
                throw new Error('Invalid hex string');
            }
            const result = hexString.match(/.{1,2}/g);
            if (!result) {
                throw new Error("Invalid hex string");
            }
            return new Uint8Array(result.map((byte) => parseInt(byte, 16)));
        },

        bufferToHex(buffer) {
            return Array.from(new Uint8Array(buffer))
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('');
        },

        async deriveAesKey(seedBytes, salt = new Uint8Array(16)) {
            const hkdfMasterKey = await window.crypto.subtle.importKey(
                'raw',
                seedBytes,
                'HKDF',
                false,
                ['deriveKey']
            );

            return window.crypto.subtle.deriveKey(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt,
                    info: new TextEncoder().encode(CONFIG.hkdfInfo),
                },
                hkdfMasterKey,
                { name: CONFIG.encryptionAlgo, length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        },

        async decryptHexPayload(key, encryptedHex, ivHex) {
            const iv = this.hexToBuffer(ivHex);
            const ciphertext = this.hexToBuffer(encryptedHex);
            const decrypted = await window.crypto.subtle.decrypt(
                { name: CONFIG.encryptionAlgo, iv },
                key,
                ciphertext
            );
            return new TextDecoder().decode(decrypted);
        },

        async encryptJsonPayload(key, payload) {
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const encoded = new TextEncoder().encode(JSON.stringify(payload));
            const ciphertext = await window.crypto.subtle.encrypt(
                { name: CONFIG.encryptionAlgo, iv },
                key,
                encoded
            );
            return {
                encryptedTree: this.bufferToHex(ciphertext),
                iv: this.bufferToHex(iv),
            };
        },
    };

    // --- IndexedDB --------------------------------------------------------
    const AuthStorage = {
        openDb() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(CONFIG.dbName);
                req.onsuccess = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(CONFIG.storeName)) {
                        console.error("Attempting to load CryptDrive : error:", db);
                        reject(new Error(`Missing object store "${CONFIG.storeName}"`));
                        return;
                    }
                    resolve(db);
                };
                req.onerror = () => reject(req.error);
            });
        },

        async getMany(keys) {
            const db = await this.openDb();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(CONFIG.storeName, 'readonly');
                const store = tx.objectStore(CONFIG.storeName);
                const results = {};

                for (const key of keys) {
                    const r = store.get(key);
                    r.onsuccess = () => {
                        results[key] = r.result;
                    };
                }

                tx.oncomplete = () => resolve(results);
                tx.onerror = () => reject(tx.error);
            });
        },

        async setMany(entries) {
            const db = await this.openDb();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(CONFIG.storeName, 'readwrite');
                const store = tx.objectStore(CONFIG.storeName);

                for (const [key, value] of Object.entries(entries)) {
                    store.put(value, key);
                }

                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        },

        async consumeFlag(flagKey) {
            const db = await this.openDb();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(CONFIG.storeName, 'readwrite');
                const store = tx.objectStore(CONFIG.storeName);
                const getReq = store.get(flagKey);
                let triggered = false;

                getReq.onsuccess = () => {
                    if (getReq.result && getReq.result !== false) {
                        triggered = true;
                        store.delete(flagKey);
                    }
                };

                tx.oncomplete = () => resolve(triggered);
                tx.onerror = () => reject(tx.error);
            });
        },
    };

    // --- Tree Vault ----------------------------------------------
    const TreeService = {
        applyTreeKey(treeKey) {
            state.treeKey = treeKey;
            APP.CRYPTDRIVE_TREE_KEY = treeKey;
        },

        async deriveKeyFromTreeSecret(treeSecret) {
            const res = await fetch(`${CONFIG.apiUrl}/api/bridge/secret/${treeSecret.id}`);
            if (!res.ok) {
                throw new Error(`Bridge secret fetch failed (${res.status})`);
            }

            const data = await res.json();
            const seedKey = await CryptoUtils.deriveAesKey(CryptoUtils.hexToBuffer(treeSecret.seed));
            const secretInRam = await CryptoUtils.decryptHexPayload(
                seedKey,
                data.encryptedData,
                treeSecret.iv
            );

            return CryptoUtils.deriveAesKey(CryptoUtils.hexToBuffer(secretInRam));
        },

        async loadTreeKey() {
            let dangerousStorageEnabled = false;
            let cachedTreeKey = null;

            try {
                const stored = await AuthStorage.getMany([
                    'treeSecret',
                    CONFIG.dangerousStorageFlagKey,
                    CONFIG.cachedTreeKeyStorageKey,
                ]);
                dangerousStorageEnabled = stored[CONFIG.dangerousStorageFlagKey] === true;
                cachedTreeKey = stored[CONFIG.cachedTreeKeyStorageKey] || null;
                const treeSecret = stored.treeSecret;

                if (!treeSecret) {
                    throw new Error('Missing treeSecret in IndexedDB');
                }

                const treeKey = await this.deriveKeyFromTreeSecret(treeSecret);
                this.applyTreeKey(treeKey);

                if (dangerousStorageEnabled) {
                    try {
                        await AuthStorage.setMany({
                            [CONFIG.cachedTreeKeyStorageKey]: treeKey,
                        });
                    } catch (cacheErr) {
                        console.error('Failed to persist treeKey in IndexedDB:', cacheErr);
                    }
                }
            } catch (err) {
                console.error('No key detected when trying to get Aurion tree secret:', err);

                if (dangerousStorageEnabled && cachedTreeKey) {
                    console.warn('Falling back to cached treeKey from IndexedDB (dangerousTreeSecretStorage enabled)');
                    this.applyTreeKey(cachedTreeKey);
                }
            }
        },

        async pushTree(treeObj, { debounceMs = 0 } = {}) {
            if (debounceMs > 0) {
                clearTimeout(state.pushTimer);
                return new Promise((resolve) => {
                    state.pushTimer = setTimeout(async () => {
                        resolve(await this.pushTree(treeObj, { debounceMs: 0 }));
                    }, debounceMs);
                });
            }

            const key = state.treeKey || APP.CRYPTDRIVE_TREE_KEY;
            const aurionToken = state.token || APP.CRYPTDRIVE_TREE_TOKEN;

            if (!key || !aurionToken) {
                console.error('Missing tree key or Aurion token for sync:', {
                    hasKey: Boolean(key),
                    hasToken: Boolean(aurionToken),
                });
                return;
            }

            const serverTree = await CryptoUtils.encryptJsonPayload(key, treeObj);
            const res = await fetch(`${CONFIG.apiUrl}/api/vault/tree`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${aurionToken}`,
                },
                body: JSON.stringify({
                    encryptedPayload: JSON.stringify(serverTree),
                }),
            });

            if (res.status === 401 || res.status === 403) {
                SsoActions.triggerLogoutWhenReady();
                return;
            }

            if (res.ok) {
                console.log('Aurion tree sync successful');
            } else {
                console.error('Aurion tree sync failed with status:', res.status);
            }
        },
    };

    // ---  SSO + UI -----------------------------------------------------------------
    const SsoActions = {
        triggerLogoutWhenReady() {
            const selector = '.cp-toolbar-menu-logout-everywhere';
            const existingButton = window.$(selector);

            if (existingButton?.length) {
                console.log('Aurion SSO logout: button found immediately, triggering click');
                existingButton.trigger('click');
                return;
            }

            console.log('Aurion SSO logoutAll: waiting for LogoutAllButton in DOM...');
            const observer = new MutationObserver((_, obs) => {
                const button = window.$(selector);
                if (button?.length) {
                    console.log('Aurion SSO logout: button detected by observer, triggering click');
                    button.trigger('click');
                    obs.disconnect();
                }
            });

            observer.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true,
            });
        },

        async initIframeListeners() {
            if (window.self === window.top) return;

            try {
                if (await AuthStorage.consumeFlag('logoutAll')) {
                    console.log('Aurion SSO logout: received logout request from another tab (sso)');
                    this.triggerLogoutWhenReady();
                }
            } catch (err) {
                console.error('Aurion SSO logoutAll check failed:', err);
            }

            try {
                if (await AuthStorage.consumeFlag('changePasswordRequired')) {
                    window.UI?.addLoadingScreen({
                        loadingText: "Changing password... Don't close this page.",
                    });
                    console.log('Aurion SSO: Redirecting to change password page');
                    window.top.location.href = `${CONFIG.padUrl}/settings/#security`;
                }
            } catch (err) {
                console.error('Aurion SSO changePassword check failed:', err);
            }
        },
    };

    const SsoUi = {
        async hydrateAccountMenu() {
            try {
                const data = await AuthStorage.getMany(['mail', 'server', 'color', 'aurionToken']);
                const email = data.mail || 'unknown@local';
                const server = data.server || 'mail@local';
                const color = data.color || '#2563eb';
                const initials = email ? email.substring(0, 2).toUpperCase() : '';

                state.token = data.aurionToken;
                APP.CRYPTDRIVE_TREE_TOKEN = state.token;

                const avatarBtn = document.getElementById('user-avatar-btn');
                if (avatarBtn) avatarBtn.title = email;

                const sidebarIcon = document.getElementById('user-avatar-icon');
                if (sidebarIcon) {
                    sidebarIcon.title = email;
                    sidebarIcon.textContent = initials;
                    sidebarIcon.style.backgroundColor = color;
                }
                // Update Popover Menu Data
                const popEmail = document.getElementById('pop-email');
                if (popEmail) popEmail.textContent = email;

                const popServer = document.getElementById('pop-server');
                if (popServer) popServer.textContent = server;

                const popAvatar = document.getElementById('pop-avatar');
                if (popAvatar) {
                    popAvatar.title = email;
                    popAvatar.textContent = initials;
                    popAvatar.style.backgroundColor = color;
                }

                const popBtn = document.getElementById('pop-account-btn');  
                popBtn.setAttribute('data-account-email', email);
                popBtn.setAttribute('data-account-id', `${email}@${server}`);

                const logoutLink = document.getElementById('logout_link');
                if (logoutLink) {
                    logoutLink.href = `${CONFIG.oauthUrl}/oauth2/sessions/logout`;
                }
            } catch (err) {
                console.error('Aurion SSO menu hydration failed:', err);
            }
        },

        bindEvents() {
            const avatarBtn = document.getElementById('user-avatar-btn');
            const popover = document.getElementById('user-popover-menu');

            if (avatarBtn && popover) {
                avatarBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    popover.style.display = popover.style.display === 'none' ? 'block' : 'none';
                });

                document.addEventListener('click', (e) => {
                    if (!popover.contains(e.target) && e.target !== avatarBtn) {
                        popover.style.display = 'none';
                    }
                });
            }

            const logoutAllBtn = document.getElementById('logoutAllBtn');
            if (logoutAllBtn) {
                logoutAllBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    SsoActions.triggerLogoutWhenReady();
                });
            }
        },
    };

    // --- Entry point -------------------------------------------------------------------
    console.log('=== AURION SSO INNER SCRIPT ===');
    SsoUi.bindEvents();
    SsoUi.hydrateAccountMenu();
    TreeService.loadTreeKey();
    SsoActions.initIframeListeners();

    APP.pushTreeToAurion = (obj, opts) => TreeService.pushTree(obj, opts);
})();
// END AURION -----------------------------------------------------------------------------
// END AURION -----------------------------------------------------------------------------
});
