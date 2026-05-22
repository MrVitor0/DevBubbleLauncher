const AdmZip = require("adm-zip");
const child_process = require("child_process");
const crypto = require("crypto");
const fs = require("fs-extra");
const { LoggerUtil } = require("helios-core");
const {
  getMojangOS,
  isLibraryCompatible,
  mcVersionAtLeast,
} = require("helios-core/common");
const { Type } = require("helios-distribution-types");
const os = require("os");
const path = require("path");

const ConfigManager = require("./configmanager");

const logger = LoggerUtil.getLogger("ProcessBuilder");

const NBT_TAG = Object.freeze({
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
});

const LAUNCHER_OPTIONS_PRESET_PATH = path.join(
  __dirname,
  "..",
  "default-options.txt",
);
const LAUNCHER_OPTIONS_PRESET_VERSION = "2026-05-22-1";
const LAUNCHER_OPTIONS_PRESET_MARKER = ".devbubble-options-preset-version";
const LAUNCHER_OPTIONS_PRESET_SKIP_KEYS = new Set([
  "resourcePacks",
  "incompatibleResourcePacks",
  "lastServer",
  "joinedFirstServer",
]);

const DEFAULT_MULTIPLAYER_SERVER = Object.freeze({
  name: "Melody",
  ip: "melody.apexmc.co",
});

const DEFAULT_RESOURCE_PACKS = Object.freeze([
  "FreshAnimations_v1.10.4.zip",
  "FA+All_Extensions-v1.8.1.zip",
  "boss-refreshed-v2-1.19-1.21.zip",
]);

const DEFAULT_SHADER_PACKS = Object.freeze([
  "ComplementaryReimagined_r5.8.1.zip",
  "ComplementaryUnbound_r5.8.1.zip",
]);

let cachedLauncherOptionsPreset = null;

function loadLauncherOptionsPreset() {
  if (cachedLauncherOptionsPreset != null) {
    return cachedLauncherOptionsPreset;
  }

  const raw = fs.readFileSync(LAUNCHER_OPTIONS_PRESET_PATH, "utf8");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  cachedLauncherOptionsPreset = lines.flatMap((line) => {
    if (line.length === 0) {
      return [];
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      return [];
    }

    const key = line.substring(0, separatorIndex);
    if (LAUNCHER_OPTIONS_PRESET_SKIP_KEYS.has(key)) {
      return [];
    }

    return [[key, line.substring(separatorIndex + 1)]];
  });

  return cachedLauncherOptionsPreset;
}

function readNbtString(state) {
  const length = state.buffer.readUInt16BE(state.offset);
  state.offset += 2;

  const value = state.buffer.toString(
    "utf8",
    state.offset,
    state.offset + length,
  );
  state.offset += length;

  return value;
}

function readNbtPayload(state, tagType) {
  switch (tagType) {
    case NBT_TAG.Byte: {
      const value = state.buffer.readInt8(state.offset);
      state.offset += 1;
      return value;
    }
    case NBT_TAG.Short: {
      const value = state.buffer.readInt16BE(state.offset);
      state.offset += 2;
      return value;
    }
    case NBT_TAG.Int: {
      const value = state.buffer.readInt32BE(state.offset);
      state.offset += 4;
      return value;
    }
    case NBT_TAG.Long: {
      const value = state.buffer.readBigInt64BE(state.offset);
      state.offset += 8;
      return value;
    }
    case NBT_TAG.Float: {
      const value = state.buffer.readFloatBE(state.offset);
      state.offset += 4;
      return value;
    }
    case NBT_TAG.Double: {
      const value = state.buffer.readDoubleBE(state.offset);
      state.offset += 8;
      return value;
    }
    case NBT_TAG.ByteArray: {
      const length = state.buffer.readInt32BE(state.offset);
      state.offset += 4;

      const value = Buffer.from(
        state.buffer.subarray(state.offset, state.offset + length),
      );
      state.offset += length;

      return value;
    }
    case NBT_TAG.String:
      return readNbtString(state);
    case NBT_TAG.List: {
      const childType = state.buffer.readUInt8(state.offset);
      state.offset += 1;

      const length = state.buffer.readInt32BE(state.offset);
      state.offset += 4;

      const value = [];
      for (let i = 0; i < length; i++) {
        value.push({
          type: childType,
          value: readNbtPayload(state, childType),
        });
      }

      return {
        childType,
        value,
      };
    }
    case NBT_TAG.Compound: {
      const value = {};

      while (state.offset < state.buffer.length) {
        const childType = state.buffer.readUInt8(state.offset);
        state.offset += 1;

        if (childType === NBT_TAG.End) {
          break;
        }

        const name = readNbtString(state);
        value[name] = {
          type: childType,
          value: readNbtPayload(state, childType),
        };
      }

      return value;
    }
    case NBT_TAG.IntArray: {
      const length = state.buffer.readInt32BE(state.offset);
      state.offset += 4;

      const value = [];
      for (let i = 0; i < length; i++) {
        value.push(state.buffer.readInt32BE(state.offset));
        state.offset += 4;
      }

      return value;
    }
    case NBT_TAG.LongArray: {
      const length = state.buffer.readInt32BE(state.offset);
      state.offset += 4;

      const value = [];
      for (let i = 0; i < length; i++) {
        value.push(state.buffer.readBigInt64BE(state.offset));
        state.offset += 8;
      }

      return value;
    }
    default:
      throw new Error(`Unsupported NBT tag type ${tagType}`);
  }
}

function parseNbt(buffer) {
  const state = {
    buffer,
    offset: 0,
  };
  const type = state.buffer.readUInt8(state.offset);
  state.offset += 1;

  const name = readNbtString(state);

  return {
    type,
    name,
    value: readNbtPayload(state, type),
  };
}

