/* eslint-disable @stylistic/quotes */
/* eslint-disable @stylistic/semi */
const { DistributionAPI } = require("helios-core/common");

const ConfigManager = require("./configmanager");

// Old WesterosCraft url.
// exports.REMOTE_DISTRO_URL = 'http://mc.westeroscraft.com/WesterosCraftLauncher/distribution.json'
exports.REMOTE_DISTRO_URL =
    "http://localhost:3200/assets/distribution.json";   

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false,
);

exports.DistroAPI = api;
