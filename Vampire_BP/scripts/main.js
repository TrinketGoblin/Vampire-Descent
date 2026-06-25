import {
    world, system,
    EquipmentSlot, ItemStack,
    EntityDamageCause, WeatherType,
    GameMode, InputButton, ButtonState,
} from "@minecraft/server";
import { ModalFormData, ActionFormData, FormCancelationReason } from "@minecraft/server-ui";

// ═══════════════════════════════════════════════════════════════════════════
// VAMPIRIC DESCENT v10 — Chaos Cubed / Realm compatible, stable API 2.8.0
// ═══════════════════════════════════════════════════════════════════════════

// ─── DEFAULT CONFIG (all values overridable via medallion by vamp_op) ───────
const DEFAULTS = {
    SUN_DAMAGE:          2,      // HP per tick in direct sunlight
    VAMPIRE_BONUS_HP:    20,     // extra HP above vanilla 20 (must be multiple of 4)
    BAT_BLOOD_COST:      1,      // blood units per second while in bat form
    CLOAK_BLOOD_COST:    1,      // hunger units per second while cloak blocks sun
    TRANSFORM_DAYS:      3,      // days of human survival before turning
    PLAYERS_FEED:        false,  // whether killing players gives blood
    BAT_BOB_TICKS:       20,     // ticks per bob half-cycle (20 = 1s on, 1s off → 4s full bob)
    BAT_RISE_AMP:        1,      // levitation amplifier when space held (0=slow, 1=medium)
    BAT_EXIT_FEATHER:    60,     // ticks of slow_falling on bat form exit (60 = 3s)
};

// ─── RUNTIME CONFIG (loaded from world DynamicProperties on start) ──────────
let CFG = { ...DEFAULTS };

function loadConfig() {
    for (const key of Object.keys(DEFAULTS)) {
        const stored = world.getDynamicProperty("cfg_" + key);
        if (stored !== undefined) CFG[key] = stored;
    }
}