function writeNbtString(value) {
  const stringBuffer = Buffer.from(String(value), "utf8");
  const lengthBuffer = Buffer.alloc(2);
  lengthBuffer.writeUInt16BE(stringBuffer.length, 0);

  return Buffer.concat([lengthBuffer, stringBuffer]);
}

function writeNbtPayload(tag) {
  switch (tag.type) {
    case NBT_TAG.End:
      return Buffer.alloc(0);
    case NBT_TAG.Byte: {
      const buffer = Buffer.alloc(1);
      buffer.writeInt8(Number(tag.value), 0);
      return buffer;
    }
    case NBT_TAG.Short: {
      const buffer = Buffer.alloc(2);
      buffer.writeInt16BE(Number(tag.value), 0);
      return buffer;
    }
    case NBT_TAG.Int: {
      const buffer = Buffer.alloc(4);
      buffer.writeInt32BE(Number(tag.value), 0);
      return buffer;
    }
    case NBT_TAG.Long: {
      const buffer = Buffer.alloc(8);
      buffer.writeBigInt64BE(BigInt(tag.value), 0);
      return buffer;
    }
    case NBT_TAG.Float: {
      const buffer = Buffer.alloc(4);
      buffer.writeFloatBE(Number(tag.value), 0);
      return buffer;
    }
    case NBT_TAG.Double: {
      const buffer = Buffer.alloc(8);
      buffer.writeDoubleBE(Number(tag.value), 0);
      return buffer;
    }
    case NBT_TAG.ByteArray: {
      const payload = Buffer.isBuffer(tag.value)
        ? tag.value
        : Buffer.from(tag.value);
      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeInt32BE(payload.length, 0);
      return Buffer.concat([lengthBuffer, payload]);
    }
    case NBT_TAG.String:
      return writeNbtString(tag.value);
    case NBT_TAG.List: {
      const childType = tag.childType ?? tag.value[0]?.type ?? NBT_TAG.End;
      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeInt32BE(tag.value.length, 0);

      return Buffer.concat([
        Buffer.from([childType]),
        lengthBuffer,
        ...tag.value.map((entry) => writeNbtPayload(entry)),
      ]);
    }
    case NBT_TAG.Compound: {
      const parts = [];
      for (const [name, child] of Object.entries(tag.value)) {
        parts.push(Buffer.from([child.type]));
        parts.push(writeNbtString(name));
        parts.push(writeNbtPayload(child));
      }
      parts.push(Buffer.from([NBT_TAG.End]));

      return Buffer.concat(parts);
    }
    case NBT_TAG.IntArray: {
      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeInt32BE(tag.value.length, 0);
      const valueBuffers = tag.value.map((value) => {
        const buffer = Buffer.alloc(4);
        buffer.writeInt32BE(Number(value), 0);
        return buffer;
      });

      return Buffer.concat([lengthBuffer, ...valueBuffers]);
    }
    case NBT_TAG.LongArray: {
      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeInt32BE(tag.value.length, 0);
      const valueBuffers = tag.value.map((value) => {
        const buffer = Buffer.alloc(8);
        buffer.writeBigInt64BE(BigInt(value), 0);
        return buffer;
      });

      return Buffer.concat([lengthBuffer, ...valueBuffers]);
    }
    default:
      throw new Error(`Unsupported NBT tag type ${tag.type}`);
  }
}

function serializeNbt(tag) {
  return Buffer.concat([
    Buffer.from([tag.type]),
    writeNbtString(tag.name ?? ""),
    writeNbtPayload(tag),
  ]);
}

/**
 * Only forge and fabric are top level mod loaders.
 *
 * Forge 1.13+ launch logic is similar to fabrics, for now using usingFabricLoader flag to
 * change minor details when needed.
 *
 * Rewrite of this module may be needed in the future.
 */
class ProcessBuilder {
  constructor(
    distroServer,
    vanillaManifest,
    modManifest,
    authUser,
    launcherVersion,
  ) {
    this.gameDir = path.join(
      ConfigManager.getInstanceDirectory(),
      distroServer.rawServer.id,
    );
    this.commonDir = ConfigManager.getCommonDirectory();
    this.server = distroServer;
    this.vanillaManifest = vanillaManifest;
    this.modManifest = modManifest;
    this.authUser = authUser;
    this.launcherVersion = launcherVersion;
    this.forgeModListFile = path.join(this.gameDir, "forgeMods.list"); // 1.13+
    this.fmlDir = path.join(this.gameDir, "forgeModList.json");
    this.llDir = path.join(this.gameDir, "liteloaderModList.json");
    this.libPath = path.join(this.commonDir, "libraries");

    this.usingLiteLoader = false;
    this.usingFabricLoader = false;
    this.llPath = null;
  }

