import { CATEGORIES } from "../constants/LoggerConstants.js";

export class ZonesDatabase {
  constructor() {
    this.zones = {};
    this.mapCoordinates = {};
    this.mapPixelsPerMeter = 1;
    this.overrides = new Map();
    this.loaded = false;
    this.stats = {
      totalZones: 0,
      safe: 0,
      yellow: 0,
      red: 0,
      black: 0,
      loadTimeMs: 0,
    };
  }

  async load(
    jsonPath = "/ao-bin-dumps/zones.json",
    mapCoordinatesPath = "/images/Maps/coords.json",
  ) {
    const startTime = performance.now();

    try {
      window.logger?.info(CATEGORIES.SYSTEM, "ZonesDatabaseLoading", {
        path: jsonPath,
      });

      const response = await fetch(jsonPath, {cache: 'no-cache'});
      if (!response.ok) {
        throw new Error(`Failed to fetch zones.json: ${response.status}`);
      }

      this.zones = await response.json();
      await this._loadMapCoordinates(mapCoordinatesPath);
      this.loaded = true;

      // Calculate stats
      for (const zone of Object.values(this.zones)) {
        this.stats.totalZones++;
        if (zone.pvpType === "safe") this.stats.safe++;
        else if (zone.pvpType === "yellow") this.stats.yellow++;
        else if (zone.pvpType === "red") this.stats.red++;
        else if (zone.pvpType === "black") this.stats.black++;
      }

      this.stats.loadTimeMs = Math.round(performance.now() - startTime);

      window.logger?.info(CATEGORIES.SYSTEM, "ZonesDatabaseLoaded", {
        totalZones: this.stats.totalZones,
        safe: this.stats.safe,
        yellow: this.stats.yellow,
        red: this.stats.red,
        black: this.stats.black,
        loadTimeMs: this.stats.loadTimeMs,
      });
    } catch (error) {
      window.logger?.error(CATEGORIES.SYSTEM, "ZonesDatabaseLoadError", {
        error: error.message,
        stack: error.stack,
        path: jsonPath,
      });
      throw error;
    }
  }

  async _loadMapCoordinates(jsonPath) {
    try {
      const response = await fetch(jsonPath, {cache: 'no-cache'});
      if (!response.ok) {
        throw new Error(`Failed to fetch coords.json: ${response.status}`);
      }

      const document = await response.json();
      const clusters = document?.clusters;
      if (!clusters || typeof clusters !== "object" || Array.isArray(clusters)) {
        throw new Error("coords.json does not contain a valid clusters object");
      }

      this.mapCoordinates = clusters;
      const pixelsPerMeter = Number(document?.readme?.px_per_meter);
      this.mapPixelsPerMeter = Number.isFinite(pixelsPerMeter) && pixelsPerMeter > 0
        ? pixelsPerMeter
        : 1;
    } catch (error) {
      this.mapCoordinates = {};
      this.mapPixelsPerMeter = 1;
      window.logger?.warn(CATEGORIES.MAP, "MapCoordinatesLoadError", {
        error: error.message,
        path: jsonPath,
      });
    }
  }

  getZone(zoneId) {
    if (!zoneId) return null;
    const id = String(zoneId);
    if (this.overrides.has(id)) return this.overrides.get(id);
    // Try exact match first (handles TNL-XXX, YOURNAME-HIDEOUT, etc.)
    let raw = this.zones[id];
    if (!raw) {
      // Fallback: try base ID for compound numeric IDs like "1234-5"
      const baseId = id.split("-")[0];
      raw = this.zones[baseId] || null;
    }
    return this._applyAvalonRoadsRule(raw);
  }

  // Roads of Avalon are full-loot PvP regardless of origin. zones.json tags TUNNEL_ROYAL
  // and TUNNEL_ROYAL_RED as safe/red, overridden here.
  _applyAvalonRoadsRule(zone) {
    if (!zone) return null;
    if (zone.type === "TUNNEL_ROYAL" || zone.type === "TUNNEL_ROYAL_RED") {
      return { ...zone, pvpType: "black" };
    }
    return zone;
  }

  setMistOverride(mistMapId, originZoneId, forcedPvpType) {
    const origin = this.getZone(originZoneId);
    if (!origin) {
      window.logger?.warn(CATEGORIES.MAP, "MistOverrideUnknownOrigin", {
        mistMapId,
        originZoneId,
      });
      return false;
    }
    const isAbbey = String(mistMapId).startsWith("@MISTSDUNGEON@");
    // Red zones are lethal full-loot; Mists entered from them are lethal black, not red.
    const inheritedPvpType = origin.pvpType === "red" ? "black" : origin.pvpType;
    this.overrides.set(String(mistMapId), {
      name: isAbbey ? `Knightfall Abbey (Mist of ${origin.name})` : `Mist of ${origin.name}`,
      type: "MISTS",
      pvpType: forcedPvpType || inheritedPvpType,
      tier: 0,
      file: origin.file,
      bounds: origin.bounds,
      originZoneId: String(originZoneId),
    });
    return true;
  }

