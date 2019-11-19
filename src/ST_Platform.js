const {
    knownCapabilities,
    pluginName,
    platformName,
    pluginVersion
} = require("./Constants");
const myUtils = require('./MyUtils'),
    SmartThingsClient = require('./ST_Client'),
    SmartThingsAccessories = require('./Accessories/ST_Accessories'),
    express = require('express'),
    bodyParser = require('body-parser'),
    logger = require('./Logger.js').Logger,
    webApp = express();

var PlatformAccessory;

module.exports = class ST_Platform {
    constructor(log, config, api) {
        this.config = config;
        this.homebridge = api;
        this.log = logger.withPrefix(`${this.config['name']}`);
        this.logFile = logger.withPrefix(`${this.config['name']} ${pluginVersion}`);
        this.log(`Homebridge Version: ${api.version}`);
        this.log(`${platformName} Plugin Version: ${pluginVersion}`);
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        PlatformAccessory = api.platformAccessory;
        this.uuid = api.hap.uuid;
        if (config === undefined || config === null || config.app_url === undefined || config.app_url === null || config.app_id === undefined || config.app_id === null) {
            log.debug(platformName + " Plugin not configured. Skipping");
            return;
        }
        this.polling_seconds = config['polling_seconds'] || 3600;
        this.excludedAttributes = this.config["excluded_attributes"] || [];
        this.excludedCapabilities = this.config["excluded_capabilities"] || [];
        this.update_method = this.config['update_method'] || 'direct';
        this.temperature_unit = 'F';
        this.local_commands = false;
        this.local_hub_ip = undefined;
        this.myUtils = new myUtils(this);
        this.configItems = this.getConfigItems();

        this.deviceCache = {};
        this.attributeLookup = {};
        this.knownCapabilities = knownCapabilities;
        this.unknownCapabilities = [];
        this.client = new SmartThingsClient(this);

        this.SmartThingsAccessories = new SmartThingsAccessories(this);

        this.homebridge.on('didFinishLaunching', function() {
            this.didFinishLaunching();
        }.bind(this));
    }

    getConfigItems() {
        return {
            app_url: this.config['app_url'],
            app_id: this.config['app_id'],
            access_token: this.config['access_token'],
            update_seconds: this.config['update_seconds'] || 30,
            direct_port: this.config['direct_port'] || 8000,
            direct_ip: this.config['direct_ip'] || this.myUtils.getIPAddress()
        };
    }

    getDeviceCache() {
        return this.deviceCache || {};
    }
    getDeviceCacheItem(devid) {
        return this.deviceCache[devid] || undefined;
    }

    updDeviceCacheItem(devid, data) {
        this.deviceCache[devid] = data;
    }

    remDeviceCacheItem(devid) {
        delete this.deviceCache[devid];
    }

    didFinishLaunching() {
        this.log(`Fetching ${platformName} Devices. NOTICE: This may take a moment if you have a large number of devices being loaded!`);
        setInterval(this.refreshDevices.bind(this), this.polling_seconds * 1000);
        let that = this;
        this.refreshDevices()
            .then(() => {
                that.WebServerInit(that)
                    .catch((err) => that.log.error('WebServerInit Error: ', err))
                    .then((resp) => {
                        if (resp === 'OK')
                            that.client.startDirect(null);
                    });
            }).catch((err) => {
                that.log.error(err);
            });
    }

    refreshDevices() {
        let that = this;
        let starttime = new Date();
        return new Promise((resolve) => {
            try {
                that.log.debug('Refreshing All Device Data');
                this.client.getDevices()
                    .then(resp => {
                        // console.log(resp);
                        if (resp && resp.deviceList && resp.deviceList instanceof Array) {
                            that.log.debug('Received All Device Data');
                            const toAdd = this.SmartThingsAccessories.diffAdd(resp.deviceList);
                            const toUpdate = this.SmartThingsAccessories.intersection(resp.deviceList);
                            const toRemove = this.SmartThingsAccessories.diffRemove(resp.deviceList);
                            that.log.warn('Devices to Remove:', toRemove.map(i => i.name));
                            that.log.info('Devices to Update:', toUpdate.map(i => i.name));
                            that.log.info('Devices to Create:', toAdd.map(i => i.name));

                            toRemove.forEach(accessory => this.removeAccessory(accessory));
                            toUpdate.forEach(device => this.updateDevice(device));
                            toAdd.forEach(device => this.addDevice(device));
                        };
                        if (resp && resp.location) {
                            that.temperature_unit = resp.location.temperature_scale;
                            if (resp.location.hubIP) {
                                that.local_hub_ip = resp.location.hubIP;
                                that.local_commands = (resp.location.local_commands === true);
                                that.client.updateGlobals(that.local_hub_ip, that.local_commands);
                            }
                        }
                        that.log(`Total Device Initialization Process Time: (${Math.round((new Date() - starttime) / 1000)} seconds)`);
                        that.log(`Unknown Capabilities: ${JSON.stringify(that.unknownCapabilities)}`);
                        that.log(`DeviceCache Size: (${Object.keys(this.SmartThingsAccessories.getAll()).length})`);
                        resolve(true);
                    })
                    .catch((err) => {
                        that.log.error(err);
                        resolve(false);
                    });
            } catch (e) {
                this.log.error("Failed to refresh devices.", e);
                resolve(false);
            }
        });
    }

    getNewAccessory(device, UUID) {
        let accessory = new PlatformAccessory(device.name, UUID);
        this.SmartThingsAccessories.PopulateAccessory(accessory, device);
        return accessory;
    }

    addDevice(device) {
        let accessory;
        const new_uuid = this.uuid.generate(`smartthings_v2_${device.deviceid}`);
        device.excludedCapabilities = this.excludedCapabilities[device.deviceid] || ["None"];
        this.log(`Initializing New Device (${device.name} | ${device.deviceid})`);
        accessory = this.getNewAccessory(device, new_uuid);
        accessory.reachable = true;
        this.homebridge.registerPlatformAccessories(pluginName, platformName, [accessory]);
        this.SmartThingsAccessories.add(accessory);
        this.log(`Added Device: (${accessory.name} | ${accessory.deviceid})`);
    }

    updateDevice(device) {
        let cacheDevice = this.SmartThingsAccessories.get(device);
        let accessory;
        device.excludedCapabilities = this.excludedCapabilities[device.deviceid] || ["None"];
        this.log(`Loading Existing Device (${device.name}) | (${device.deviceid})`);
        accessory = this.SmartThingsAccessories.updateAccessoryState(cacheDevice, device);
        accessory.reachable = true;
        this.SmartThingsAccessories.add(accessory);
    }

    ignoreDevice(data) {
        const [device, reason] = data;
        if (!this.SmartThingsAccessories.ignore(device)) {
            return;
        }
        this.log(`${reason}: ${device.name} (${device.deviceid})`);
    }

    removeAccessory(accessory) {
        this.log(accessory);
        if (this.SmartThingsAccessories.remove(accessory)) {
            this.homebridge.unregisterPlatformAccessories(pluginName, platformName, [accessory]);
            this.log(`Removed: ${accessory.context.name} (${accessory.context.deviceid})`);
        }
    }

    configureAccessory(accessory) {
        this.log("Configure Cached Accessory: " + accessory.displayName + ", UUID: " + accessory.UUID);
        let cachedAccessory = this.SmartThingsAccessories.CreateFromCachedAccessory(accessory, this);
        this.SmartThingsAccessories.add(cachedAccessory);
    };

    doIncrementalUpdate() {
        let that = this;
        that.client.getUpdates((data) => {
            that.processIncrementalUpdate(data, that);
        });
    }

    processIncrementalUpdate(data, that) {
        that.log.debug('new data: ' + data);
        if (data && data.attributes && data.attributes instanceof Array) {
            for (let i = 0; i < data.attributes.length; i++) {
                that.processFieldUpdate(data.attributes[i], that);
            }
        }
    }

    processFieldUpdate(change) {
        let attrObj = this.SmartThingsAccessories.getAttributeStoreItem(change.attribute, change.deviceid);
        let accessory = this.SmartThingsAccessories.get(change);
        if (!attrObj || !accessory) return;
        if (attrObj instanceof Array) {
            attrObj.forEach(item => {
                if (accessory) {
                    accessory.context.deviceData.attributes[change.attribute] = change.value;
                    item.getValue();
                    // this.log(item);
                }
            });
        }
    }

    WebServerInit() {
        let that = this;
        // Get the IP address that we will send to the SmartApp. This can be overridden in the config file.
        return new Promise((resolve) => {
            try {
                let ip = that.configItems.direct_ip || that.myUtils.getIPAddress();
                that.log('WebServer Initiated...');
                // Start the HTTP Server
                webApp.listen(that.configItems.direct_port, () => {
                    that.log(`Direct Connect is Listening On ${ip}:${that.configItems.direct_port}`);
                });
                webApp.use(bodyParser.urlencoded({
                    extended: false
                }));
                webApp.use(bodyParser.json());
                webApp.use((req, res, next) => {
                    res.header("Access-Control-Allow-Origin", "*");
                    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
                    next();
                });

                webApp.get('/', (req, res) => {
                    res.send('WebApp is running...');
                });

                webApp.get('/restart', (req, res) => {
                    console.log('restart...');
                    let delay = (10 * 1000);
                    that.log('Received request from ' + platformName + ' to restart homebridge service in (' + (delay / 1000) + ' seconds) | NOTICE: If you using PM2 or Systemd the Homebridge Service should start back up');
                    setTimeout(() => {
                        process.exit(1);
                    }, parseInt(delay));
                    res.send('OK');
                });

                webApp.get('/refreshDevices', (req, res) => {
                    that.log('refreshDevices...');
                    that.log('Received request from ' + platformName + ' to refresh devices');
                    that.refreshDevices();
                    res.send('OK');
                });

                webApp.post('/updateprefs', (req, res) => {
                    that.log(platformName + ' Hub Sent Preference Updates');
                    let data = JSON.parse(req.body);
                    let sendUpd = false;
                    if (data.local_commands && that.local_commands !== data.local_commands) {
                        sendUpd = true;
                        that.log(platformName + ' Updated Local Commands Preference | Before: ' + that.local_commands + ' | Now: ' + data.local_commands);
                        that.local_commands = data.local_commands;
                    }
                    if (data.local_hub_ip && that.local_hub_ip !== data.local_hub_ip) {
                        sendUpd = true;
                        that.log(platformName + ' Updated Hub IP Preference | Before: ' + that.local_hub_ip + ' | Now: ' + data.local_hub_ip);
                        that.local_hub_ip = data.local_hub_ip;
                    }
                    if (sendUpd) {
                        that.client.updateGlobals(that.local_hub_ip, that.local_commands);
                    }
                    res.send('OK');
                });

                webApp.get('/initial', (req, res) => {
                    that.log(platformName + ' Hub Communication Established');
                    res.send('OK');
                });

                webApp.post('/update', (req, res) => {
                    if (req.body.length < 3)
                        return;
                    let data = JSON.parse(JSON.stringify(req.body));
                    // console.log('update: ', data);
                    if (Object.keys(data).length > 3) {
                        let newChange = {
                            deviceid: data.change_device,
                            attribute: data.change_attribute,
                            value: data.change_value,
                            date: data.change_date
                        };
                        that.log('Change Event:', '(' + data.change_name + ') [' + (data.change_attribute ? data.change_attribute.toUpperCase() : 'unknown') + '] is ' + data.change_value);
                        that.processFieldUpdate(newChange);
                    }
                    res.send('OK');
                });
                resolve('OK');
            } catch (ex) {
                resolve('');
            }
        });
    };
};