function saveConfig() {
    for (const key of Object.keys(DEFAULTS)) {
        try { world.setDynamicProperty("cfg_" + key, CFG[key]); } catch (_) {}
    }
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const HUNGER_MAX              = 20;
const HUNGER_WEAK_THRESHOLD   = 10;  // ≤ half → weakness
const HUNGER_SLOW_THRESHOLD   = 5;   // ≤ quarter → slowness
const HUNGER_STARVE_THRESHOLD = 0;   // empty → starvation damage

const BLOOD_FROM_ANIMAL  = 8;
const BLOOD_FROM_MONSTER = 14;
const BLOOD_FROM_PLAYER  = 20;
const BLOOD_FROM_VIAL    = 10;

const HELMET_MAX_EXPOSURE_SECS = 180;

const VALID_HELMET_IDS = [
    "minecraft:leather_helmet", "minecraft:chainmail_helmet",
    "minecraft:iron_helmet",    "minecraft:golden_helmet",
    "minecraft:diamond_helmet", "minecraft:netherite_helmet",
    "minecraft:turtle_helmet",
];

const ANIMAL_TYPES = [
    "minecraft:cow","minecraft:pig","minecraft:sheep","minecraft:chicken",
    "minecraft:rabbit","minecraft:horse","minecraft:donkey","minecraft:mule",
    "minecraft:llama","minecraft:fox","minecraft:wolf","minecraft:cat",
    "minecraft:ocelot","minecraft:panda","minecraft:polar_bear",
    "minecraft:mooshroom","minecraft:strider","minecraft:axolotl",
    "minecraft:goat","minecraft:frog","minecraft:sniffer","minecraft:camel",
    "minecraft:turtle","minecraft:cod","minecraft:salmon","minecraft:tropical_fish",
    "minecraft:pufferfish","minecraft:squid","minecraft:glow_squid","minecraft:bat",
    "minecraft:bee","minecraft:parrot","minecraft:allay",
];

// ─── STATE ────────────────────────────────────────────────────────────────────
let lastTime       = -1;
let _weather       = WeatherType.Clear;
const jumpTapMap   = new Map();  // playerId → lastJumpTick (for double-tap detection)

// Per-player bat flight state
// { bobTick: number, levUp: boolean }
const batFlightMap = new Map();

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function isCreativeOrSpectator(player) {
    const gm = player.getGameMode();
    return gm === GameMode.creative || gm === GameMode.spectator;
}

function getHunger(player) {
    try {
        const h = player.getComponent("minecraft:player.hunger");
        return h ? Math.floor(h.currentValue) : HUNGER_MAX;
    } catch (_) { return HUNGER_MAX; }
}

function setHunger(player, value) {
    try {
        const h = player.getComponent("minecraft:player.hunger");
        if (h) h.setCurrentValue(Math.max(0, Math.min(HUNGER_MAX, value)));
    } catch (_) {}
}

function adjustHunger(player, delta) {
    setHunger(player, getHunger(player) + delta);
}

// Save + restore HP across sessions
function saveHP(player) {
    try {
        const h = player.getComponent("minecraft:health");
        if (h) player.setDynamicProperty("saved_hp", h.currentValue);
    } catch (_) {}
}

function restoreHP(player) {
    try {
        const saved = player.getDynamicProperty("saved_hp");
        const h     = player.getComponent("minecraft:health");
        if (h && saved !== undefined) {
            system.runTimeout(() => {
                try { h.setCurrentValue(Math.min(saved, h.effectiveMax)); } catch (_) {}
            }, 3);
        }
    } catch (_) {}
}

// ─── WEATHER TRACKING ────────────────────────────────────────────────────────
world.afterEvents.weatherChange.subscribe((e) => {
    _weather = e.newWeather;
    try { world.setDynamicProperty("vamp_weather", e.newWeather); } catch (_) {}
});

// ─── WORLD INIT ──────────────────────────────────────────────────────────────
system.run(() => {
    loadConfig();
    try {
        const saved = world.getDynamicProperty("vamp_weather");
        if (saved === WeatherType.Rain || saved === WeatherType.Thunder) _weather = saved;
    } catch (_) {}
});

// ─── PLAYER SPAWN ─────────────────────────────────────────────────────────────
world.afterEvents.playerSpawn.subscribe((event) => {
    const { player, initialSpawn } = event;

    system.runTimeout(() => {
        // ── First-ever player to join gets vamp_op ──────────────────────────
        if (initialSpawn && !world.getDynamicProperty("vamp_op_assigned")) {
            world.setDynamicProperty("vamp_op_assigned", true);
            player.addTag("vamp_op");
            player.sendMessage("§5[Vampiric Descent] §7You are the server owner — vamp_op granted.");
        }

        // ── Give config medallion once ───────────────────────────────────────
        if (!player.getDynamicProperty("received_medallion")) {
            const inv = player.getComponent("minecraft:inventory")?.container;
            if (inv) {
                inv.addItem(new ItemStack("vamp:config_medallion", 1));
                player.setDynamicProperty("received_medallion", true);
            }
        }

        // ── Init transformation timer ────────────────────────────────────────
        if (player.getDynamicProperty("vampire_target_days") === undefined) {
            player.setDynamicProperty("vampire_target_days", CFG.TRANSFORM_DAYS);
            player.setDynamicProperty("vampire_current_days", 0);
        }

        // ── Vampire re-init on every spawn ───────────────────────────────────
        if (player.hasTag("vampire")) {
            applyVampireHealth(player, true);
            restoreHP(player);
            setHunger(player, getHunger(player));
            // Apply infinite night vision on spawn
            applyNightVision(player);
            // If they logged out in bat form, clean it up cleanly
            if (player.hasTag("bat_form")) {
                player.removeTag("bat_form");
                batFlightMap.delete(player.id);
            }
        }
    }, 20);
});

// ─── FLIGHT TOGGLE — double-tap Jump ─────────────────────────────────────────
world.afterEvents.playerButtonInput.subscribe((event) => {
    const { player, button, newButtonState } = event;
    if (button !== InputButton.Jump)            return;
    if (newButtonState !== ButtonState.Pressed) return;
    if (!player.hasTag("vampire"))              return;
    if (isCreativeOrSpectator(player))          return;

    const now     = system.currentTick;
    const lastTap = jumpTapMap.get(player.id) ?? -9999;
    const gap     = now - lastTap;

    if (gap <= 10 && gap > 0) {
        jumpTapMap.delete(player.id);
        if (player.hasTag("flight_cooldown")) return;
        player.addTag("flight_cooldown");
        system.runTimeout(() => { try { player.removeTag("flight_cooldown"); } catch (_) {} }, 10);

        const hunger = getHunger(player);
        if (player.hasTag("bat_form")) {
            exitBatForm(player);
        } else if (hunger > HUNGER_STARVE_THRESHOLD) {
            enterBatForm(player);
        } else {
            player.sendMessage("§4No blood to take bat form!");
        }
    } else {
        jumpTapMap.set(player.id, now);
    }
}, { buttons: [InputButton.Jump], state: ButtonState.Pressed });

// ─── PLAYER LEAVE ────────────────────────────────────────────────────────────
world.afterEvents.playerLeave.subscribe((event) => {
    jumpTapMap.delete(event.playerId);
    batFlightMap.delete(event.playerId);
});

// ─── NIGHT VISION (infinite — no flicker) ────────────────────────────────────
function applyNightVision(player) {
    try {
        player.addEffect("minecraft:night_vision", 9999999, { amplifier: 0, showParticles: false });
    } catch (_) {}
}

// ─── BAT FLIGHT ──────────────────────────────────────────────────────────────
// Called every tick (runInterval at 1 tick) only for players in bat_form.
// State machine per player:
//   - Space held          → levitation amp=BAT_RISE_AMP (rise)
//   - Sneak held          → remove levitation, slow_fall amp=0 (drift down)
//   - Moving horizontally → remove levitation (glide, gravity pulls gently)
//   - Idle                → bob: levitation on for BAT_BOB_TICKS, off for BAT_BOB_TICKS

function tickBatFlight(player) {
    if (!player.hasTag("bat_form")) return;
    if (!player.isValid) return;

    const hunger = getHunger(player);
    if (hunger <= HUNGER_STARVE_THRESHOLD) {
        exitBatForm(player);
        player.sendMessage("§4§oYour wings fail — no blood to sustain them!");
        return;
    }

    // Read input state
    const isJumping = player.isSprinting === undefined ? false : false; // placeholder
    const vel       = player.getVelocity();
    const isMovingH = (Math.abs(vel.x) + Math.abs(vel.z)) > 0.15;

    // We detect space/sneak via tags set by the button input subscriber below
    const spaceHeld = player.hasTag("bat_space");
    const sneakHeld = player.hasTag("bat_sneak");

    // Get or init flight state
    let state = batFlightMap.get(player.id);
    if (!state) {
        state = { bobTick: 0, levUp: true };
        batFlightMap.set(player.id, state);
    }

    if (spaceHeld) {
        // Rise — levitation on at higher amp
        player.addEffect("minecraft:levitation", 3, { amplifier: CFG.BAT_RISE_AMP, showParticles: false });
        // Remove slow_falling so rise feels snappy
        try { player.removeEffect("minecraft:slow_falling"); } catch (_) {}
        state.bobTick = 0; // reset bob phase when taking manual control

    } else if (sneakHeld) {
        // Descend — kill levitation, apply slow fall for a floaty drop
        try { player.removeEffect("minecraft:levitation"); } catch (_) {}
        player.addEffect("minecraft:slow_falling", 3, { amplifier: 0, showParticles: false });
        state.bobTick = 0;

    } else if (isMovingH) {
        // Gliding — no levitation, momentum carries, gentle gravity
        try { player.removeEffect("minecraft:levitation"); } catch (_) {}
        try { player.removeEffect("minecraft:slow_falling"); } catch (_) {}
        state.bobTick = 0;

    } else {
        // Idle bob — pulse levitation on/off every BAT_BOB_TICKS
        state.bobTick++;
        const half = CFG.BAT_BOB_TICKS;
        if (state.bobTick >= half * 2) state.bobTick = 0;

        if (state.bobTick < half) {
            // Rising half of bob
            player.addEffect("minecraft:levitation", 3, { amplifier: 0, showParticles: false });
            try { player.removeEffect("minecraft:slow_falling"); } catch (_) {}
        } else {
            // Falling half of bob
            try { player.removeEffect("minecraft:levitation"); } catch (_) {}
            player.addEffect("minecraft:slow_falling", 3, { amplifier: 0, showParticles: false });
        }
    }
}

// Track space and sneak held state via button events (per tick tags)
// NOTE: state filter must be a single ButtonState value, not an array — split into two subscribers.
world.afterEvents.playerButtonInput.subscribe((event) => {
    const { player, button } = event;
    if (!player.hasTag("bat_form")) return;
    if (button === InputButton.Jump)  player.addTag("bat_space");
    if (button === InputButton.Sneak) player.addTag("bat_sneak");
}, { buttons: [InputButton.Jump, InputButton.Sneak], state: ButtonState.Pressed });

world.afterEvents.playerButtonInput.subscribe((event) => {
    const { player, button } = event;
    if (!player.hasTag("bat_form")) return;
    if (button === InputButton.Jump)  try { player.removeTag("bat_space"); } catch (_) {}
    if (button === InputButton.Sneak) try { player.removeTag("bat_sneak"); } catch (_) {}
}, { buttons: [InputButton.Jump, InputButton.Sneak], state: ButtonState.Released });

// ─── MAIN LOOP (every 1 tick) ─────────────────────────────────────────────────
system.runInterval(() => {
    try {
        for (const player of world.getAllPlayers()) {
            if (!player.isValid) continue;
            if (!player.hasTag("bat_form")) continue;
            if (isCreativeOrSpectator(player)) continue;
            try { tickBatFlight(player); } catch (e) { console.warn("[BatFlight] " + e); }
        }
    } catch (e) { console.warn("[BatLoop] " + e); }
}, 1);

// ─── MAIN LOOP (every 20 ticks = 1 second) ───────────────────────────────────
system.runInterval(() => {
    try {
        const time      = world.getTimeOfDay();
        const isRaining = _weather === WeatherType.Rain || _weather === WeatherType.Thunder;
        const isDay     = time > 0 && time < 13000;

        if (lastTime === -1) lastTime = time;

        let dayPassed = (time < lastTime && lastTime > 20000);

        if (lastTime < 13000 && time >= 13000)       triggerLoreToVampires("sunset");
        else if ((lastTime > 23000 || lastTime === 0) && time > 0 && time < 1000)
            triggerLoreToVampires("sunrise");
        lastTime = time;

        for (const player of world.getAllPlayers()) {
            if (!player.isValid) continue;
            try {
                const creative = isCreativeOrSpectator(player);
                handleUIClock(player, time, isDay, isRaining);

                // ── Non-vampire ──────────────────────────────────────────────
                if (!player.hasTag("vampire")) {
                    if (dayPassed && !creative) {
                        let cur = player.getDynamicProperty("vampire_current_days") || 0;
                        const tgt = player.getDynamicProperty("vampire_target_days") || CFG.TRANSFORM_DAYS;
                        cur++;
                        player.setDynamicProperty("vampire_current_days", cur);
                        if (cur >= tgt) {
                            transformToVampire(player);
                        } else {
                            player.sendMessage(`§7[Nightfall] You have survived ${cur}/${tgt} days as a human...`);
                        }
                    }
                    continue;
                }

                if (creative) continue;

                // ── Night vision (re-apply every 30s in case of edge cases) ─
                // 9999999 ticks is ~139 real hours so this is just a safety net
                const nv = player.getEffect("minecraft:night_vision");
                if (!nv || nv.duration < 600) applyNightVision(player);

                // ── Persist HP each second ───────────────────────────────────
                saveHP(player);

                // ── Bat form blood drain (per second) ────────────────────────
                if (player.hasTag("bat_form")) {
                    adjustHunger(player, -CFG.BAT_BLOOD_COST);
                }

                // ── Night regen ──────────────────────────────────────────────
                if (!isDay) {
                    const health = player.getComponent("minecraft:health");
                    if (getHunger(player) > HUNGER_STARVE_THRESHOLD &&
                        health.currentValue < health.effectiveMax) {
                        player.addEffect("minecraft:regeneration", 22, { amplifier: 0, showParticles: false });
                    }
                }

                // ── Sun damage ───────────────────────────────────────────────
                if (isDay && player.dimension.id === "minecraft:overworld") {
                    if (isExposedToSky(player) && !isRaining) {
                        applySunDamage(player);
                    }
                }

            } catch (pe) {
                console.warn("[Vampire Player Error] " + pe);
            }
        }
    } catch (e) {
        console.warn("[Vampire Global Error] " + e);
    }
}, 20);

// ─── TRANSFORMATION ───────────────────────────────────────────────────────────
function transformToVampire(player) {
    player.addTag("vampire");
    setHunger(player, HUNGER_MAX);
    applyVampireHealth(player, true);
    applyNightVision(player);
    player.playSound("mob.wither.spawn");
    player.onScreenDisplay.setTitle("§4Vampiric Descent", {
        subtitle: "The thirst begins...",
        fadeInDuration: 20, remainDuration: 100, fadeOutDuration: 20,
    });
    triggerLoreMessage(player, "turned");
}

function applyVampireHealth(player, grant) {
    try {
        if (grant) {
            const amp = Math.max(0, Math.floor(CFG.VAMPIRE_BONUS_HP / 4) - 1);
            player.addEffect("minecraft:health_boost", 9999999, { amplifier: amp, showParticles: false });
        } else {
            player.removeEffect("minecraft:health_boost");
            system.runTimeout(() => {
                try {
                    const h = player.getComponent("minecraft:health");
                    if (h) h.setCurrentValue(Math.min(h.currentValue, 20));
                } catch (_) {}
            }, 5);
        }
    } catch (e) { console.warn("[VampHealth] " + e); }
}

// ─── BAT FORM ENTER / EXIT ────────────────────────────────────────────────────

function enterBatForm(player) {
    player.addTag("bat_form");
    batFlightMap.set(player.id, { bobTick: 0, levUp: true });
    // Clear any held-button tags from a previous form
    try { player.removeTag("bat_space"); } catch (_) {}
    try { player.removeTag("bat_sneak"); } catch (_) {}
    try {
        player.dimension.spawnParticle("minecraft:large_explosion", player.location);
    } catch (_) {}
    player.sendMessage("§5§oBat form! [Double-jump to return]");
    player.playSound("mob.bat.takeoff");
}

function exitBatForm(player) {
    player.removeTag("bat_form");
    batFlightMap.delete(player.id);
    try { player.removeTag("bat_space"); } catch (_) {}
    try { player.removeTag("bat_sneak"); } catch (_) {}
    // Kill any lingering levitation immediately
    try { player.removeEffect("minecraft:levitation"); } catch (_) {}
    // Feather fall on exit
    player.addEffect("minecraft:slow_falling", CFG.BAT_EXIT_FEATHER, { amplifier: 0, showParticles: false });
    player.sendMessage("§7§oBat form released.");
    player.playSound("mob.bat.hurt");
}

// ─── SKY EXPOSURE ─────────────────────────────────────────────────────────────
function isExposedToSky(player) {
    try {
        const headY = player.location.y + 1.62;
        if (headY >= 320) return true;
        const x = Math.floor(player.location.x);
        const z = Math.floor(player.location.z);
        for (let y = Math.floor(headY); y <= 319; y++) {
            const b = player.dimension.getBlock({ x, y, z });
            if (!b) continue;
            if (!b.isAir && !b.typeId.includes("glass") &&
                !b.typeId.includes("leaves") && !b.typeId.includes("fence") &&
                !b.typeId.includes("iron_bars")) return false;
        }
        return true;
    } catch (_) { return false; }
}

// ─── SUN DAMAGE ──────────────────────────────────────────────────────────────
function applySunDamage(player) {
    const equipment = player.getComponent("minecraft:equippable");
    const chest     = equipment?.getEquipment(EquipmentSlot.Chest);

    if (chest?.typeId === "vamp:vampire_cloak") {
        const hunger = getHunger(player);
        if (hunger > CFG.CLOAK_BLOOD_COST) {
            adjustHunger(player, -CFG.CLOAK_BLOOD_COST);
            return;
        }
        player.sendMessage("§c§oThe cloak falters — your blood runs dry!");
    }

    const helmet      = equipment?.getEquipment(EquipmentSlot.Head);
    const validHelmet = helmet && VALID_HELMET_IDS.includes(helmet.typeId);
    let   dmg         = CFG.SUN_DAMAGE;

    if (validHelmet) {
        dmg = CFG.SUN_DAMAGE * (1 - getHelmetTier(helmet.typeId));
        const dur = helmet.getComponent("minecraft:durability");
        if (dur) {
            const wear = Math.max(1, Math.ceil(dur.maxDurability / HELMET_MAX_EXPOSURE_SECS));
            if (dur.damage + wear >= dur.maxDurability) {
                equipment.setEquipment(EquipmentSlot.Head, undefined);
                player.playSound("random.break");
                player.sendMessage("§cYour helmet has crumbled to ash in the sun!");
            } else {
                dur.damage += wear;
                equipment.setEquipment(EquipmentSlot.Head, helmet);
            }
        }
    }

    const health = player.getComponent("minecraft:health");
    if (health.currentValue - dmg <= 0) {
        player.applyDamage(dmg, { cause: EntityDamageCause.fireTick });
    } else {
        player.applyDamage(dmg, { cause: EntityDamageCause.fireTick });
        player.setOnFire(1);
    }
}

function getHelmetTier(typeId) {
    if (typeId.includes("netherite")) return 0.60;
    if (typeId.includes("diamond"))   return 0.50;
    if (typeId.includes("iron"))      return 0.40;
    if (typeId.includes("chainmail")) return 0.30;
    if (typeId.includes("golden"))    return 0.25;
    if (typeId.includes("leather"))   return 0.20;
    if (typeId.includes("turtle"))    return 0.35;
    return 0.10;
}

// ─── BLOOD / HUNGER DRAIN ─────────────────────────────────────────────────────
function drainAndApplyDebuffs(player) {
    const h = Math.max(0, getHunger(player) - 1);
    setHunger(player, h);

    if (h <= HUNGER_STARVE_THRESHOLD) {
        player.applyDamage(1, { cause: EntityDamageCause.starve });
        player.sendMessage("§4§oThe thirst is consuming you...");
        player.addEffect("minecraft:weakness", 25, { amplifier: 1, showParticles: true });
        player.addEffect("minecraft:slowness",  25, { amplifier: 1, showParticles: true });
    } else if (h <= HUNGER_SLOW_THRESHOLD) {
        player.addEffect("minecraft:weakness", 25, { amplifier: 0, showParticles: false });
        player.addEffect("minecraft:slowness",  25, { amplifier: 0, showParticles: false });
    } else if (h <= HUNGER_WEAK_THRESHOLD) {
        player.addEffect("minecraft:weakness", 25, { amplifier: 0, showParticles: false });
        player.removeEffect("minecraft:slowness");
    } else {
        player.removeEffect("minecraft:weakness");
        player.removeEffect("minecraft:slowness");
    }
}

function feedBlood(player, amount) {
    adjustHunger(player, amount);
    const h = getHunger(player);
    if (h > HUNGER_WEAK_THRESHOLD) {
        player.removeEffect("minecraft:weakness");
        player.removeEffect("minecraft:slowness");
    } else if (h > HUNGER_SLOW_THRESHOLD) {
        player.removeEffect("minecraft:slowness");
    }
}

// ─── KILLS → BLOOD ───────────────────────────────────────────────────────────
world.afterEvents.entityDie.subscribe((event) => {
    const { deadEntity, damageSource } = event;
    const killer = damageSource?.damagingEntity;
    if (!killer || killer.typeId !== "minecraft:player") return;
    if (!killer.hasTag("vampire")) return;

    const t = deadEntity.typeId;
    if (t === "minecraft:player") {
        if (!CFG.PLAYERS_FEED) return;
        feedBlood(killer, BLOOD_FROM_PLAYER);
        killer.sendMessage("§4§oYou drain the last of their warmth...");
    } else if (ANIMAL_TYPES.includes(t)) {
        feedBlood(killer, BLOOD_FROM_ANIMAL);
        killer.sendMessage(`§7§o[+${BLOOD_FROM_ANIMAL} blood]`);
    } else if (t.startsWith("minecraft:")) {
        feedBlood(killer, BLOOD_FROM_MONSTER);
        killer.sendMessage(`§7§o[+${BLOOD_FROM_MONSTER} blood]`);
    }
});

// ─── GRAVE SYSTEM ────────────────────────────────────────────────────────────
world.afterEvents.entityDie.subscribe((event) => {
    const { deadEntity } = event;
    if (deadEntity.typeId !== "minecraft:player") return;
    if (!deadEntity.hasTag("vampire")) return;

    const player = deadEntity;
    try {
        if (player.hasTag("bat_form")) {
            player.removeTag("bat_form");
            batFlightMap.delete(player.id);
            try { player.removeEffect("minecraft:levitation"); } catch (_) {}
        }

        const loc = player.location;
        player.setDynamicProperty("grave_x",    Math.floor(loc.x));
        player.setDynamicProperty("grave_y",    Math.floor(loc.y));
        player.setDynamicProperty("grave_z",    Math.floor(loc.z));
        player.setDynamicProperty("grave_dim",  player.dimension.id);
        player.setDynamicProperty("grave_valid", true);

        world.sendMessage(
            `§8[§cGrave§8] §c${player.name}§7's grave is at §f${Math.floor(loc.x)}, ${Math.floor(loc.y)}, ${Math.floor(loc.z)}§7 — use your medallion to return.`
        );
    } catch (e) { console.warn("[Grave death error] " + e); }
});

function returnToGrave(player) {
    const valid = player.getDynamicProperty("grave_valid");
    if (!valid) {
        player.sendMessage("§7You have no grave to return to.");
        return;
    }
    const x   = player.getDynamicProperty("grave_x");
    const y   = player.getDynamicProperty("grave_y");
    const z   = player.getDynamicProperty("grave_z");
    const dim = player.getDynamicProperty("grave_dim") || "minecraft:overworld";

    try {
        const dimension = world.getDimension(dim);
        player.teleport({ x: x + 0.5, y, z: z + 0.5 }, { dimension });
        player.sendMessage("§8[Grave] §7Returned to your grave.");
    } catch (e) {
        player.sendMessage("§cCould not return to grave: " + e);
    }
}

// ─── MEDALLION USE ────────────────────────────────────────────────────────────
world.afterEvents.itemUse.subscribe((event) => {
    const { source: player, itemStack } = event;
    if (itemStack?.typeId !== "vamp:config_medallion") return;
    if (!player.isValid) return;
    system.run(() => {
        if (player.hasTag("vamp_op")) showOpMenu(player);
        else player.sendMessage(
            "§5[Vampiric Descent] §7Commands:\n" +
            "§f!vamp status §7— show your current stats\n" +
            "§f!vamp bat    §7— toggle bat form\n" +
            "§f!vamp grave  §7— return to your grave"
        );
    });
});

// ─── CHAT COMMANDS (!vamp ...) ───────────────────────────────────────────────
// All !vamp commands handled in one subscriber to avoid cancel-order conflicts.
world.beforeEvents.chatSend.subscribe((event) => {
    const msg = event.message.trim().toLowerCase();
    if (!msg.startsWith("!vamp")) return;

    event.cancel = true;
    const player = event.sender;
    const args   = msg.split(/\s+/);
    const sub    = args[1]; // "status" | "bat" | "grave" | "config" | "menu"

    system.run(() => {

        // ── !vamp config (OP only) ────────────────────────────────────────
        if (sub === "config") {
            if (!player.hasTag("vamp_op")) {
                player.sendMessage("§cYou need vamp_op to use config commands.");
                return;
            }
            const key = args[2];
            const val = parseFloat(args[3]);
            if (!key || isNaN(val)) {
                player.sendMessage(
                    "§4[vamp_op] §7Config commands:\n" +
                    "§f!vamp config sun <1-10>       §7— sun damage per tick\n" +
                    "§f!vamp config hp <4-80>        §7— bonus HP (multiple of 4)\n" +
                    "§f!vamp config bat <0-5>        §7— bat blood cost/sec\n" +
                    "§f!vamp config cloak <0-5>      §7— cloak blood cost/sec\n" +
                    "§f!vamp config days <1-30>      §7— days until transformation\n" +
                    "§f!vamp config bob <5-40>       §7— bat bob half-cycle ticks\n" +
                    "§f!vamp config rise <0-3>       §7— bat rise amplifier\n" +
                    "§f!vamp config feather <20-100> §7— feather fall ticks on bat exit\n" +
                    "§f!vamp config players <0/1>    §7— players grant blood on kill"
                );
                return;
            }
            const oldHp = CFG.VAMPIRE_BONUS_HP;
            let changed = true;
            switch (key) {
                case "sun":     CFG.SUN_DAMAGE      = Math.round(Math.min(10,  Math.max(1,  val)));          break;
                case "hp":      CFG.VAMPIRE_BONUS_HP = Math.round(Math.min(80,  Math.max(4,  val)) / 4) * 4; break;
                case "bat":     CFG.BAT_BLOOD_COST   = Math.round(Math.min(5,   Math.max(0,  val)));          break;
                case "cloak":   CFG.CLOAK_BLOOD_COST = Math.round(Math.min(5,   Math.max(0,  val)));          break;
                case "days":    CFG.TRANSFORM_DAYS   = Math.round(Math.min(30,  Math.max(1,  val)));          break;
                case "bob":     CFG.BAT_BOB_TICKS    = Math.round(Math.min(40,  Math.max(5,  val)) / 5) * 5; break;
                case "rise":    CFG.BAT_RISE_AMP     = Math.round(Math.min(3,   Math.max(0,  val)));          break;
                case "feather": CFG.BAT_EXIT_FEATHER = Math.round(Math.min(100, Math.max(20, val)) / 10) * 10; break;
                case "players": CFG.PLAYERS_FEED     = val !== 0; break;
                default: player.sendMessage(`§cUnknown config key: §f${key}`); changed = false;
            }
            if (changed) {
                saveConfig();
                if (key === "hp" && oldHp !== CFG.VAMPIRE_BONUS_HP) {
                    for (const p of world.getAllPlayers()) {
                        if (p.hasTag("vampire")) applyVampireHealth(p, true);
                    }
                }
                player.sendMessage(`§a[vamp_op] §f${key} §a→ §f${key === "players" ? (CFG.PLAYERS_FEED ? "ON" : "OFF") : val}`);
            }
            return;
        }

        // ── !vamp menu (OP UI) ──────────────────────────────────────────
        if (sub === "menu" || sub === "op") {
            if (!player.hasTag("vamp_op")) {
                player.sendMessage("§cYou need vamp_op to open the menu.");
            } else {
                showOpMenu(player);
            }
            return;
        }

        // ── !vamp status ─────────────────────────────────────────────────
        if (sub === "status") {
            const isVamp   = player.hasTag("vampire");
            const hunger   = getHunger(player);
            const curDays  = player.getDynamicProperty("vampire_current_days") || 0;
            const tgtDays  = player.getDynamicProperty("vampire_target_days")  || CFG.TRANSFORM_DAYS;
            const inBat    = player.hasTag("bat_form");
            const hasGrave = player.getDynamicProperty("grave_valid") ?? false;
            const health   = player.getComponent("minecraft:health");
            const hp       = health ? Math.ceil(health.currentValue / 2) : "?";
            const maxHp    = health ? Math.ceil(health.effectiveMax  / 2) : "?";
            player.sendMessage(
                "§5[Vampiric Descent]\n" +
                `§7Status: §f${isVamp ? "§4Vampire" : "§aHuman"}\n` +
                (isVamp
                    ? `§7Blood: §f${hunger}/20\n§7Health: §f${hp}/${maxHp} hearts\n`
                    : `§7Days survived: §f${curDays}/${tgtDays}\n`) +
                (inBat    ? "§5Currently in bat form.\n" : "") +
                (hasGrave ? "§8Grave is set." : "§8No grave set.")
            );

        // ── !vamp bat ────────────────────────────────────────────────────
        } else if (sub === "bat") {
            if (!player.hasTag("vampire")) {
                player.sendMessage("§4You must be a vampire to use bat form.");
            } else if (player.hasTag("bat_form")) {
                exitBatForm(player);
            } else if (getHunger(player) > HUNGER_STARVE_THRESHOLD) {
                enterBatForm(player);
            } else {
                player.sendMessage("§4Not enough blood for bat form!");
            }

        // ── !vamp grave ──────────────────────────────────────────────────
        } else if (sub === "grave") {
            const hasGrave = player.getDynamicProperty("grave_valid") ?? false;
            if (hasGrave) returnToGrave(player);
            else player.sendMessage("§cNo grave set yet.");

        // ── help ─────────────────────────────────────────────────────────
        } else {
            player.sendMessage(
                "§5[Vampiric Descent] §7Commands:\n" +
                "§f!vamp status §7— show your current stats\n" +
                "§f!vamp bat    §7— toggle bat form\n" +
                "§f!vamp grave  §7— return to your grave" +
                (player.hasTag("vamp_op") ? "\n§f!vamp menu   §7— open OP control panel\n§f!vamp config §7— server config (OP only)" : "")
            );
        }
    });
});

// ─── OP CHAT CONFIG COMMANDS (!vamp config ...) ───────────────────────────────
// Handled inside the main !vamp subscriber above.

function showOpMenu(player) {
    const isVamp   = player.hasTag("vampire");
    const inBat    = player.hasTag("bat_form");
    const hasGrave = player.getDynamicProperty("grave_valid") ?? false;

    const form = new ActionFormData()
        .title("§4[vamp_op] Server Controls")
        .body(
            "§7Manage vampire settings and player states.\n\n" +
            `§7Your state: §f${isVamp ? "§4Vampire" : "§aHuman"}\n` +
            `§7Bat form: §f${inBat ? "§5Active" : "§7Inactive"}\n` +
            `§7Grave: §f${hasGrave ? "§aSet" : "§cNone"}\n\n` +
            "§8Config is managed via §f!vamp config §8commands."
        )
        .button("§bToggle My Vampire State")
        .button("§aReturn to Grave")
        .button(inBat ? "§5Exit Bat Form" : "§5Enter Bat Form")
        .button("§cReset OP Assignment")
        .button("§7Close");

    form.show(player).then(response => {
        if (response.canceled) {
            if (response.cancelationReason === FormCancelationReason.UserBusy)
                system.run(() => showOpMenu(player));
            return;
        }
        switch (response.selection) {
            case 0: system.run(() => toggleVampireState(player)); break;
            case 1: system.run(() => {
                if (hasGrave) returnToGrave(player);
                else player.sendMessage("§c[OP] No grave set.");
            }); break;
            case 2: system.run(() => {
                if (inBat) exitBatForm(player);
                else if (player.hasTag("vampire") && getHunger(player) > HUNGER_STARVE_THRESHOLD)
                    enterBatForm(player);
                else player.sendMessage("§4Must be a vampire with blood for bat form.");
            }); break;
            case 3: system.run(() => {
                world.setDynamicProperty("vamp_op_assigned", false);
                player.sendMessage("§eOP assignment reset. Next fresh join will get vamp_op.");
            }); break;
        }
    }).catch(e => console.error("[OpMenu] " + e));
}

function toggleVampireState(player) {
    if (player.hasTag("vampire")) {
        player.removeTag("vampire");
        if (player.hasTag("bat_form")) exitBatForm(player);
        player.setDynamicProperty("vampire_current_days", 0);
        applyVampireHealth(player, false);
        try { player.removeEffect("minecraft:night_vision"); } catch (_) {}
        player.sendMessage("§e[OP] Reverted to human.");
        triggerLoreMessage(player, "cured");
    } else {
        transformToVampire(player);
        player.sendMessage("§e[OP] Transformed to vampire.");
    }
}

// ─── ACTION BAR CLOCK ────────────────────────────────────────────────────────
function handleUIClock(player, time, isDay, isRaining) {
    let ticksToNext = isDay ? (13000 - time) : (24000 - time);
    if (ticksToNext < 0) ticksToNext = 0;
    const mins      = Math.floor(Math.floor(ticksToNext / 20) / 60);
    const secs      = Math.floor(ticksToNext / 20) % 60;
    const timeStr   = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
    const nextPhase = isDay ? "Sunset" : "Sunrise";

    if (!player.hasTag("vampire")) {
        player.onScreenDisplay.setActionBar(
            `§7${isDay ? "Day" : "Night"} §8| §7Status: §eMortal (Immune) §8| §7${nextPhase}: §f${timeStr}`
        );
        return;
    }

    let status;
    const inBat = player.hasTag("bat_form");

    if (inBat) {
        const spaceHeld = player.hasTag("bat_space");
        const sneakHeld = player.hasTag("bat_sneak");
        const vel = player.getVelocity();
        const isMovingH = (Math.abs(vel.x) + Math.abs(vel.z)) > 0.15;
        const flightMode = spaceHeld ? "Rising" : sneakHeld ? "Descending" : isMovingH ? "Gliding" : "Bobbing";
        status = `§5Bat Form §8(${flightMode})`;
    } else if (!isDay) {
        status = "§9Moonlight (Safe)";
    } else {
        const exposed = isExposedToSky(player);
        const eq      = player.getComponent("minecraft:equippable");
        const chest   = eq?.getEquipment(EquipmentSlot.Chest);
        if (!exposed)
            status = "§aSheltered (Safe)";
        else if (chest?.typeId === "vamp:vampire_cloak")
            status = getHunger(player) > CFG.CLOAK_BLOOD_COST ? "§bCloak (Protected)" : "§cCloak (No Blood!)";
        else if (isRaining)
            status = "§bOvercast (Protected)";
        else
            status = "§cSunlight (Lethal)";
    }

    const flyIndicator = inBat ? " §5[✦BAT]" : "";
    player.onScreenDisplay.setActionBar(
        `§7${status}${flyIndicator} §8| §7${nextPhase}: §f${timeStr}`
    );
}

// ─── LORE ────────────────────────────────────────────────────────────────────
function triggerLoreToVampires(type) {
    for (const p of world.getAllPlayers()) {
        if (p.hasTag("vampire")) triggerLoreMessage(p, type);
    }
}

function triggerLoreMessage(player, type) {
    const msgs = {
        turned:  "§5Your heart slows. The sun feels suddenly harsh, but your senses sharpen.",
        cured:   "§eThe coldness leaves your veins. You feel mortal once again.",
        sunrise: "§cThe horizon burns. Seek shelter immediately.",
        sunset:  "§9The shadows lengthen. You are safe to roam.",
    };
    if (msgs[type]) {
        player.sendMessage(`§o${msgs[type]}`);
        player.playSound("ambient.cave");
    }
}