  /**
   * Convienence method to run the functions typically used to build a process.
   */
  build() {
    fs.ensureDirSync(this.gameDir);
    this._applyLauncherDefaults();
    const tempNativePath = path.join(
      os.tmpdir(),
      ConfigManager.getTempNativeFolder(),
      crypto.pseudoRandomBytes(16).toString("hex"),
    );
    process.throwDeprecation = true;
    this.setupLiteLoader();
    logger.info("Using liteloader:", this.usingLiteLoader);
    this.usingFabricLoader = this.server.modules.some(
      (mdl) => mdl.rawModule.type === Type.Fabric,
    );
    logger.info("Using fabric loader:", this.usingFabricLoader);
    const modObj = this.resolveModConfiguration(
      ConfigManager.getModConfiguration(this.server.rawServer.id).mods,
      this.server.modules,
    );

    // Mod list below 1.13
    // Fabric only supports 1.14+
    if (!mcVersionAtLeast("1.13", this.server.rawServer.minecraftVersion)) {
      this.constructJSONModList("forge", modObj.fMods, true);
      if (this.usingLiteLoader) {
        this.constructJSONModList("liteloader", modObj.lMods, true);
      }
    }

    const uberModArr = modObj.fMods.concat(modObj.lMods);
    let args = this.constructJVMArguments(uberModArr, tempNativePath);

    if (mcVersionAtLeast("1.13", this.server.rawServer.minecraftVersion)) {
      //args = args.concat(this.constructModArguments(modObj.fMods))
      args = args.concat(this.constructModList(modObj.fMods));
    }

    // Hide access token
    const loggableArgs = [...args];
    loggableArgs[
      loggableArgs.findIndex((x) => x === this.authUser.accessToken)
    ] = "**********";

    logger.info("Launch Arguments:", loggableArgs);

    const child = child_process.spawn(
      ConfigManager.getJavaExecutable(this.server.rawServer.id),
      args,
      {
        cwd: this.gameDir,
        detached: ConfigManager.getLaunchDetached(),
      },
    );

    if (ConfigManager.getLaunchDetached()) {
      child.unref();
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (data) => {
      data
        .trim()
        .split("\n")
        .forEach((x) => console.log(`\x1b[32m[Minecraft]\x1b[0m ${x}`));
    });
    child.stderr.on("data", (data) => {
      data
        .trim()
        .split("\n")
        .forEach((x) => console.log(`\x1b[31m[Minecraft]\x1b[0m ${x}`));
    });
    child.on("close", (code) => {
      logger.info("Exited with code", code);
      fs.remove(tempNativePath, (err) => {
        if (err) {
          logger.warn("Error while deleting temp dir", err);
        } else {
          logger.info("Temp dir deleted successfully.");
        }
      });
    });

    return child;
  }

  _applyLauncherDefaults() {
    try {
      this._ensureOptionsDefaults();
    } catch (err) {
      logger.warn("Failed to update options.txt defaults", err);
    }

    try {
      this._ensureShaderpackDefault();
    } catch (err) {
      logger.warn("Failed to update shaderpack defaults", err);
    }

    try {
      this._ensureSavedMultiplayerServer();
    } catch (err) {
      logger.warn("Failed to update servers.dat defaults", err);
    }
  }

  _resolveAvailableFiles(subdirectory, preferredFiles) {
    return preferredFiles.filter((fileName) =>
      fs.pathExistsSync(path.join(this.gameDir, subdirectory, fileName)),
    );
  }

  _parseOptionsArray(rawValue) {
    if (typeof rawValue !== "string") {
      return null;
    }

    try {
      const parsed = JSON.parse(rawValue);
      return Array.isArray(parsed) ? parsed : null;
    } catch (_err) {
      return null;
    }
  }

  _seedArrayOption(nextLines, key, values) {
    const prefix = `${key}:`;
    const nextLine = `${prefix}${JSON.stringify(values)}`;
    const existingIndex = nextLines.findIndex((line) =>
      line.startsWith(prefix),
    );

    if (existingIndex === -1) {
      nextLines.push(nextLine);
      return true;
    }

    const currentValue = nextLines[existingIndex].substring(prefix.length);
    const parsedValue = this._parseOptionsArray(currentValue);

    if (parsedValue == null || parsedValue.length > 0) {
      return false;
    }

    if (nextLines[existingIndex] === nextLine) {
      return false;
    }

    nextLines[existingIndex] = nextLine;
    return true;
  }

  _upsertOptionLine(nextLines, key, value) {
    const prefix = `${key}:`;
    const nextLine = `${prefix}${value}`;
    const existingIndex = nextLines.findIndex((line) =>
      line.startsWith(prefix),
    );

    if (existingIndex === -1) {
      nextLines.push(nextLine);
      return true;
    }

    if (nextLines[existingIndex] === nextLine) {
      return false;
    }

    nextLines[existingIndex] = nextLine;
    return true;
  }

  _getOptionsPresetMarkerPath() {
    return path.join(this.gameDir, LAUNCHER_OPTIONS_PRESET_MARKER);
  }

  _getAppliedOptionsPresetVersion() {
    const markerPath = this._getOptionsPresetMarkerPath();

    if (!fs.pathExistsSync(markerPath)) {
      return null;
    }

    return fs.readFileSync(markerPath, "utf8").trim();
  }

  _markOptionsPresetApplied() {
    fs.writeFileSync(
      this._getOptionsPresetMarkerPath(),
      `${LAUNCHER_OPTIONS_PRESET_VERSION}${os.EOL}`,
      "utf8",
    );
  }

  _applyLauncherOptionsPreset(nextLines) {
    let changed = false;

    for (const [key, value] of loadLauncherOptionsPreset()) {
      changed = this._upsertOptionLine(nextLines, key, value) || changed;
    }

    return changed;
  }

  _ensureOptionsDefaults() {
    const optionsPath = path.join(this.gameDir, "options.txt");
    const raw = fs.pathExistsSync(optionsPath)
      ? fs.readFileSync(optionsPath, "utf8")
      : "";
    const lines = raw.length > 0 ? raw.replace(/\r\n/g, "\n").split("\n") : [];
    const normalizedLines =
      lines.length > 0 && lines[lines.length - 1] === ""
        ? lines.slice(0, -1)
        : lines;
    const nextLines = [...normalizedLines];
    let changed = false;
    const shouldApplyPreset =
      this._getAppliedOptionsPresetVersion() !==
      LAUNCHER_OPTIONS_PRESET_VERSION;

    if (shouldApplyPreset) {
      changed = this._applyLauncherOptionsPreset(nextLines) || changed;
    }

    const defaultResourcePacks = this._resolveAvailableFiles(
      "resourcepacks",
      DEFAULT_RESOURCE_PACKS,
    );

    if (defaultResourcePacks.length > 0) {
      changed =
        this._seedArrayOption(nextLines, "resourcePacks", [
          "vanilla",
          ...defaultResourcePacks.map((fileName) => `file/${fileName}`),
        ]) || changed;
      changed =
        this._seedArrayOption(
          nextLines,
          "incompatibleResourcePacks",
          defaultResourcePacks.map((fileName) => `file/${fileName}`),
        ) || changed;
    }

    if (changed) {
      fs.writeFileSync(
        optionsPath,
        `${nextLines.join(os.EOL)}${os.EOL}`,
        "utf8",
      );
    }

    if (shouldApplyPreset) {
      this._markOptionsPresetApplied();
    }
  }