  clearMistOverride(mapId) {
    this.overrides.delete(String(mapId));
  }

  clearAllMistOverrides() {
    this.overrides.clear();
  }

  getPvpType(zoneId) {
    return this.getZone(zoneId)?.pvpType || "safe";
  }

  isBlackZone(zoneId) {
    return this.getPvpType(zoneId) === "black";
  }

  isRedZone(zoneId) {
    return this.getPvpType(zoneId) === "red";
  }

  isYellowZone(zoneId) {
    return this.getPvpType(zoneId) === "yellow";
  }

  isSafeZone(zoneId) {
    return this.getPvpType(zoneId) === "safe";
  }

  isDangerousZone(zoneId) {
    const pvp = this.getPvpType(zoneId);
    return pvp === "black" || pvp === "red";
  }

  getZoneName(zoneId) {
    return this.getZone(zoneId)?.name || zoneId;
  }

  getZoneTier(zoneId) {
    return this.getZone(zoneId)?.tier || 0;
  }

  getZoneFile(zoneId) {
    return this.getZone(zoneId)?.file || null;
  }

  getZoneType(zoneId) {
    return this.getZone(zoneId)?.type || "";
  }

  getMapAssetExtent(zoneId) {
    const geometry = this.getMapAssetGeometry(zoneId);
    return Math.max(geometry.width, geometry.height);
  }

  getMapAssetCenter(zoneId) {
    return this.getMapAssetGeometry(zoneId).center;
  }

  getMapAssetGeometry(zoneId) {
    const coordinates = this._validMapCoordinates(zoneId);
    if (coordinates) {
      const [pixelWidth, pixelHeight] = coordinates.size;
      const pixelsPerMeter = coordinates.pixelsPerMeter;
      const width = pixelWidth / pixelsPerMeter;
      const height = pixelHeight / pixelsPerMeter;

      return {
        width,
        height,
        center: {
          x: (pixelWidth / 2 - coordinates.addToX) / pixelsPerMeter,
          y: (coordinates.subZFrom + 1 - pixelHeight / 2) / pixelsPerMeter,
        },
        source: "coords",
      };
    }

    const b = this._validBounds(zoneId);
    if (b) {
      return {
        width: b.max[0] - b.min[0],
        height: b.max[1] - b.min[1],
        center: {
          x: (b.min[0] + b.max[0]) / 2,
          y: (b.min[1] + b.max[1]) / 2,
        },
        source: "bounds",
      };
    }

    return {
      width: 825,
      height: 825,
      center: {x: 0, y: 0},
      source: "fallback",
    };
  }

  getZoneBounds(zoneId) {
    const b = this._validBounds(zoneId);
    if (!b) return null;
    return {
      min: [...b.min],
      max: [...b.max],
    };
  }

  _validBounds(zoneId) {
    const b = this.getZone(zoneId)?.bounds;
    if (
      !b ||
      !Array.isArray(b.min) || !Array.isArray(b.max) ||
      b.min.length !== 2 || b.max.length !== 2 ||
      !Number.isFinite(b.min[0]) || !Number.isFinite(b.min[1]) ||
      !Number.isFinite(b.max[0]) || !Number.isFinite(b.max[1])
    ) {
      return null;
    }
    return b;
  }

  _validMapCoordinates(zoneId) {
    const file = this.getZoneFile(zoneId);
    if (!file) return null;

    const entry = this.mapCoordinates[file];
    const coordinates = entry?.game_walk ?? entry?.full;
    if (!coordinates) return null;

    const size = coordinates.size;
    const zeroPixel = coordinates.zero_px;
    if (
      !Array.isArray(size) || size.length !== 2 ||
      !size.every((value) => Number.isFinite(value) && value > 0) ||
      !Array.isArray(zeroPixel) || zeroPixel.length !== 2 ||
      !zeroPixel.every(Number.isFinite)
    ) {
      return null;
    }

    const pixelsPerMeter = Number(coordinates.px_per_meter ?? this.mapPixelsPerMeter);
    return {
      size,
      addToX: zeroPixel[0],
      subZFrom: zeroPixel[1],
      pixelsPerMeter: Number.isFinite(pixelsPerMeter) && pixelsPerMeter > 0
        ? pixelsPerMeter
        : 1,
    };
  }
}

const zonesDatabase = new ZonesDatabase();
export default zonesDatabase;