  _ensureShaderpackDefault() {
    const desiredShaderPack = this._resolveAvailableFiles(
      "shaderpacks",
      DEFAULT_SHADER_PACKS,
    )[0];

    if (desiredShaderPack == null) {
      return;
    }

    const optionsShadersPath = path.join(this.gameDir, "optionsshaders.txt");
    const raw = fs.pathExistsSync(optionsShadersPath)
      ? fs.readFileSync(optionsShadersPath, "utf8")
      : "";
    const lines = raw.length > 0 ? raw.replace(/\r\n/g, "\n").split("\n") : [];
    const normalizedLines =
      lines.length > 0 && lines[lines.length - 1] === ""
        ? lines.slice(0, -1)
        : lines;
    const existingIndex = normalizedLines.findIndex((line) =>
      line.startsWith("shaderPack="),
    );

    if (existingIndex !== -1) {
      const currentValue = normalizedLines[existingIndex]
        .substring("shaderPack=".length)
        .trim();

      if (
        currentValue.length > 0 &&
        currentValue !== "OFF" &&
        currentValue !== desiredShaderPack
      ) {
        return;
      }

      if (currentValue === desiredShaderPack) {
        return;
      }

      normalizedLines[existingIndex] = `shaderPack=${desiredShaderPack}`;
    } else {
      normalizedLines.push(`shaderPack=${desiredShaderPack}`);
    }

    fs.writeFileSync(
      optionsShadersPath,
      `${normalizedLines.join(os.EOL)}${os.EOL}`,
      "utf8",
    );
  }

  _ensureSavedMultiplayerServer() {
    const serversPath = path.join(this.gameDir, "servers.dat");
    let rootTag = {
      type: NBT_TAG.Compound,
      name: "",
      value: {},
    };
    let changed = !fs.pathExistsSync(serversPath);

    if (!changed) {
      rootTag = parseNbt(fs.readFileSync(serversPath));
    }

    if (rootTag.type !== NBT_TAG.Compound) {
      throw new Error("servers.dat root tag must be a compound");
    }

    let serversTag = rootTag.value.servers;
    if (
      serversTag == null ||
      serversTag.type !== NBT_TAG.List ||
      serversTag.childType !== NBT_TAG.Compound
    ) {
      serversTag = {
        type: NBT_TAG.List,
        childType: NBT_TAG.Compound,
        value: [],
      };
      rootTag.value.servers = serversTag;
      changed = true;
    }

    const targetIp = DEFAULT_MULTIPLAYER_SERVER.ip.toLowerCase();
    const existingServer = serversTag.value.find((entry) => {
      if (entry.type !== NBT_TAG.Compound) {
        return false;
      }

      const serverIp = entry.value?.ip;
      return (
        serverIp?.type === NBT_TAG.String &&
        serverIp.value.toLowerCase() === targetIp
      );
    });

    if (existingServer == null) {
      serversTag.value.push({
        type: NBT_TAG.Compound,
        value: {
          name: {
            type: NBT_TAG.String,
            value: DEFAULT_MULTIPLAYER_SERVER.name,
          },
          ip: {
            type: NBT_TAG.String,
            value: DEFAULT_MULTIPLAYER_SERVER.ip,
          },
        },
      });
      changed = true;
    }

    if (!changed) {
      return;
    }

    // Minecraft stores the multiplayer list as raw NBT in servers.dat.
    fs.writeFileSync(serversPath, serializeNbt(rootTag));
  }

  /**
   * Get the platform specific classpath separator. On windows, this is a semicolon.
   * On Unix, this is a colon.
   *
   * @returns {string} The classpath separator for the current operating system.
   */
  static getClasspathSeparator() {
    return process.platform === "win32" ? ";" : ":";
  }

  /**
   * Determine if an optional mod is enabled from its configuration value. If the
   * configuration value is null, the required object will be used to
   * determine if it is enabled.
   *
   * A mod is enabled if:
   *   * The configuration is not null and one of the following:
   *     * The configuration is a boolean and true.
   *     * The configuration is an object and its 'value' property is true.
   *   * The configuration is null and one of the following:
   *     * The required object is null.
   *     * The required object's 'def' property is null or true.
   *
   * @param {Object | boolean} modCfg The mod configuration object.
   * @param {Object} required Optional. The required object from the mod's distro declaration.
   * @returns {boolean} True if the mod is enabled, false otherwise.
   */
  static isModEnabled(modCfg, required = null) {
    return modCfg != null
      ? (typeof modCfg === "boolean" && modCfg) ||
          (typeof modCfg === "object" &&
            (typeof modCfg.value !== "undefined" ? modCfg.value : true))
      : required != null
        ? required.def
        : true;
  }

  /**
   * Function which performs a preliminary scan of the top level
   * mods. If liteloader is present here, we setup the special liteloader
   * launch options. Note that liteloader is only allowed as a top level
   * mod. It must not be declared as a submodule.
   */
  setupLiteLoader() {
    for (let ll of this.server.modules) {
      if (ll.rawModule.type === Type.LiteLoader) {
        if (!ll.getRequired().value) {
          const modCfg = ConfigManager.getModConfiguration(
            this.server.rawServer.id,
          ).mods;
          if (
            ProcessBuilder.isModEnabled(
              modCfg[ll.getVersionlessMavenIdentifier()],
              ll.getRequired(),
            )
          ) {
            if (fs.existsSync(ll.getPath())) {
              this.usingLiteLoader = true;
              this.llPath = ll.getPath();
            }
          }
        } else {
          if (fs.existsSync(ll.getPath())) {
            this.usingLiteLoader = true;
            this.llPath = ll.getPath();
          }
        }
      }
    }
  }

  /**
   * Resolve an array of all enabled mods. These mods will be constructed into
   * a mod list format and enabled at launch.
   *
   * @param {Object} modCfg The mod configuration object.
   * @param {Array.<Object>} mdls An array of modules to parse.
   * @returns {{fMods: Array.<Object>, lMods: Array.<Object>}} An object which contains
   * a list of enabled forge mods and litemods.
   */
  resolveModConfiguration(modCfg, mdls) {
    let fMods = [];
    let lMods = [];

    for (let mdl of mdls) {
      const type = mdl.rawModule.type;
      if (
        type === Type.ForgeMod ||
        type === Type.LiteMod ||
        type === Type.LiteLoader ||
        type === Type.FabricMod
      ) {
        const o = !mdl.getRequired().value;
        const e = ProcessBuilder.isModEnabled(
          modCfg[mdl.getVersionlessMavenIdentifier()],
          mdl.getRequired(),
        );
        if (!o || (o && e)) {
          if (mdl.subModules.length > 0) {
            const v = this.resolveModConfiguration(
              modCfg[mdl.getVersionlessMavenIdentifier()].mods,
              mdl.subModules,
            );
            fMods = fMods.concat(v.fMods);
            lMods = lMods.concat(v.lMods);
            if (type === Type.LiteLoader) {
              continue;
            }
          }
          if (type === Type.ForgeMod || type === Type.FabricMod) {
            fMods.push(mdl);
          } else {
            lMods.push(mdl);
          }
        }
      }
    }

    return {
      fMods,
      lMods,
    };
  }

  _lteMinorVersion(version) {
    return (
      Number(this.modManifest.id.split("-")[0].split(".")[1]) <= Number(version)
    );
  }

  /**
   * Test to see if this version of forge requires the absolute: prefix
   * on the modListFile repository field.
   */
  _requiresAbsolute() {
    try {
      if (this._lteMinorVersion(9)) {
        return false;
      }
      const ver = this.modManifest.id.split("-")[2];
      const pts = ver.split(".");
      const min = [14, 23, 3, 2655];
      for (let i = 0; i < pts.length; i++) {
        const parsed = Number.parseInt(pts[i]);
        if (parsed < min[i]) {
          return false;
        } else if (parsed > min[i]) {
          return true;
        }
      }
    } catch (_err) {
      // We know old forge versions follow this format.
      // Error must be caused by newer version.
    }

    // Equal or errored
    return true;
  }

  /**
   * Construct a mod list json object.
   *
   * @param {'forge' | 'liteloader'} type The mod list type to construct.
   * @param {Array.<Object>} mods An array of mods to add to the mod list.
   * @param {boolean} save Optional. Whether or not we should save the mod list file.
   */
  constructJSONModList(type, mods, save = false) {
    const modList = {
      repositoryRoot:
        (type === "forge" && this._requiresAbsolute() ? "absolute:" : "") +
        path.join(this.commonDir, "modstore"),
    };

    const ids = [];
    if (type === "forge") {
      for (let mod of mods) {
        ids.push(mod.getExtensionlessMavenIdentifier());
      }
    } else {
      for (let mod of mods) {
        ids.push(mod.getMavenIdentifier());
      }
    }
    modList.modRef = ids;

    if (save) {
      const json = JSON.stringify(modList, null, 4);
      fs.writeFileSync(
        type === "forge" ? this.fmlDir : this.llDir,
        json,
        "UTF-8",
      );
    }

    return modList;
  }

  // /**
  //  * Construct the mod argument list for forge 1.13
  //  *
  //  * @param {Array.<Object>} mods An array of mods to add to the mod list.
  //  */
  // constructModArguments(mods){
  //     const argStr = mods.map(mod => {
  //         return mod.getExtensionlessMavenIdentifier()
  //     }).join(',')

  //     if(argStr){
  //         return [
  //             '--fml.mavenRoots',
  //             path.join('..', '..', 'common', 'modstore'),
  //             '--fml.mods',
  //             argStr
  //         ]
  //     } else {
  //         return []
  //     }

  // }

  /**
   * Construct the mod argument list for forge 1.13 and Fabric
   *
   * @param {Array.<Object>} mods An array of mods to add to the mod list.
   */
  constructModList(mods) {
    const writeBuffer = mods
      .map((mod) => {
        return this.usingFabricLoader
          ? mod.getPath()
          : mod.getExtensionlessMavenIdentifier();
      })
      .join("\n");

    if (writeBuffer) {
      fs.writeFileSync(this.forgeModListFile, writeBuffer, "UTF-8");
      return this.usingFabricLoader
        ? ["--fabric.addMods", `@${this.forgeModListFile}`]
        : [
            "--fml.mavenRoots",
            path.join("..", "..", "common", "modstore"),
            "--fml.modLists",
            this.forgeModListFile,
          ];
    } else {
      return [];
    }
  }

  _processAutoConnectArg(args) {
    if (ConfigManager.getAutoConnect() && this.server.rawServer.autoconnect) {
      if (mcVersionAtLeast("1.20", this.server.rawServer.minecraftVersion)) {
        args.push("--quickPlayMultiplayer");
        args.push(`${this.server.hostname}:${this.server.port}`);
      } else {
        args.push("--server");
        args.push(this.server.hostname);
        args.push("--port");
        args.push(this.server.port);
      }
    }
  }

  /**
   * Construct the argument array that will be passed to the JVM process.
   *
   * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
   * @param {string} tempNativePath The path to store the native libraries.
   * @returns {Array.<string>} An array containing the full JVM arguments for this process.
   */
  constructJVMArguments(mods, tempNativePath) {
    if (mcVersionAtLeast("1.13", this.server.rawServer.minecraftVersion)) {
      return this._constructJVMArguments113(mods, tempNativePath);
    } else {
      return this._constructJVMArguments112(mods, tempNativePath);
    }
  }

  /**
   * Construct the argument array that will be passed to the JVM process.
   * This function is for 1.12 and below.
   *
   * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
   * @param {string} tempNativePath The path to store the native libraries.
   * @returns {Array.<string>} An array containing the full JVM arguments for this process.
   */
  _constructJVMArguments112(mods, tempNativePath) {
    let args = [];

    // Classpath Argument
    args.push("-cp");
    args.push(
      this.classpathArg(mods, tempNativePath).join(
        ProcessBuilder.getClasspathSeparator(),
      ),
    );

    // Java Arguments
    if (process.platform === "darwin") {
      args.push("-Xdock:name=DevBubble Launcher");
      args.push(
        "-Xdock:icon=" + path.join(__dirname, "..", "images", "SealCircle.png"),
      );
    }
    args.push("-Xmx" + ConfigManager.getMaxRAM(this.server.rawServer.id));
    args.push("-Xms" + ConfigManager.getMinRAM(this.server.rawServer.id));
    args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id));
    args.push("-Djava.library.path=" + tempNativePath);

    // Main Java Class
    args.push(this.modManifest.mainClass);

    // Forge Arguments
    args = args.concat(this._resolveForgeArgs());

    return args;
  }

  /**
   * Construct the argument array that will be passed to the JVM process.
   * This function is for 1.13+
   *
   * Note: Required Libs https://github.com/MinecraftForge/MinecraftForge/blob/af98088d04186452cb364280340124dfd4766a5c/src/fmllauncher/java/net/minecraftforge/fml/loading/LibraryFinder.java#L82
   *
   * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
   * @param {string} tempNativePath The path to store the native libraries.
   * @returns {Array.<string>} An array containing the full JVM arguments for this process.
   */
  _constructJVMArguments113(mods, tempNativePath) {
    const argDiscovery = /\${*(.*)}/;

    // JVM Arguments First
    let args = this.vanillaManifest.arguments.jvm;

    // Debug securejarhandler
    // args.push('-Dbsl.debug=true')

    if (this.modManifest.arguments.jvm != null) {
      for (const argStr of this.modManifest.arguments.jvm) {
        args.push(
          argStr
            .replaceAll("${library_directory}", this.libPath)
            .replaceAll(
              "${classpath_separator}",
              ProcessBuilder.getClasspathSeparator(),
            )
            .replaceAll("${version_name}", this.modManifest.id),
        );
      }
    }

    //args.push('-Dlog4j.configurationFile=D:\\WesterosCraft\\game\\common\\assets\\log_configs\\client-1.12.xml')

    // Java Arguments
    if (process.platform === "darwin") {
      args.push("-Xdock:name=DevBubble Launcher");
      args.push(
        "-Xdock:icon=" + path.join(__dirname, "..", "images", "SealCircle.png"),
      );
    }
    args.push("-Xmx" + ConfigManager.getMaxRAM(this.server.rawServer.id));
    args.push("-Xms" + ConfigManager.getMinRAM(this.server.rawServer.id));
    args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id));

    // Main Java Class
    args.push(this.modManifest.mainClass);

    // Vanilla Arguments
    args = args.concat(this.vanillaManifest.arguments.game);

    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] === "object" && args[i].rules != null) {
        let checksum = 0;
        for (let rule of args[i].rules) {
          if (rule.os != null) {
            if (
              rule.os.name === getMojangOS() &&
              (rule.os.version == null ||
                new RegExp(rule.os.version).test(os.release))
            ) {
              if (rule.action === "allow") {
                checksum++;
              }
            } else {
              if (rule.action === "disallow") {
                checksum++;
              }
            }
          } else if (rule.features != null) {
            // We don't have many 'features' in the index at the moment.
            // This should be fine for a while.
            if (
              rule.features.has_custom_resolution != null &&
              rule.features.has_custom_resolution === true
            ) {
              if (ConfigManager.getFullscreen()) {
                args[i].value = ["--fullscreen", "true"];
              }
              checksum++;
            }
          }
        }

        // TODO splice not push
        if (checksum === args[i].rules.length) {
          if (typeof args[i].value === "string") {
            args[i] = args[i].value;
          } else if (typeof args[i].value === "object") {
            //args = args.concat(args[i].value)
            args.splice(i, 1, ...args[i].value);
          }

          // Decrement i to reprocess the resolved value
          i--;
        } else {
          args[i] = null;
        }
      } else if (typeof args[i] === "string") {
        if (argDiscovery.test(args[i])) {
          const identifier = args[i].match(argDiscovery)[1];
          let val = null;
          switch (identifier) {
            case "auth_player_name":
              val = this.authUser.displayName.trim();
              break;
            case "version_name":
              val = this.modManifest.id;
              break;
            case "game_directory":
              val = this.gameDir;
              break;
            case "assets_root":
              val = path.join(this.commonDir, "assets");
              break;
            case "assets_index_name":
              val = this.vanillaManifest.assets;
              break;
            case "auth_uuid":
              val = this.authUser.uuid.trim();
              break;
            case "auth_access_token":
              val = this.authUser.accessToken;
              break;
            case "user_type":
              val =
                this.authUser.type === "microsoft"
                  ? "msa"
                  : this.authUser.type === "offline"
                    ? "legacy"
                    : "mojang";
              break;
            case "version_type":
              val = this.vanillaManifest.type;
              break;
            case "resolution_width":
              val = ConfigManager.getGameWidth();
              break;
            case "resolution_height":
              val = ConfigManager.getGameHeight();
              break;
            case "natives_directory":
              val = args[i].replace(argDiscovery, tempNativePath);
              break;
            case "launcher_name":
              val = args[i].replace(argDiscovery, "DevBubble-Launcher");
              break;
            case "launcher_version":
              val = args[i].replace(argDiscovery, this.launcherVersion);
              break;
            case "classpath":
              val = this.classpathArg(mods, tempNativePath).join(
                ProcessBuilder.getClasspathSeparator(),
              );
              break;
          }
          if (val != null) {
            args[i] = val;
          }
        }
      }
    }

    // Autoconnect
    this._processAutoConnectArg(args);

    // Forge Specific Arguments
    args = args.concat(this.modManifest.arguments.game);

    // Filter null values
    args = args.filter((arg) => {
      return arg != null;
    });

    return args;
  }

  /**
   * Resolve the arguments required by forge.
   *
   * @returns {Array.<string>} An array containing the arguments required by forge.
   */
  _resolveForgeArgs() {
    const mcArgs = this.modManifest.minecraftArguments.split(" ");
    const argDiscovery = /\${*(.*)}/;

    // Replace the declared variables with their proper values.
    for (let i = 0; i < mcArgs.length; ++i) {
      if (argDiscovery.test(mcArgs[i])) {
        const identifier = mcArgs[i].match(argDiscovery)[1];
        let val = null;
        switch (identifier) {
          case "auth_player_name":
            val = this.authUser.displayName.trim();
            break;
          case "version_name":
            val = this.modManifest.id;
            break;
          case "game_directory":
            val = this.gameDir;
            break;
          case "assets_root":
            val = path.join(this.commonDir, "assets");
            break;
          case "assets_index_name":
            val = this.vanillaManifest.assets;
            break;
          case "auth_uuid":
            val = this.authUser.uuid.trim();
            break;
          case "auth_access_token":
            val = this.authUser.accessToken;
            break;
          case "user_type":
            val =
              this.authUser.type === "microsoft"
                ? "msa"
                : this.authUser.type === "offline"
                  ? "legacy"
                  : "mojang";
            break;
          case "user_properties": // 1.8.9 and below.
            val = "{}";
            break;
          case "version_type":
            val = this.vanillaManifest.type;
            break;
        }
        if (val != null) {
          mcArgs[i] = val;
        }
      }
    }

    // Autoconnect to the selected server.
    this._processAutoConnectArg(mcArgs);

    // Prepare game resolution
    if (ConfigManager.getFullscreen()) {
      mcArgs.push("--fullscreen");
      mcArgs.push(true);
    } else {
      mcArgs.push("--width");
      mcArgs.push(ConfigManager.getGameWidth());
      mcArgs.push("--height");
      mcArgs.push(ConfigManager.getGameHeight());
    }

    // Mod List File Argument
    mcArgs.push("--modListFile");
    if (this._lteMinorVersion(9)) {
      mcArgs.push(path.basename(this.fmlDir));
    } else {
      mcArgs.push("absolute:" + this.fmlDir);
    }

    // LiteLoader
    if (this.usingLiteLoader) {
      mcArgs.push("--modRepo");
      mcArgs.push(this.llDir);

      // Set first arg to liteloader tweak class
      mcArgs.unshift("com.mumfrey.liteloader.launch.LiteLoaderTweaker");
      mcArgs.unshift("--tweakClass");
    }

    return mcArgs;
  }

  /**
   * Ensure that the classpath entries all point to jar files.
   *
   * @param {Array.<String>} list Array of classpath entries.
   */
  _processClassPathList(list) {
    const ext = ".jar";
    const extLen = ext.length;
    for (let i = 0; i < list.length; i++) {
      const extIndex = list[i].indexOf(ext);
      if (extIndex > -1 && extIndex !== list[i].length - extLen) {
        list[i] = list[i].substring(0, extIndex + extLen);
      }
    }
  }

  /**
   * Resolve the full classpath argument list for this process. This method will resolve all Mojang-declared
   * libraries as well as the libraries declared by the server. Since mods are permitted to declare libraries,
   * this method requires all enabled mods as an input
   *
   * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
   * @param {string} tempNativePath The path to store the native libraries.
   * @returns {Array.<string>} An array containing the paths of each library required by this process.
   */
  classpathArg(mods, tempNativePath) {
    let cpArgs = [];

    if (
      !mcVersionAtLeast("1.17", this.server.rawServer.minecraftVersion) ||
      this.usingFabricLoader
    ) {
      // Add the version.jar to the classpath.
      // Must not be added to the classpath for Forge 1.17+.
      const version = this.vanillaManifest.id;
      cpArgs.push(
        path.join(this.commonDir, "versions", version, version + ".jar"),
      );
    }

    if (this.usingLiteLoader) {
      cpArgs.push(this.llPath);
    }

    // Resolve the Mojang declared libraries.
    const mojangLibs = this._resolveMojangLibraries(tempNativePath);

    // Resolve the server declared libraries.
    const servLibs = this._resolveServerLibraries(mods);

    // Merge libraries, server libs with the same
    // maven identifier will override the mojang ones.
    // Ex. 1.7.10 forge overrides mojang's guava with newer version.
    const finalLibs = { ...mojangLibs, ...servLibs };
    cpArgs = cpArgs.concat(Object.values(finalLibs));

    this._processClassPathList(cpArgs);

    return cpArgs;
  }

  /**
   * Resolve the libraries defined by Mojang's version data. This method will also extract
   * native libraries and point to the correct location for its classpath.
   *
   * TODO - clean up function
   *
   * @param {string} tempNativePath The path to store the native libraries.
   * @returns {{[id: string]: string}} An object containing the paths of each library mojang declares.
   */
  _resolveMojangLibraries(tempNativePath) {
    const nativesRegex = /.+:natives-([^-]+)(?:-(.+))?/;
    const libs = {};

    const libArr = this.vanillaManifest.libraries;
    fs.ensureDirSync(tempNativePath);
    for (let i = 0; i < libArr.length; i++) {
      const lib = libArr[i];
      if (isLibraryCompatible(lib.rules, lib.natives)) {
        // Pre-1.19 has a natives object.
        if (lib.natives != null) {
          // Extract the native library.
          const exclusionArr =
            lib.extract != null ? lib.extract.exclude : ["META-INF/"];
          const artifact =
            lib.downloads.classifiers[
              lib.natives[getMojangOS()].replace(
                "${arch}",
                process.arch.replace("x", ""),
              )
            ];

          // Location of native zip.
          const to = path.join(this.libPath, artifact.path);

          let zip = new AdmZip(to);
          let zipEntries = zip.getEntries();

          // Unzip the native zip.
          for (let i = 0; i < zipEntries.length; i++) {
            const fileName = zipEntries[i].entryName;

            let shouldExclude = false;

            // Exclude noted files.
            exclusionArr.forEach(function (exclusion) {
              if (fileName.indexOf(exclusion) > -1) {
                shouldExclude = true;
              }
            });

            // Extract the file.
            if (!shouldExclude) {
              fs.writeFile(
                path.join(tempNativePath, fileName),
                zipEntries[i].getData(),
                (err) => {
                  if (err) {
                    logger.error("Error while extracting native library:", err);
                  }
                },
              );
            }
          }
        }
        // 1.19+ logic
        else if (lib.name.includes("natives-")) {
          const regexTest = nativesRegex.exec(lib.name);
          // const os = regexTest[1]
          const arch = regexTest[2] ?? "x64";

          if (arch != process.arch) {
            continue;
          }

          // Extract the native library.
          const exclusionArr =
            lib.extract != null
              ? lib.extract.exclude
              : ["META-INF/", ".git", ".sha1"];
          const artifact = lib.downloads.artifact;

          // Location of native zip.
          const to = path.join(this.libPath, artifact.path);

          let zip = new AdmZip(to);
          let zipEntries = zip.getEntries();

          // Unzip the native zip.
          for (let i = 0; i < zipEntries.length; i++) {
            if (zipEntries[i].isDirectory) {
              continue;
            }

            const fileName = zipEntries[i].entryName;

            let shouldExclude = false;

            // Exclude noted files.
            exclusionArr.forEach(function (exclusion) {
              if (fileName.indexOf(exclusion) > -1) {
                shouldExclude = true;
              }
            });

            const extractName = fileName.includes("/")
              ? fileName.substring(fileName.lastIndexOf("/"))
              : fileName;

            // Extract the file.
            if (!shouldExclude) {
              fs.writeFile(
                path.join(tempNativePath, extractName),
                zipEntries[i].getData(),
                (err) => {
                  if (err) {
                    logger.error("Error while extracting native library:", err);
                  }
                },
              );
            }
          }
        }
        // No natives
        else {
          const dlInfo = lib.downloads;
          const artifact = dlInfo.artifact;
          const to = path.join(this.libPath, artifact.path);
          const versionIndependentId = lib.name.substring(
            0,
            lib.name.lastIndexOf(":"),
          );
          libs[versionIndependentId] = to;
        }
      }
    }

    return libs;
  }

  /**
   * Resolve the libraries declared by this server in order to add them to the classpath.
   * This method will also check each enabled mod for libraries, as mods are permitted to
   * declare libraries.
   *
   * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
   * @returns {{[id: string]: string}} An object containing the paths of each library this server requires.
   */
  _resolveServerLibraries(mods) {
    const mdls = this.server.modules;
    let libs = {};

    // Locate Forge/Fabric/Libraries
    for (let mdl of mdls) {
      const type = mdl.rawModule.type;
      if (
        type === Type.ForgeHosted ||
        type === Type.Fabric ||
        type === Type.Library
      ) {
        const mavenComponents = mdl.getMavenComponents();
        const isNeoForgeHosted =
          type === Type.ForgeHosted &&
          mavenComponents.group === "net.neoforged" &&
          mavenComponents.artifact === "neoforge";
        const hasUniversalRuntime = mdl.subModules.some((subModule) => {
          if (subModule.rawModule.type !== Type.Library) {
            return false;
          }

          const subComponents = subModule.getMavenComponents();
          return (
            subComponents.group === "net.neoforged" &&
            subComponents.artifact === "neoforge" &&
            subComponents.classifier === "universal"
          );
        });

        if (!isNeoForgeHosted || !hasUniversalRuntime) {
          libs[mdl.getVersionlessMavenIdentifier()] = mdl.getPath();
        }

        if (mdl.subModules.length > 0) {
          const res = this._resolveModuleLibraries(mdl);
          libs = { ...libs, ...res };
        }
      }
    }

    //Check for any libraries in our mod list.
    for (let i = 0; i < mods.length; i++) {
      if (mods.sub_modules != null) {
        const res = this._resolveModuleLibraries(mods[i]);
        libs = { ...libs, ...res };
      }
    }

    return libs;
  }

  /**
   * Recursively resolve the path of each library required by this module.
   *
   * @param {Object} mdl A module object from the server distro index.
   * @returns {{[id: string]: string}} An object containing the paths of each library this module requires.
   */
  _resolveModuleLibraries(mdl) {
    if (mdl.subModules.length === 0) {
      return {};
    }
    let libs = {};
    for (let sm of mdl.subModules) {
      if (sm.rawModule.type === Type.Library) {
        if (sm.rawModule.classpath ?? true) {
          libs[sm.getVersionlessMavenIdentifier()] = sm.getPath();
        }
      }
      // If this module has submodules, we need to resolve the libraries for those.
      // To avoid unnecessary recursive calls, base case is checked here.
      if (mdl.subModules.length > 0) {
        const res = this._resolveModuleLibraries(sm);
        libs = { ...libs, ...res };
      }
    }
    return libs;
  }
}

module.exports = ProcessBuilder;
