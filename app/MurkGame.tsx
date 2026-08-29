"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import * as THREE from "three";
import { createCreature, type CreatureBehavior, type CreatureEvasionPose, type CreatureEvasionVariant, type CreatureMotionPose } from "./creature";
import { createCargoFreighter, FREIGHTER_X, FREIGHTER_Z } from "./cargoFreighter";
import { createCreatureNest, NEST_PHOTO_EVIDENCE_VALUE, NEST_X, NEST_Z } from "./creatureNest";
import { createDrownedVillage, type WorldSolidBox } from "./drownedVillage";
import { createFishSystem } from "./fish";
import { createDrownedFlora } from "./flora";
import { createPhysicalEvidence, disposePhysicalEvidence, PHYSICAL_EVIDENCE_SITES } from "./evidence";

const WORLD_UP = new THREE.Vector3(0, 1, 0);
// Keep the opening boat well inside the basin. At 105 it sat almost on top of
// the raised north shoreline, so no physically useful fog density could hide
// the bank directly beside the player.
const BOAT_X = -32;
const BOAT_Z = 82;
const CREATURE_START_POSITION = { x: 66, y: -18, z: -22 } as const;
const WORLD_LIMIT = 132;
const OPENING_SECLUSION_MS = 115000;
const OPENING_HARD_SECLUSION_MS = 45000;
const EARLY_SIGHTING_OPPORTUNITY_CHANCE = .15;
const EARLY_SIGHTING_START_MIN_MS = 50000;
const EARLY_SIGHTING_START_MAX_MS = 78000;
const EARLY_SIGHTING_DURATION_MIN_MS = 17000;
const EARLY_SIGHTING_DURATION_MAX_MS = 25000;
const EARLY_SIGHTING_EXIT_MS = 10000;
const PASSIVE_CAMERA_CONE_DOT = .92;
const PASSIVE_CAMERA_CONE_REROLL_CHANCE = .62;
const FREE_SWIM_SPEED = 2.55 * 1.25;
const BOAT_WALK_SPEED = 2.05 * 1.25;
const CREATURE_CRUISE_SPEED = 7.8;
const EVASION_SPEED_FLOOR = CREATURE_CRUISE_SPEED * 1.38;
const CREATURE_CAVE_SETTLE_MS = 3400;
const CREATURE_CAVE_DEPARTURE_MS = 3600;
const SILHOUETTE_FAILSAFE_DELAY_MS = 210000;
const SILHOUETTE_RETRY_MIN_MS = 65000;
const SILHOUETTE_RETRY_MAX_MS = 105000;
const SILHOUETTE_MAX_ATTEMPTS = 2;
const FLOODLIGHT_RUNTIME_SECONDS = 20;
const FLOODLIGHT_RECHARGE_SECONDS = 20;
const FLOODLIGHT_VISUAL_RANGE = 88;
const FLOODLIGHT_TARGET_DISTANCE = 44;
const FLOODLIGHT_INTENSITY = 1020;
const CREATURE_AUDIO_GAIN_MULTIPLIER = 1.48;
const PASSIVE_NEUTRAL_CALL_MIN_INTERVAL_MS = 30000;
const PASSIVE_NEUTRAL_CALL_MAX_INTERVAL_MS = 62000;
const SONAR_COOLDOWN_MS = 30000;
const INTRO_MUSIC_SWELL_OFFSET_SECONDS = 20;
const PROLOGUE_LINE_MS = 2400;
const PROLOGUE_FIRST_LINE_DELAY_MS = 450;
const PROLOGUE_FINAL_HOLD_MS = 2700;
const PROLOGUE_LINES = [
  "Twenty years ago, you came to this lake with your parents for a picnic.",
  "As they finished eating, you stood on the shore, staring across the foggy water.",
  "That’s when you saw it: something big moving beneath the surface.",
  "You called out to your parents, but by the time they looked, it was gone.",
  "Now, you’re back to prove what you saw.",
] as const;

type EvidenceGrade = "S" | "A" | "B" | "C" | "D" | "F";

function evaluateDiveGrade(
  goodPhotographs: number,
  physicalPieces: number,
  attemptedPhotographs: number,
): EvidenceGrade {
  // S always requires strong proof in both categories. Lower grades step
  // backward by completeness rather than letting raw low-value snapshots
  // substitute for a balanced body of evidence.
  if (goodPhotographs >= 2 && physicalPieces >= 2) return "S";
  if ((goodPhotographs >= 2 && physicalPieces >= 1)
    || (goodPhotographs >= 1 && physicalPieces >= 2)) return "A";
  if ((goodPhotographs >= 1 && physicalPieces >= 1)
    || goodPhotographs >= 2
    || physicalPieces >= 2) return "B";
  if (goodPhotographs >= 1 || physicalPieces >= 1) return "C";
  if (attemptedPhotographs > 0) return "D";
  return "F";
}

function keepInsideLake(point: THREE.Vector3, radius = 108) {
  const normalizedX = point.x / 1.04;
  const distance = Math.hypot(normalizedX, point.z);
  if (distance <= radius) return point;
  const scale = radius / distance;
  point.x *= scale;
  point.z *= scale;
  return point;
}

function terrainHeight(x: number, z: number) {
  const basin = -24 + Math.sin(x * 0.055) * 1.9 + Math.cos(z * 0.047) * 1.4 + Math.sin((x + z) * 0.025) * 1.2;
  const cliffEdge = 31 + Math.sin(z * .11) * 1.35 + Math.sin(z * .031) * .7;
  const rawCliff = THREE.MathUtils.clamp((x - cliffEdge) / 4.2, 0, 1);
  const cliffT = rawCliff * rawCliff * (3 - 2 * rawCliff);
  const drop = cliffT * (23 + Math.sin(z * .17) * 2.8);
  const northShore = THREE.MathUtils.smoothstep(z, 68, 126) * 19;
  const westernShelf = THREE.MathUtils.smoothstep(-x, 88, 132) * 7;
  const shoreDistance = Math.hypot(x / 1.04, z);
  const shoreVariation = Math.sin(Math.atan2(z, x) * 5) * 3.4
    + Math.sin(Math.atan2(z, x) * 11 + 1.7) * 1.7;
  const shorelineRise = THREE.MathUtils.smoothstep(shoreDistance, 108 + shoreVariation, 132 + shoreVariation) * 78;
  return basin - drop + northShore + westernShelf + shorelineRise;
}

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const postVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const postFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform vec2 resolution;
  uniform float time;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float surfaceFog;
  uniform vec3 surfaceFogColor;
  uniform float breathDebt;
  uniform float flashBlind;
  uniform float submersionShock;
  uniform float foundFootage;
  varying vec2 vUv;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i+vec2(1.,0.)), f.x),
               mix(hash21(i+vec2(0.,1.)), hash21(i+vec2(1.)), f.x), f.y);
  }

  float viewDepth(float depthSample) {
    return (cameraNear * cameraFar) / max(.0001, cameraFar - depthSample * (cameraFar - cameraNear));
  }

  void main() {
    vec2 screenCentered = vUv * 2.0 - 1.0;
    vec2 centered = screenCentered;
    centered.x *= resolution.x / resolution.y;
    float r2 = dot(centered, centered);
    vec2 warped = centered * (1.0 + 0.032 * r2 + 0.004 * r2 * r2);
    warped.x /= resolution.x / resolution.y;
    vec2 uv = warped * .5 + .5;
    uv += vec2(
      sin(time * .71) * .00042 + sin(time * 2.13) * .00012,
      sin(time * .43 + 1.2) * .00031
    ) * foundFootage;

    uv = clamp(uv, vec2(.001), vec2(.999));
    vec2 texel = 1.0 / max(resolution, vec2(1.0));
    // Keep found-footage colour fringing subtle and uniform. Scaling it with
    // lens radius produced intermittent red/green slashes at the deep-zone
    // edge of the visor.
    float chroma = foundFootage * .92 * texel.x;
    vec3 col;
    col.r = texture2D(tDiffuse, uv + vec2(chroma, 0.0)).r;
    col.g = texture2D(tDiffuse, uv).g;
    col.b = texture2D(tDiffuse, uv - vec2(chroma, 0.0)).b;
    float depthSample = texture2D(tDepth, uv).r;
    float sceneDepth = viewDepth(depthSample);
    vec3 soft = (
      texture2D(tDiffuse, uv + vec2(texel.x * 2.0, 0.0)).rgb
      + texture2D(tDiffuse, uv - vec2(texel.x * 2.0, 0.0)).rgb
      + texture2D(tDiffuse, uv + vec2(0.0, texel.y * 2.0)).rgb
      + texture2D(tDiffuse, uv - vec2(0.0, texel.y * 2.0)).rgb
    ) * .25;
    float halation = smoothstep(.58, 1.35, max(max(soft.r, soft.g), soft.b));
    col += soft * halation * .055;
    // The vignette belongs to screen space, not aspect-corrected lens space.
    // Using the lens-space coordinate here produced vertical bars on wide screens.
    float vignette = smoothstep(1.16, .48, length(screenCentered * vec2(.92, 1.0)));

    vec2 dropUv = centered * vec2(7., 5.5) + vec2(1.7, -time*.006);
    vec2 cell = floor(dropUv); vec2 fp = fract(dropUv) - .5;
    vec2 seed = vec2(hash21(cell), hash21(cell + 8.17));
    vec2 dropCenter = (seed - .5) * .54;
    float drop = smoothstep(.24, .075, length(fp - dropCenter));
    drop *= step(.79, hash21(cell + 2.4));
    float haze = noise(centered * 2.3 + vec2(0., time*.008)) * .025;

    float grain = hash21(gl_FragCoord.xy + fract(time * 61.7)) - .5;
    float scanline = sin((gl_FragCoord.y + time * 5.4) * 1.54) * (.001 + foundFootage * .016);
    float tracking = smoothstep(.985, 1.0, sin(vUv.y * 39.0 - time * .46) * .5 + .5);
    float tapeBand = smoothstep(.88, 1.0, sin(vUv.y * 18.0 - time * .37) * .5 + .5);
    float edgeWet = smoothstep(.62, 1.05, length(centered * vec2(.72, 1.0)));
    col += grain * (.008 + foundFootage * .047) + scanline + drop * .032 + haze;
    col *= 1.0 - tracking * (.004 + foundFootage * .052) - tapeBand * foundFootage * .012;
    float exposureFlutter = 1.0 + foundFootage * (sin(time * 3.7) * .014 + sin(time * .83) * .024);
    col *= exposureFlutter;
    col = pow(max(col, 0.0), vec3(mix(1.0, .90, foundFootage)));
    col *= mix(vec3(1.0), vec3(.91, 1.035, .95), foundFootage);
    // Surface fog is composited from actual scene depth, so it keeps hiding
    // distant shores even when the diver looks down across the waterline.
    // Two slow noise scales break up the boundary like moving fog banks while
    // the short 6-27 m sightline does the same practical work as classic
    // survival-horror distance fog.
    float fogNoise = noise(screenCentered * 2.35 + vec2(time * .018, -time * .009));
    fogNoise += noise(screenCentered * 5.7 + vec2(-time * .012, time * .007)) * .42;
    float fogDistance = sceneDepth + (fogNoise - .66) * 7.0;
    float distanceFog = smoothstep(6.0, 27.0, fogDistance) * surfaceFog;
    // Only the untouched far-plane value is sky. A looser cutoff classified
    // remote shoreline geometry as sky because perspective depth approaches
    // 1.0 quickly, making some sections of the mountain ring disappear.
    float skyPixel = step(1.0, depthSample);
    distanceFog = max(distanceFog, skyPixel * surfaceFog);
    vec3 livingFog = surfaceFogColor * (1.0 + (fogNoise - .62) * .075);
    // Leave a trace more contrast in fogged geometry than in the open sky.
    // This keeps Greenwake's enclosing mountain silhouette barely legible
    // without increasing the practical sightline through the fog.
    float fogOpacity = min(clamp(distanceFog, 0.0, .985), mix(.94, .985, skyPixel));
    livingFog = mix(livingFog, livingFog * 1.08, skyPixel * surfaceFog);
    col = mix(col, livingFog, fogOpacity);
    col += vec3(.014, .021, .013) * vignette;
    col *= mix(.91, 1.0, vignette);
    col *= mix(1.0, mix(.95, 1.0, vignette), foundFootage);
    float tunnelRadius = .94 - breathDebt * .36;
    float tunnelEdge = smoothstep(tunnelRadius * .58, tunnelRadius, length(centered * vec2(.7, .96)));
    float heartPulse = .95 + .05 * sin(time * (5.0 + breathDebt * 6.0));
    col *= mix(1.0, 1.0 - tunnelEdge * .88, breathDebt * .78);
    col *= mix(1.0, heartPulse, breathDebt);

    float flashBloom = smoothstep(1.28, .08, length(centered * vec2(.8, 1.0)));
    col = mix(col, vec3(1.0, .92, .69), flashBlind * (.72 + flashBloom * .28));
    float entryTurbidity = noise(centered * 5.4 + vec2(time * .8, -time * .35));
    vec3 entryDark = vec3(.008, .029, .016) + entryTurbidity * vec3(.018, .024, .012);
    col = mix(col, entryDark, submersionShock * (.84 + entryTurbidity * .12));

    gl_FragColor = vec4(col, 1.0);
  }
`;

export default function MurkGame() {
  const mountRef = useRef<HTMLDivElement>(null);
  const exitButtonRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<() => void>(() => undefined);
  const introAudioRef = useRef<() => void>(() => undefined);
  const resumeRef = useRef<() => void>(() => undefined);
  const restartRef = useRef<() => void>(() => undefined);
  const inputLockRef = useRef<() => void>(() => undefined);
  const foundFootageRef = useRef(true);
  const [started, setStarted] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [canDive, setCanDive] = useState(false);
  const [air, setAir] = useState(100);
  const [depth, setDepth] = useState(0);
  const [mapPosition, setMapPosition] = useState({ x: 50, y: 19 });
  const [, setLampOn] = useState(true);
  const [, setFloodOn] = useState(false);
  const [mapHeld, setMapHeld] = useState(false);
  const [cameraHeld, setCameraHeld] = useState(false);
  const [cameraTransitionKey, setCameraTransitionKey] = useState(0);
  const [cameraHintVisible, setCameraHintVisible] = useState(false);
  const [breathHeld, setBreathHeld] = useState(false);
  const [breathEvent, setBreathEvent] = useState("");
  const [fatalCause, setFatalCause] = useState("");
  const [fatalDetail, setFatalDetail] = useState("");
  const [exposures, setExposures] = useState(6);
  const [dropLights, setDropLights] = useState(2);
  const [divePhase, setDivePhase] = useState<"briefing" | "onboat" | "entry" | "search" | "complete">("briefing");
  const [carryLabels, setCarryLabels] = useState<string[]>([]);
  const [photoCount, setPhotoCount] = useState(0);
  const [evidencePrompt, setEvidencePrompt] = useState("");
  const [evidenceEvent, setEvidenceEvent] = useState("");
  const [bankedValue, setBankedValue] = useState(0);
  const [diveGrade, setDiveGrade] = useState<EvidenceGrade>("F");
  const [goodPhotoCount, setGoodPhotoCount] = useState(0);
  const [physicalEvidenceCount, setPhysicalEvidenceCount] = useState(0);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const [reviewingPhotos, setReviewingPhotos] = useState(false);
  const [photoReviewIndex, setPhotoReviewIndex] = useState(0);
  const [sonarBearing, setSonarBearing] = useState<number | null>(null);
  const [sonarMapPosition, setSonarMapPosition] = useState<{ x: number; y: number } | null>(null);
  const [sonarReadiness, setSonarReadiness] = useState(1);
  const [foundFootage, setFoundFootage] = useState(true);
  const [prologueActive, setPrologueActive] = useState(false);
  const [prologueLine, setPrologueLine] = useState(-1);
  const [prologueReady, setPrologueReady] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const registerServiceWorker = () => {
      const serviceWorkerUrl = new URL("sw.js", document.baseURI).toString();
      void navigator.serviceWorker.register(serviceWorkerUrl).catch(() => undefined);
    };
    if (document.readyState === "complete") registerServiceWorker();
    else window.addEventListener("load", registerServiceWorker, { once: true });
    return () => window.removeEventListener("load", registerServiceWorker);
  }, []);

  useEffect(() => {
    if (exitButtonRef.current) {
      exitButtonRef.current.textContent = Math.random() < .05 ? "RUN AWAY" : "EXIT";
    }
  }, []);

  useEffect(() => {
    const mountNode = mountRef.current;
    if (!mountNode) return;
    const mount: HTMLDivElement = mountNode;

    const scene = new THREE.Scene();
    const shallowWater = new THREE.Color(0x337b50);
    const thermoWater = new THREE.Color(0x756a32);
    const deepWater = new THREE.Color(0x010302);
    const waterColor = new THREE.Color(0x243629);
    const stormWater = new THREE.Color(0x719982);
    const surfaceFogTint = new THREE.Color(0x6f8177);
    const atmosphereColor = new THREE.Color();
    scene.background = waterColor;
    scene.fog = new THREE.FogExp2(waterColor, 0.125);

    // The raised shoreline reaches almost exactly the former 285 m far plane
    // from the opening camera. That razor-thin margin clipped individual
    // mountain sections as the view bobbed. Keep the whole 280 m lake mesh
    // comfortably inside the frustum.
    const camera = new THREE.PerspectiveCamera(72, 1, 0.06, 420);
    const searchParams = new URLSearchParams(window.location.search);
    const auditBand = searchParams.get("band");
    const lakeAudit = searchParams.get("lake");
    const descentAudit = searchParams.get("descent") === "1";
    const evidenceAudit = searchParams.get("evidence") === "1";
    const nestAudit = searchParams.get("nest") === "1";
    const returnAudit = searchParams.get("return") === "1";
    const creatureAttackAudit = searchParams.get("attack") === "1";
    const creatureVocalAudit = searchParams.get("vocal") === "1";
    const silhouetteAudit = searchParams.get("silhouette") === "1";
    const monsterModelAudit = searchParams.get("monsterModel");
    const monsterPoseAudit = searchParams.get("monsterPose");
    const earlySightingAudit = searchParams.get("earlySight") === "1";
    const passiveBiasAudit = searchParams.get("passiveBias") === "1";
    const evidenceModelAudit = searchParams.get("evidenceModel");
    const directAudit = !descentAudit && [...searchParams.keys()].length > 0;
    const auditHold = searchParams.get("hold") === "1";
    const auditHide = searchParams.get("hide") === "1";
    const auditY = auditBand === "shallow" ? -5.5 : auditBand === "thermocline" ? -12.5 : -18.2;
    camera.position.set(0, auditY, 16);
    // Before the dive begins, the actual scene camera rests just above the
    // real lake surface and looks toward the real workboat. The title screen
    // is therefore the game world itself rather than a parallel illustration.
    if (!directAudit) camera.position.set(BOAT_X - 13.8, .52, BOAT_Z - 7.4);
    if (auditHide) {
      camera.position.set(-7.2, terrainHeight(-7.2, 8) + 1.62, 8);
    }
    if (lakeAudit === "village") camera.position.set(11.3, -7, -20);
    if (lakeAudit === "villagefloor") camera.position.set(3.8, -18, -6.2);
    if (lakeAudit === "villagehouses") camera.position.set(-4.5, terrainHeight(-4.5, -18) + 3.2, -18);
    if (lakeAudit === "forest") camera.position.set(-38, -19, 12.5);
    if (lakeAudit === "lines") camera.position.set(13, -18.2, 15.5);
    if (lakeAudit === "dropoff") camera.position.set(18, terrainHeight(18, 2) + 2.1, 2);
    if (lakeAudit === "boat") camera.position.set(BOAT_X + 4.8, 1.42, BOAT_Z - 9.4);
    if (lakeAudit === "grass") camera.position.set(-70, terrainHeight(-70, 21) + 2.15, 31);
    if (lakeAudit === "pillars") camera.position.set(33, -15, 18);
    if (lakeAudit === "rays") camera.position.set(74, -3.4, 26);
    if (lakeAudit === "creatureskin") camera.position.set(72, -14, 40);
    if (monsterModelAudit) camera.position.set(72, -14, 55);
    if (lakeAudit === "creaturecave") camera.position.set(-64, terrainHeight(-64, -55) + 5.4, -55);
    if (lakeAudit === "fish") camera.position.set(-69, terrainHeight(-69, 41) + 3.7, 41);
    if (lakeAudit === "freighter") camera.position.set(FREIGHTER_X - 17, terrainHeight(FREIGHTER_X - 17, FREIGHTER_Z) + 4.8, FREIGHTER_Z + 1);
    if (lakeAudit === "nest") camera.position.set(NEST_X - 4, terrainHeight(NEST_X - 4, NEST_Z) + 2.7, NEST_Z);
    if (silhouetteAudit) camera.position.set(-65, -17, 28);
    if (evidenceAudit) camera.position.set(-3, terrainHeight(-3, 6) + 1.72, 8.15);
    if (nestAudit) camera.position.set(NEST_X - 4, terrainHeight(NEST_X - 4, NEST_Z) + 2.7, NEST_Z);
    if (returnAudit) camera.position.set(BOAT_X, -1.15, BOAT_Z - 3);
    camera.rotation.order = "YXZ";

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = "game-canvas";
    mount.appendChild(renderer.domElement);
    // Keep the lock target on the WebGL canvas, matching the stable V20-V23
    // input path. The canvas survives pause and restart for the entire mount.
    const inputSurface = renderer.domElement;

    const target = new THREE.WebGLRenderTarget(2, 2, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    target.depthTexture = new THREE.DepthTexture(2, 2, THREE.UnsignedIntType);
    target.depthTexture.format = THREE.DepthFormat;

    const postScene = new THREE.Scene();
    const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const postMaterial = new THREE.ShaderMaterial({
      vertexShader: postVertex,
      fragmentShader: postFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: target.texture },
        tDepth: { value: target.depthTexture },
        resolution: { value: new THREE.Vector2(1, 1) },
        time: { value: 0 },
        cameraNear: { value: camera.near },
        cameraFar: { value: camera.far },
        surfaceFog: { value: 0 },
        surfaceFogColor: { value: new THREE.Color(0x60786b) },
        breathDebt: { value: 0 },
        flashBlind: { value: 0 },
        submersionShock: { value: 0 },
        foundFootage: { value: 1 },
      },
    });
    postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));

    const hemi = new THREE.HemisphereLight(0xc4c8c3, 0x071009, 0.78);
    scene.add(hemi);
    const daylight = new THREE.DirectionalLight(0xd8ded8, 1.45);
    daylight.position.set(-24, 52, 18);
    scene.add(daylight);
    const diverLight = new THREE.SpotLight(0xffe4ac, 190, 31, Math.PI * 0.22, 0.72, 1.18);
    const pilotLight = new THREE.SpotLight(0xffca82, 26, 3.2, Math.PI * 0.26, .82, 1.7);
    const floodLight = new THREE.SpotLight(0xffe8c0, 0, FLOODLIGHT_VISUAL_RANGE, Math.PI * .19, .92, 1.28);
    const flashLight = new THREE.PointLight(0xffedc7, 0, 22, 1.25);
    flashLight.position.set(0, .02, -.28);
    camera.add(flashLight);
    const lightTarget = new THREE.Object3D();
    const floodTarget = new THREE.Object3D();
    scene.add(diverLight, pilotLight, floodLight, lightTarget, floodTarget);
    diverLight.target = lightTarget;
    pilotLight.target = lightTarget;
    floodLight.target = floodTarget;

    const beamGeo = new THREE.ConeGeometry(4.2, 15, 12, 1, true);
    beamGeo.rotateX(Math.PI / 2);
    beamGeo.translate(0, 0, -7.5);
    const beamMaterial = new THREE.MeshBasicMaterial({
      color: 0xffcc6c,
      transparent: true,
      opacity: .072,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const beamVolume = new THREE.Mesh(beamGeo, beamMaterial);
    beamVolume.renderOrder = 2;
    camera.add(beamVolume);
    const coreGeo = new THREE.ConeGeometry(1.85, 12.5, 12, 1, true);
    coreGeo.rotateX(Math.PI / 2);
    coreGeo.translate(0, 0, -6.25);
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: 0xffe8b5,
      transparent: true,
      opacity: .065,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const coreVolume = new THREE.Mesh(coreGeo, coreMaterial);
    coreVolume.renderOrder = 3;
    camera.add(coreVolume);

    // The helmet lamp is real camera-parented geometry. The CSS visor is
    // deliberately left above the canvas so its ring hides most of the body
    // while the bulb and cage peek into the upper-left of the glass.
    const helmetLampRoot = new THREE.Group();
    helmetLampRoot.position.set(-.90, .80, -.82);
    helmetLampRoot.rotation.set(-.436, -.035, .140);
    helmetLampRoot.scale.setScalar(1.12);
    helmetLampRoot.visible = false;
    camera.add(helmetLampRoot);

    const HELMET_LAMP_RENDER_ORDER = 1200;
    const helmetLampGeometries: THREE.BufferGeometry[] = [];
    const helmetLampBrass = new THREE.MeshStandardMaterial({ color: 0x6d6247, roughness: .62, metalness: .55 });
    const helmetLampSteel = new THREE.MeshStandardMaterial({ color: 0x4a4d44, roughness: .54, metalness: .68 });
    const helmetLampRubber = new THREE.MeshStandardMaterial({ color: 0x2a2d26, roughness: .9, metalness: .08 });
    const helmetLampGlass = new THREE.MeshStandardMaterial({
      color: 0xffcf75,
      emissive: 0xffb84d,
      emissiveIntensity: 1.45,
      transparent: true,
      opacity: .92,
      roughness: .2,
      metalness: 0,
    });
    const lampMesh = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
      helmetLampGeometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = HELMET_LAMP_RENDER_ORDER;
      mesh.frustumCulled = false;
      return mesh;
    };

    const lampBodyLength = .24;
    const lampBodyRadius = .105;
    const lampRimRadius = lampBodyRadius * 1.38;
    const lampGlassRadius = .105;
    const lampGlassDepth = lampGlassRadius * 1.56;
    const lampCageRadius = Math.max(lampRimRadius, lampGlassRadius * 1.18);
    const lampCageDepth = lampGlassDepth * 1.18;
    const lampRimZ = -lampBodyLength - .025;

    const lampBody = lampMesh(new THREE.CylinderGeometry(lampBodyRadius, lampBodyRadius * .87, lampBodyLength, 12), helmetLampBrass);
    lampBody.rotation.x = Math.PI / 2;
    lampBody.position.z = -lampBodyLength / 2;
    helmetLampRoot.add(lampBody);
    const lampBackCap = lampMesh(new THREE.CylinderGeometry(.11, .11, .025, 12), helmetLampSteel);
    lampBackCap.rotation.x = Math.PI / 2;
    lampBackCap.position.z = .008;
    helmetLampRoot.add(lampBackCap);
    const lampGland = lampMesh(new THREE.CylinderGeometry(.042, .056, .075, 9), helmetLampRubber);
    lampGland.rotation.x = Math.PI / 2;
    lampGland.position.z = .055;
    helmetLampRoot.add(lampGland);
    const lampFlange = lampMesh(new THREE.CylinderGeometry(lampRimRadius, lampRimRadius, .032, 12), helmetLampBrass);
    lampFlange.rotation.x = Math.PI / 2;
    lampFlange.position.z = -lampBodyLength - .01;
    helmetLampRoot.add(lampFlange);
    const lampCollar = lampMesh(new THREE.CylinderGeometry(lampGlassRadius * 1.05, lampGlassRadius * .94, .05, 12), helmetLampSteel);
    lampCollar.rotation.x = Math.PI / 2;
    lampCollar.position.z = -lampBodyLength - .045;
    helmetLampRoot.add(lampCollar);

    const lampBulb = lampMesh(
      new THREE.SphereGeometry(lampGlassRadius, 12, 6, 0, Math.PI * 2, 0, Math.PI * .62),
      helmetLampGlass,
    );
    lampBulb.rotation.x = -Math.PI / 2;
    lampBulb.position.z = -lampBodyLength - .068;
    lampBulb.scale.set(1, 1.56, 1);
    lampBulb.receiveShadow = true;
    helmetLampRoot.add(lampBulb);

    const helmetLampGlowCanvas = document.createElement("canvas");
    helmetLampGlowCanvas.width = 96;
    helmetLampGlowCanvas.height = 96;
    const helmetLampGlowContext = helmetLampGlowCanvas.getContext("2d");
    if (helmetLampGlowContext) {
      const gradient = helmetLampGlowContext.createRadialGradient(48, 48, 2, 48, 48, 48);
      gradient.addColorStop(0, "rgba(255,249,206,.92)");
      gradient.addColorStop(.16, "rgba(255,220,123,.62)");
      gradient.addColorStop(.48, "rgba(255,190,76,.2)");
      gradient.addColorStop(1, "rgba(255,168,57,0)");
      helmetLampGlowContext.fillStyle = gradient;
      helmetLampGlowContext.fillRect(0, 0, 96, 96);
    }
    const helmetLampGlowTexture = new THREE.CanvasTexture(helmetLampGlowCanvas);
    helmetLampGlowTexture.colorSpace = THREE.SRGBColorSpace;
    const helmetLampGlowMaterial = new THREE.SpriteMaterial({
      map: helmetLampGlowTexture,
      color: 0xffdf8a,
      transparent: true,
      opacity: .48,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const helmetLampGlow = new THREE.Sprite(helmetLampGlowMaterial);
    helmetLampGlow.position.set(0, 0, -lampBodyLength - .19);
    helmetLampGlow.scale.set(.46, .46, 1);
    // Keep the additive aura above the world but behind the actual lamp. This
    // preserves the cage silhouette instead of bleaching its dark bars.
    helmetLampGlow.renderOrder = HELMET_LAMP_RENDER_ORDER - 1;
    helmetLampGlow.frustumCulled = false;
    helmetLampRoot.add(helmetLampGlow);

    const cageEndPhi = (Math.PI / 2) * .92;
    let lampHubZ = lampRimZ;
    for (let bar = 0; bar < 6; bar++) {
      const angle = (bar / 6) * Math.PI * 2;
      const points: THREE.Vector3[] = [];
      for (let segment = 0; segment <= 13; segment++) {
        const progress = segment / 13;
        const phi = progress * cageEndPhi;
        const radius = lampCageRadius * Math.cos(phi);
        const z = lampRimZ + lampBodyLength * .06 - lampCageDepth * Math.sin(phi);
        points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, z));
        if (segment === 13) lampHubZ = z;
      }
      const cageBar = lampMesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, false, "centripetal"), 13, .014, 4, false),
        helmetLampSteel,
      );
      cageBar.renderOrder = HELMET_LAMP_RENDER_ORDER + 1;
      cageBar.castShadow = true;
      helmetLampRoot.add(cageBar);
    }
    for (let ring = 1; ring <= 2; ring++) {
      const progress = ring / 3;
      const phi = progress * cageEndPhi;
      const ringRadius = lampCageRadius * Math.cos(phi);
      const cageRing = lampMesh(new THREE.TorusGeometry(ringRadius, .012, 4, 28), helmetLampSteel);
      cageRing.renderOrder = HELMET_LAMP_RENDER_ORDER + 1;
      cageRing.position.z = lampRimZ + lampBodyLength * .06 - lampCageDepth * Math.sin(phi);
      cageRing.castShadow = true;
      helmetLampRoot.add(cageRing);
    }
    const lampHub = lampMesh(new THREE.SphereGeometry(.024, 7, 4), helmetLampSteel);
    lampHub.renderOrder = HELMET_LAMP_RENDER_ORDER + 1;
    lampHub.position.z = lampHubZ;
    helmetLampRoot.add(lampHub);

    for (let bolt = 0; bolt < 5; bolt++) {
      const angle = (bolt / 5) * Math.PI * 2;
      const boltHead = lampMesh(new THREE.CylinderGeometry(.011, .011, .014, 6), helmetLampRubber);
      boltHead.rotation.x = Math.PI / 2;
      boltHead.position.set(
        Math.cos(angle) * lampRimRadius * .79,
        Math.sin(angle) * lampRimRadius * .79,
        -lampBodyLength - .03,
      );
      helmetLampRoot.add(boltHead);
    }

    const lampMountArm = lampMesh(new THREE.CylinderGeometry(.025, .031, .34, 7), helmetLampSteel);
    lampMountArm.rotation.z = Math.PI / 2;
    lampMountArm.position.set(.17, .012, -.035);
    helmetLampRoot.add(lampMountArm);
    const lampBackplate = lampMesh(new THREE.BoxGeometry(.12, .16, .045), helmetLampBrass);
    lampBackplate.position.set(.36, .012, -.035);
    lampBackplate.rotation.z = -.09;
    helmetLampRoot.add(lampBackplate);
    const helmetLampPoint = new THREE.PointLight(0xffcf75, 0, 3.2, 1.5);
    helmetLampPoint.position.set(0, 0, -lampBodyLength - .068 - lampGlassDepth * .45);
    helmetLampPoint.castShadow = true;
    helmetLampPoint.shadow.mapSize.set(256, 256);
    helmetLampPoint.shadow.bias = -.002;
    helmetLampRoot.add(helmetLampPoint);
    const floodRig = new THREE.Group();
    const floodBodyMaterial = new THREE.MeshStandardMaterial({ color: 0xb79a20, roughness: .78, metalness: .12, flatShading: false });
    const floodRubberMaterial = new THREE.MeshStandardMaterial({ color: 0x171b18, roughness: .88, metalness: .08, flatShading: false });
    const floodMetalMaterial = new THREE.MeshStandardMaterial({ color: 0x74796f, roughness: .38, metalness: .74, flatShading: false });
    const floodLensMaterial = new THREE.MeshBasicMaterial({ color: 0xffd58b, transparent: true, opacity: .74 });
    const floodBody = new THREE.Mesh(new THREE.BoxGeometry(.55, .39, .48, 2, 2, 2), floodBodyMaterial);
    floodBody.position.z = -.03;
    const floodRearCap = new THREE.Mesh(new THREE.BoxGeometry(.48, .32, .09), floodRubberMaterial);
    floodRearCap.position.z = .255;
    const floodBezel = new THREE.Mesh(new THREE.CylinderGeometry(.34, .27, .24, 16), floodRubberMaterial);
    floodBezel.rotation.x = Math.PI / 2;
    floodBezel.position.z = -.35;
    const floodReflector = new THREE.Mesh(new THREE.CylinderGeometry(.27, .16, .075, 16), floodMetalMaterial);
    floodReflector.rotation.x = Math.PI / 2;
    floodReflector.position.z = -.49;
    const floodLens = new THREE.Mesh(new THREE.CircleGeometry(.255, 18), floodLensMaterial);
    floodLens.position.z = -.535;
    const floodGrip = new THREE.Mesh(new THREE.BoxGeometry(.2, .48, .2, 2, 3, 2), floodBodyMaterial);
    floodGrip.position.set(.04, -.39, .04);
    floodGrip.rotation.z = -.08;
    for (let band = 0; band < 4; band++) {
      const gripBand = new THREE.Mesh(new THREE.BoxGeometry(.225, .035, .225), floodRubberMaterial);
      gripBand.position.set(.04, -.25 - band * .1, .04);
      gripBand.rotation.z = -.08;
      floodRig.add(gripBand);
    }
    const floodTrigger = new THREE.Mesh(new THREE.BoxGeometry(.08, .12, .08), floodRubberMaterial);
    floodTrigger.position.set(-.08, -.18, -.12);
    const floodTopSwitch = new THREE.Mesh(new THREE.BoxGeometry(.2, .07, .18), floodRubberMaterial);
    floodTopSwitch.position.set(.08, .24, -.02);
    const floodChargeCanvas = document.createElement("canvas");
    floodChargeCanvas.width = 256;
    floodChargeCanvas.height = 112;
    const floodChargeContext = floodChargeCanvas.getContext("2d");
    const floodChargeTexture = new THREE.CanvasTexture(floodChargeCanvas);
    floodChargeTexture.colorSpace = THREE.SRGBColorSpace;
    floodChargeTexture.minFilter = THREE.LinearFilter;
    floodChargeTexture.magFilter = THREE.NearestFilter;
    const floodChargeFrame = new THREE.Mesh(new THREE.BoxGeometry(.43, .23, .025), floodMetalMaterial);
    floodChargeFrame.position.set(0, .015, .307);
    const floodChargeScreenMaterial = new THREE.MeshBasicMaterial({ map: floodChargeTexture, toneMapped: false });
    const floodChargeScreen = new THREE.Mesh(new THREE.PlaneGeometry(.38, .17), floodChargeScreenMaterial);
    floodChargeScreen.position.set(0, .015, .321);
    let lastFloodChargeSignature = "";
    function updateFloodlightChargeDisplay(charge: number, overheated: boolean) {
      const percentage = Math.round(THREE.MathUtils.clamp(charge, 0, 1) * 100);
      const signature = `${percentage}:${overheated ? 1 : 0}`;
      if (!floodChargeContext || signature === lastFloodChargeSignature) return;
      lastFloodChargeSignature = signature;
      floodChargeContext.fillStyle = "#07110d";
      floodChargeContext.fillRect(0, 0, floodChargeCanvas.width, floodChargeCanvas.height);
      floodChargeContext.strokeStyle = overheated ? "#c65d39" : "#6f9b72";
      floodChargeContext.lineWidth = 6;
      floodChargeContext.strokeRect(5, 5, 246, 102);
      floodChargeContext.fillStyle = overheated ? "#ff9b65" : "#bde6a5";
      floodChargeContext.font = "700 24px monospace";
      floodChargeContext.textAlign = "center";
      floodChargeContext.fillText(overheated ? "COOLING" : "CHARGE", 128, 33);
      floodChargeContext.font = "700 35px monospace";
      floodChargeContext.fillText(`${percentage}%`, 128, 70);
      floodChargeContext.fillStyle = "#17261d";
      floodChargeContext.fillRect(25, 82, 206, 13);
      floodChargeContext.fillStyle = overheated ? "#d8633e" : "#9fcb86";
      floodChargeContext.fillRect(25, 82, 206 * percentage / 100, 13);
      floodChargeTexture.needsUpdate = true;
    }
    updateFloodlightChargeDisplay(1, false);
    floodRig.add(
      floodBody,
      floodRearCap,
      floodBezel,
      floodReflector,
      floodLens,
      floodGrip,
      floodTrigger,
      floodTopSwitch,
      floodChargeFrame,
      floodChargeScreen,
    );
    floodRig.position.set(.50, -.30, -.96);
    floodRig.rotation.set(-.12, -.12, -.05);
    floodRig.scale.setScalar(.86);
    floodRig.visible = false;
    camera.add(floodRig);

    const cameraRig = new THREE.Group();
    const cameraBodyMaterial = new THREE.MeshStandardMaterial({ color: 0x242923, roughness: .68, metalness: .46, flatShading: true });
    const cameraTrimMaterial = new THREE.MeshStandardMaterial({ color: 0x777b6d, roughness: .42, metalness: .62, flatShading: true });
    const cameraBody = new THREE.Mesh(new THREE.BoxGeometry(.72, .48, .34), cameraBodyMaterial);
    const cameraLens = new THREE.Mesh(new THREE.CylinderGeometry(.19, .24, .2, 10), cameraTrimMaterial);
    cameraLens.rotation.x = Math.PI / 2;
    cameraLens.position.z = -.25;
    const cameraFinder = new THREE.Mesh(new THREE.BoxGeometry(.24, .16, .12), cameraTrimMaterial);
    cameraFinder.position.set(.16, .3, -.02);
    cameraRig.add(cameraBody, cameraLens, cameraFinder);
    cameraRig.position.set(.48, -.5, -.86);
    cameraRig.rotation.set(-.12, -.2, -.06);
    cameraRig.visible = false;
    camera.add(cameraRig);

    const floorGeo = new THREE.PlaneGeometry(280, 280, 128, 128);
    floorGeo.rotateX(-Math.PI / 2);
    const floorPositions = floorGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < floorPositions.count; i++) {
      const x = floorPositions.getX(i);
      const z = floorPositions.getZ(i);
      floorPositions.setY(i, terrainHeight(x, z));
    }
    floorGeo.computeVertexNormals();
    const lakebedCanvas = document.createElement("canvas");
    lakebedCanvas.width = 256;
    lakebedCanvas.height = 256;
    const lakebedContext = lakebedCanvas.getContext("2d");
    const lakebedRand = mulberry32(0x5eabed);
    if (lakebedContext) {
      lakebedContext.fillStyle = "#4d573f";
      lakebedContext.fillRect(0, 0, 256, 256);
      for (let index = 0; index < 720; index++) {
        const size = 1 + Math.floor(lakebedRand() * 5);
        const shade = 58 + Math.floor(lakebedRand() * 52);
        lakebedContext.fillStyle = `rgba(${shade + 12},${shade + 15},${shade - 4},${.24 + lakebedRand() * .42})`;
        lakebedContext.fillRect(lakebedRand() * 256, lakebedRand() * 256, size * 1.8, size);
      }
      lakebedContext.lineWidth = 1;
      for (let line = 0; line < 16; line++) {
        const baseY = line * 17 + lakebedRand() * 9;
        lakebedContext.beginPath();
        for (let x = -12; x <= 268; x += 8) {
          const y = baseY + Math.sin(x * .07 + line * 1.9) * (2 + lakebedRand() * 2.5);
          if (x < 0) lakebedContext.moveTo(x, y);
          else lakebedContext.lineTo(x, y);
        }
        lakebedContext.strokeStyle = "rgba(135,142,101,.34)";
        lakebedContext.stroke();
      }
    }
    const lakebedTexture = new THREE.CanvasTexture(lakebedCanvas);
    lakebedTexture.wrapS = lakebedTexture.wrapT = THREE.RepeatWrapping;
    lakebedTexture.repeat.set(16, 16);
    lakebedTexture.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({
      color: 0x727861,
      map: lakebedTexture,
      emissive: 0x030503,
      emissiveIntensity: .08,
      roughness: 1,
      metalness: 0,
    }));
    scene.add(floor);

    const rand = mulberry32((Date.now() ^ 0x6ce01742) >>> 0);
    const coverMeshes: THREE.Mesh[] = [];
    interface CreatureObstacle {
      x: number;
      z: number;
      radius: number;
      minY: number;
      maxY: number;
    }
    interface PlayerObstacle extends CreatureObstacle {
      id: string;
    }
    interface DynamicPlayerCapsule {
      id: string;
      object: THREE.Object3D;
      halfLength: number;
      radius: number;
    }
    const creatureObstacles: CreatureObstacle[] = [];
    const playerObstacles: PlayerObstacle[] = [];
    const dynamicPlayerCapsules: DynamicPlayerCapsule[] = [];
    const playerSolidBoxes: WorldSolidBox[] = [];
    const floraExclusions: Array<{ x: number; z: number; radius: number }> = [];
    const addFloraExclusion = (x: number, z: number, radius: number) => {
      floraExclusions.push({ x, z, radius });
    };
    const addCreatureObstacle = (x: number, z: number, radius: number, minY: number, maxY: number) => {
      creatureObstacles.push({ x, z, radius, minY, maxY });
      addFloraExclusion(x, z, radius);
    };
    const addPlayerObstacle = (id: string, x: number, z: number, radius: number, minY: number, maxY: number) => {
      playerObstacles.push({ id, x, z, radius, minY, maxY });
    };
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x20271b, roughness: 1, flatShading: true });
    for (let i = 0; i < 96; i++) {
      const x = (rand() - .5) * 252;
      const z = (rand() - .5) * 252;
      const scale = .35 + rand() * 1.7;
      const rockFloor = terrainHeight(x, z);
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(scale, 0), rockMat);
      const rockScaleX = 1.2 + rand();
      const rockScaleY = .45 + rand() * .45;
      const rockScaleZ = .7 + rand() * .8;
      rock.scale.set(rockScaleX, rockScaleY, rockScaleZ);
      // Icosahedra are rotated after scaling. Resting them from scaleY alone
      // can lift a rotated narrow axis clear of the terrain; key the center to
      // the smallest scaled radius so every orientation embeds into the bed.
      const embeddedRockRadius = scale * Math.min(rockScaleX, rockScaleY, rockScaleZ) * .48;
      rock.position.set(x, rockFloor + embeddedRockRadius, z);
      rock.rotation.set(rand() * 2, rand() * 4, rand() * 2);
      scene.add(rock);
      addFloraExclusion(x, z, Math.max(.65, scale * 1.65));
      if (scale > .9) {
        coverMeshes.push(rock);
        addCreatureObstacle(x, z, scale * 1.9, rockFloor, rockFloor + scale * 2.2);
      }
    }
    const witnessRock = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1, 0), rockMat);
    witnessRock.position.set(-2.4, terrainHeight(-2.4, 9.5) + .55, 9.5);
    witnessRock.scale.set(1.8, .65, 1.05);
    witnessRock.rotation.set(.4, .7, -.2);
    scene.add(witnessRock);
    coverMeshes.push(witnessRock);
    addCreatureObstacle(-2.4, 9.5, 3.1, terrainHeight(-2.4, 9.5), terrainHeight(-2.4, 9.5) + 2.2);

    const caveX = -78;
    const caveZ = -67;
    const caveFloor = terrainHeight(caveX, caveZ);
    const creatureCavePosition = new THREE.Vector3(caveX - 2.8, caveFloor + 3.8, caveZ);
    const cave = new THREE.Group();
    cave.position.set(caveX, caveFloor, caveZ);
    const caveRockMaterial = new THREE.MeshStandardMaterial({ color: 0x171d16, roughness: 1, flatShading: true });
    const caveRocks = [
      [-1.4, 1.5, -4.8, 3.2, 2.7, 3.4], [-1.8, 1.6, 4.7, 3.5, 2.9, 3.2],
      [-3.2, 4.2, -3.7, 3.8, 2.5, 3.0], [-3.5, 4.4, 3.5, 4.1, 2.8, 3.1],
      [-4.4, 7.1, -1.9, 4.2, 2.4, 3.1], [-4.5, 7.4, 1.7, 4.1, 2.3, 3.0],
      [-5.2, 8.2, 0, 4.6, 2.1, 3.6], [-6.6, 3.2, 0, 3.8, 2.8, 5.5],
    ] as const;
    caveRocks.forEach(([x, y, z, sx, sy, sz], index) => {
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), caveRockMaterial);
      rock.position.set(x, y, z);
      rock.scale.set(sx, sy, sz);
      rock.rotation.set(index * .31, index * .57, index * -.18);
      cave.add(rock);
      coverMeshes.push(rock);
    });
    const caveMouth = new THREE.Mesh(
      new THREE.CircleGeometry(4.05, 18),
      new THREE.MeshBasicMaterial({ color: 0x010302, side: THREE.DoubleSide }),
    );
    caveMouth.position.set(-6.82, 3.65, 0);
    caveMouth.rotation.y = Math.PI / 2;
    cave.add(caveMouth);
    scene.add(cave);
    addCreatureObstacle(caveX - 4.8, caveZ - 6, 4.8, caveFloor, caveFloor + 11);
    addCreatureObstacle(caveX - 4.8, caveZ + 6, 4.8, caveFloor, caveFloor + 11);

    const pebbleGeometry = new THREE.IcosahedronGeometry(.15, 0);
    const pebbleMaterial = new THREE.MeshStandardMaterial({ color: 0x4a4d37, roughness: 1, flatShading: true });
    const pebbleCount = 2200;
    const pebbles = new THREE.InstancedMesh(pebbleGeometry, pebbleMaterial, pebbleCount);
    const pebbleMatrix = new THREE.Matrix4();
    const pebbleQuaternion = new THREE.Quaternion();
    const pebbleScale = new THREE.Vector3();
    for (let index = 0; index < pebbleCount; index++) {
      const x = (rand() - .5) * 258;
      const z = (rand() - .5) * 258;
      const scale = .55 + rand() * 2.1;
      pebbleQuaternion.setFromEuler(new THREE.Euler(rand() * 2, rand() * 4, rand() * 2));
      pebbleScale.set(scale * (1 + rand()), scale * (.28 + rand() * .32), scale * (.65 + rand() * .7));
      const pebbleHalfHeight = .15 * pebbleScale.y;
      pebbleMatrix.compose(
        new THREE.Vector3(x, terrainHeight(x, z) + Math.max(.018, pebbleHalfHeight * .7), z),
        pebbleQuaternion,
        pebbleScale,
      );
      pebbles.setMatrixAt(index, pebbleMatrix);
    }
    pebbles.instanceMatrix.needsUpdate = true;
    scene.add(pebbles);

    const shellGeometry = new THREE.TorusGeometry(.16, .035, 4, 7, Math.PI * 1.55);
    const shellMaterial = new THREE.MeshStandardMaterial({ color: 0x6d6a51, roughness: .92, flatShading: true });
    const shellCount = 260;
    const shells = new THREE.InstancedMesh(shellGeometry, shellMaterial, shellCount);
    for (let index = 0; index < shellCount; index++) {
      const x = (rand() - .5) * 220;
      const z = (rand() - .5) * 220;
      const scale = .65 + rand() * .85;
      pebbleQuaternion.setFromEuler(new THREE.Euler(Math.PI / 2 + (rand() - .5) * .28, rand() * Math.PI * 2, 0));
      pebbleScale.setScalar(scale);
      pebbleMatrix.compose(new THREE.Vector3(x, terrainHeight(x, z) + .1, z), pebbleQuaternion, pebbleScale);
      shells.setMatrixAt(index, pebbleMatrix);
    }
    shells.instanceMatrix.needsUpdate = true;
    scene.add(shells);

    const pillarMaterial = new THREE.MeshStandardMaterial({ color: 0x252c21, roughness: 1, flatShading: true });
    const pillarSites = [
      [-96, -58, -6], [-72, 36, -7], [-45, -72, -4.5], [-18, 42, -6],
      [14, -78, -5], [39, 18, -8], [63, -58, -4], [82, 42, -6],
      [104, -8, -5], [-112, 5, -7], [24, 70, -8], [-52, 78, -6],
    ] as const;
    for (const [x, z, topY] of pillarSites) {
      const pillar = new THREE.Group();
      const baseY = terrainHeight(x, z);
      const height = Math.max(12, topY - baseY);
      const sections = Math.max(3, Math.round(height / 4));
      for (let section = 0; section < sections; section++) {
        const t = section / sections;
        const radius = THREE.MathUtils.lerp(3.8, 1.35, t) * (.86 + rand() * .3);
        const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), pillarMaterial);
        rock.scale.set(radius, 2.3 + rand() * 1.2, radius * (.72 + rand() * .3));
        rock.position.set((rand() - .5) * .8, section * 3.65 + 1.6, (rand() - .5) * .8);
        rock.rotation.set(rand(), rand() * Math.PI, rand() * .35);
        pillar.add(rock);
        coverMeshes.push(rock);
      }
      pillar.position.set(x, baseY, z);
      scene.add(pillar);
      addCreatureObstacle(x, z, 5.2, baseY - .5, baseY + height + 4);
      addPlayerObstacle(`pillar-${x}-${z}`, x, z, 4.65, baseY - .5, baseY + height + 4);
    }
    mount.dataset.playerPillarColliders = String(playerObstacles.length);

    const surfaceGeometry = new THREE.PlaneGeometry(286, 286, 96, 96);
    const surfaceMaterial = new THREE.MeshStandardMaterial({
      color: 0x397b5d,
      emissive: 0x09130f,
      roughness: .34,
      metalness: .08,
      transparent: true,
      opacity: .96,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    const surface = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = 0;
    scene.add(surface);
    const surfacePositions = surfaceGeometry.attributes.position as THREE.BufferAttribute;
    const surfaceBase = new Float32Array(surfacePositions.array as ArrayLike<number>);

    const waterTextureCanvas = document.createElement("canvas");
    waterTextureCanvas.width = 256;
    waterTextureCanvas.height = 256;
    const waterTextureContext = waterTextureCanvas.getContext("2d");
    const waterTextureRand = mulberry32(0x7a7e12);
    if (waterTextureContext) {
      const waterBaseGradient = waterTextureContext.createLinearGradient(0, 0, 256, 256);
      waterBaseGradient.addColorStop(0, "#17352f");
      waterBaseGradient.addColorStop(.46, "#29483d");
      waterBaseGradient.addColorStop(1, "#102822");
      waterTextureContext.fillStyle = waterBaseGradient;
      waterTextureContext.fillRect(0, 0, 256, 256);
      waterTextureContext.lineCap = "round";
      for (let line = 0; line < 42; line++) {
        const baseY = line * 6.3 + waterTextureRand() * 7 - 6;
        const waveScale = 2.2 + waterTextureRand() * 4.4;
        waterTextureContext.beginPath();
        for (let x = -18; x <= 274; x += 5) {
          const y = baseY
            + Math.sin(x * (.048 + (line % 5) * .004) + line * 1.17) * waveScale
            + Math.sin(x * .16 - line * .73) * 1.1;
          if (x < 0) waterTextureContext.moveTo(x, y);
          else waterTextureContext.lineTo(x, y);
        }
        waterTextureContext.strokeStyle = `rgba(6,20,17,${.24 + waterTextureRand() * .2})`;
        waterTextureContext.lineWidth = 4 + waterTextureRand() * 5;
        waterTextureContext.stroke();
        waterTextureContext.strokeStyle = `rgba(156,188,174,${.12 + waterTextureRand() * .18})`;
        waterTextureContext.lineWidth = .75 + waterTextureRand() * 1.7;
        waterTextureContext.stroke();
      }
      for (let index = 0; index < 96; index++) {
        const x = waterTextureRand() * 256;
        const y = waterTextureRand() * 256;
        const radius = 3 + waterTextureRand() * 13;
        waterTextureContext.beginPath();
        waterTextureContext.ellipse(x, y, radius, radius * (.16 + waterTextureRand() * .18), waterTextureRand() * .35, 0, Math.PI * 2);
        waterTextureContext.strokeStyle = `rgba(186,210,199,${.07 + waterTextureRand() * .16})`;
        waterTextureContext.lineWidth = .7 + waterTextureRand() * 1.2;
        waterTextureContext.stroke();
      }
    }
    const waterTexture = new THREE.CanvasTexture(waterTextureCanvas);
    waterTexture.wrapS = waterTexture.wrapT = THREE.RepeatWrapping;
    waterTexture.repeat.set(7, 9);
    waterTexture.colorSpace = THREE.SRGBColorSpace;
    waterTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    surfaceMaterial.map = waterTexture;
    surfaceMaterial.color.setHex(0x3f9666);
    surfaceMaterial.roughness = .46;
    surfaceMaterial.needsUpdate = true;
    const waterHighlightTexture = waterTexture.clone();
    waterHighlightTexture.repeat.set(9, 12);
    const waterDetailMaterial = new THREE.MeshBasicMaterial({
      color: 0xb1d0bf,
      map: waterHighlightTexture,
      transparent: true,
      opacity: .12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const waterDetail = new THREE.Mesh(surfaceGeometry, waterDetailMaterial);
    waterDetail.rotation.x = -Math.PI / 2;
    waterDetail.position.y = .025;
    scene.add(waterDetail);

    // Keep the camera-centred sky shell behind every reachable point on the
    // 280 m terrain. The former 205 m shell could sit in front of the far
    // shore when viewed diagonally from the north-side workboat, covering
    // mountain sections even though the camera far plane was large enough.
    const skyGeometry = new THREE.SphereGeometry(390, 48, 24);
    const skyMaterial = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, visibility: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float time;
        uniform float visibility;
        varying vec3 vDirection;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float value = 0.0;
          float weight = 0.54;
          for (int i = 0; i < 4; i++) {
            value += noise(p) * weight;
            p = p * 2.03 + vec2(17.7, 9.2);
            weight *= 0.5;
          }
          return value;
        }
        void main() {
          vec3 direction = normalize(vDirection);
          float height = smoothstep(-0.12, 0.72, direction.y);
          float horizonMist = 1.0 - smoothstep(0.0, 0.34, abs(direction.y));
          vec2 cloudUv = direction.xz * (3.2 + max(0.0, direction.y) * 2.2);
          cloudUv += vec2(time * 0.0022, -time * 0.0013);
          float broadCloud = fbm(cloudUv);
          float fineCloud = fbm(cloudUv * 2.7 + 8.4);
          float cloud = smoothstep(0.38, 0.83, broadCloud * 0.72 + fineCloud * 0.34);
          vec3 horizon = vec3(0.39, 0.50, 0.45);
          vec3 zenith = vec3(0.68, 0.76, 0.72);
          vec3 color = mix(horizon, zenith, height);
          color = mix(color, vec3(0.30, 0.39, 0.35), cloud * (0.38 + height * 0.20));
          color += vec3(0.035, 0.052, 0.043) * horizonMist;
          gl_FragColor = vec4(color, visibility);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      transparent: true,
    });
    const skyDome = new THREE.Mesh(skyGeometry, skyMaterial);
    skyDome.renderOrder = -10;
    skyDome.frustumCulled = false;
    scene.add(skyDome);

    const boat = new THREE.Group();
    const WORKBOAT = {
      length: 8.6, beam: 3.9, depth: 1.35, deadrise: .21, sheer: .54,
      bowRake: 0, rocker: .18, stations: 14, gunwale: .46, cabinSize: 1,
      cabinPosition: .32, platform: 1.05,
    } as const;
    const hullMaterial = new THREE.MeshStandardMaterial({ color: 0x3d4438, roughness: .93, metalness: .02, flatShading: true, side: THREE.DoubleSide });
    const deckMaterial = new THREE.MeshStandardMaterial({ color: 0x6b6a55, roughness: .96, flatShading: true, side: THREE.DoubleSide });
    const cabinWallMaterial = new THREE.MeshStandardMaterial({ color: 0x8e8b70, roughness: .9, flatShading: true });
    const hullTrimMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2f26, roughness: .8, metalness: .22, flatShading: true });
    const cabinGlassMaterial = new THREE.MeshBasicMaterial({ color: 0x121a18 });
    const rustMaterial = new THREE.MeshStandardMaterial({ color: 0x5d4a30, roughness: .83, metalness: .36, flatShading: true });

    const halfBeamAt = (t: number) => {
      if (t < .3) return .86 + (t / .3) * .14;
      if (t < .58) return 1;
      const u = (t - .58) / .42;
      return 1 - Math.pow(u, 1.5) * .96;
    };
    const stationData = Array.from({ length: WORKBOAT.stations }, (_, index) => {
      const t = index / (WORKBOAT.stations - 1);
      const z = WORKBOAT.length * (.5 - t);
      const beamFactor = halfBeamAt(t);
      const halfWidth = beamFactor * WORKBOAT.beam * .5;
      const keelY = -WORKBOAT.depth * .55 + WORKBOAT.rocker * Math.pow(Math.max(0, (t - .42) / .58), 2);
      const chineY = keelY + WORKBOAT.deadrise * beamFactor;
      const sheerY = WORKBOAT.depth * .45 + WORKBOAT.sheer * Math.pow(t, 1.8);
      return { t, z, halfWidth, keelY, chineY, sheerY, deckY: sheerY - WORKBOAT.gunwale };
    });
    const hullPositions: number[] = [];
    const hullIndices: number[] = [];
    stationData.forEach((station) => {
      hullPositions.push(
        -station.halfWidth, station.sheerY, station.z,
        -station.halfWidth * .82, station.chineY, station.z,
        0, station.keelY, station.z,
        station.halfWidth * .82, station.chineY, station.z,
        station.halfWidth, station.sheerY, station.z,
      );
    });
    for (let station = 0; station < WORKBOAT.stations - 1; station++) {
      const a = station * 5;
      const b = (station + 1) * 5;
      for (let panel = 0; panel < 4; panel++) {
        hullIndices.push(a + panel, b + panel, a + panel + 1, b + panel, b + panel + 1, a + panel + 1);
      }
    }
    const indexedHullGeometry = new THREE.BufferGeometry();
    indexedHullGeometry.setAttribute("position", new THREE.Float32BufferAttribute(hullPositions, 3));
    indexedHullGeometry.setIndex(hullIndices);
    const hullGeometry = indexedHullGeometry.toNonIndexed();
    indexedHullGeometry.dispose();
    hullGeometry.computeVertexNormals();
    boat.add(new THREE.Mesh(hullGeometry, hullMaterial));

    // Close the final loft station instead of leaving the two hull skins as
    // visibly separate wedges. The small vertical stem is deliberately dark
    // so the first view of the workboat reads as one complete hard-chine bow.
    const bowStation = stationData[stationData.length - 1];
    const bowTipHalfWidth = Math.max(.1, bowStation.halfWidth);
    const bowCenterY = (bowStation.sheerY + bowStation.keelY) * .5;
    const bowCapGeometry = new THREE.BufferGeometry();
    bowCapGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
      0, bowCenterY, bowStation.z - .012,
      -bowTipHalfWidth, bowStation.sheerY, bowStation.z,
      -bowTipHalfWidth * .82, bowStation.chineY, bowStation.z,
      0, bowStation.keelY, bowStation.z,
      bowTipHalfWidth * .82, bowStation.chineY, bowStation.z,
      bowTipHalfWidth, bowStation.sheerY, bowStation.z,
    ], 3));
    bowCapGeometry.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 1]);
    bowCapGeometry.computeVertexNormals();
    const bowCap = new THREE.Mesh(bowCapGeometry, hullMaterial);
    bowCap.name = "sealed-workboat-bow";
    boat.add(bowCap);
    // The longitudinal rails already taper to within centimetres of one
    // another. Join only those tips; the previous shoulder-width crosspiece
    // squared the prow back off after the hull had formed a proper point.
    const bowBridge = new THREE.Mesh(
      new THREE.BoxGeometry(.28, .12, .28),
      hullTrimMaterial,
    );
    bowBridge.name = "workboat-bow-rail-join";
    bowBridge.position.set(0, bowStation.sheerY + .025, bowStation.z + .025);
    bowBridge.castShadow = true;
    boat.add(bowBridge);
    const bowStemClosure = new THREE.Mesh(
      new THREE.BoxGeometry(.16, bowStation.sheerY - bowStation.keelY + .02, .18),
      hullTrimMaterial,
    );
    bowStemClosure.name = "workboat-bow-stem-closure";
    bowStemClosure.position.set(0, bowCenterY, bowStation.z - .035);
    bowStemClosure.castShadow = true;
    boat.add(bowStemClosure);

    const deckPositions: number[] = [];
    const deckIndices: number[] = [];
    stationData.forEach((station) => {
      const deckHalfWidth = Math.max(.08, station.halfWidth - .16);
      deckPositions.push(-deckHalfWidth, station.deckY, station.z, deckHalfWidth, station.deckY, station.z);
    });
    for (let station = 0; station < WORKBOAT.stations - 1; station++) {
      const a = station * 2;
      deckIndices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    const deckGeometry = new THREE.BufferGeometry();
    deckGeometry.setAttribute("position", new THREE.Float32BufferAttribute(deckPositions, 3));
    deckGeometry.setIndex(deckIndices);
    deckGeometry.computeVertexNormals();
    boat.add(new THREE.Mesh(deckGeometry, deckMaterial));

    for (const side of [-1, 1]) {
      for (let index = 0; index < stationData.length - 1; index++) {
        const a = stationData[index];
        const b = stationData[index + 1];
        const xA = side * a.halfWidth;
        const xB = side * b.halfWidth;
        const length = Math.hypot(xB - xA, b.z - a.z);
        const cap = new THREE.Mesh(new THREE.BoxGeometry(.09, .075, length), hullTrimMaterial);
        cap.position.set((xA + xB) * .5, (a.sheerY + b.sheerY) * .5 + .025, (a.z + b.z) * .5);
        cap.rotation.y = Math.atan2(xB - xA, b.z - a.z);
        boat.add(cap);
        const innerFace = new THREE.Mesh(new THREE.BoxGeometry(.055, WORKBOAT.gunwale, length), hullMaterial);
        innerFace.position.set((xA + xB) * .5 - side * .08, (a.sheerY + b.sheerY + a.deckY + b.deckY) * .25, (a.z + b.z) * .5);
        innerFace.rotation.y = cap.rotation.y;
        boat.add(innerFace);
      }
    }

    const stern = stationData[0];
    for (const side of [-1, 1]) {
      const transomCorner = new THREE.Mesh(new THREE.BoxGeometry(.68, 1.32, .11), hullMaterial);
      transomCorner.position.set(side * (stern.halfWidth - .35), .02, stern.z + .01);
      boat.add(transomCorner);
    }
    const transomNotch = new THREE.Mesh(new THREE.BoxGeometry((stern.halfWidth * 2) / 3, .58, .11), hullMaterial);
    transomNotch.position.set(0, -.34, stern.z + .01);
    boat.add(transomNotch);

    const cabinZ = WORKBOAT.cabinPosition * WORKBOAT.length * .5;
    const cabin = new THREE.Group();
    // Keep the deck floor fixed while lifting the cabin roof by roughly one
    // foot, so the 2.18 m player camera no longer intersects the roofline.
    const cabinShell = new THREE.Mesh(new THREE.BoxGeometry(2.45, 2.03, 2.05), cabinWallMaterial);
    cabinShell.position.y = 1.275;
    cabin.add(cabinShell);
    const cabinRoof = new THREE.Mesh(new THREE.BoxGeometry(2.78, .16, 2.36), hullTrimMaterial);
    cabinRoof.position.y = 2.35;
    cabin.add(cabinRoof);
    const cabinWindowJambWidth = .085;
    const frontWindowWidth = 1.55;
    const frontWindowHeight = .62;
    const frontWindowFrame = new THREE.Mesh(new THREE.BoxGeometry(
      frontWindowWidth + cabinWindowJambWidth * 2,
      frontWindowHeight + cabinWindowJambWidth * 2,
      .035,
    ), hullTrimMaterial);
    frontWindowFrame.name = "workboat-front-window-jamb";
    frontWindowFrame.position.set(0, 1.47, -1.038);
    cabin.add(frontWindowFrame);
    const frontWindow = new THREE.Mesh(new THREE.PlaneGeometry(frontWindowWidth, frontWindowHeight), cabinGlassMaterial);
    frontWindow.position.set(0, 1.47, -1.058);
    // PlaneGeometry faces +Z by default. The workboat's bow is -Z, so turn
    // this pane outward to keep it visible from the exterior foredeck.
    frontWindow.rotation.y = Math.PI;
    cabin.add(frontWindow);
    const portWindowWidth = 1.02;
    const portWindowHeight = .58;
    const portWindowFrame = new THREE.Mesh(new THREE.BoxGeometry(
      .035,
      portWindowHeight + cabinWindowJambWidth * 2,
      portWindowWidth + cabinWindowJambWidth * 2,
    ), hullTrimMaterial);
    portWindowFrame.name = "workboat-port-window-jamb";
    portWindowFrame.position.set(-1.231, 1.48, -.12);
    cabin.add(portWindowFrame);
    const portWindow = new THREE.Mesh(new THREE.PlaneGeometry(portWindowWidth, portWindowHeight), cabinGlassMaterial);
    portWindow.position.set(-1.251, 1.48, -.12);
    portWindow.rotation.y = -Math.PI / 2;
    cabin.add(portWindow);
    const starboardDoor = new THREE.Mesh(new THREE.PlaneGeometry(.88, 1.83), hullTrimMaterial);
    starboardDoor.position.set(1.236, 1.185, .24);
    starboardDoor.rotation.y = Math.PI / 2;
    cabin.add(starboardDoor);
    const doorPanel = new THREE.Mesh(new THREE.PlaneGeometry(.7, 1.62), cabinWallMaterial);
    doorPanel.position.set(1.242, 1.145, .24);
    doorPanel.rotation.y = Math.PI / 2;
    cabin.add(doorPanel);
    const doorWindow = new THREE.Mesh(new THREE.PlaneGeometry(.5, .4), cabinGlassMaterial);
    doorWindow.position.set(1.248, 1.65, .24);
    doorWindow.rotation.y = Math.PI / 2;
    cabin.add(doorWindow);
    const doorHandle = new THREE.Mesh(new THREE.BoxGeometry(.045, .045, .22), rustMaterial);
    doorHandle.position.set(1.27, 1.1, -.03);
    cabin.add(doorHandle);
    const roofMast = new THREE.Mesh(new THREE.CylinderGeometry(.045, .065, 1.15, 6), hullTrimMaterial);
    roofMast.position.set(.78, 2.94, .08);
    cabin.add(roofMast);
    const mastLampHousing = new THREE.Mesh(new THREE.CylinderGeometry(.16, .2, .22, 8), rustMaterial);
    mastLampHousing.position.set(.78, 3.46, .08);
    cabin.add(mastLampHousing);
    cabin.position.set(0, .24, cabinZ);
    boat.add(cabin);

    const locker = new THREE.Mesh(new THREE.BoxGeometry(2.15, .48, .72), cabinWallMaterial);
    locker.position.set(0, .51, cabinZ + 1.42);
    boat.add(locker);
    const lockerLid = new THREE.Mesh(new THREE.BoxGeometry(2.25, .09, .78), hullTrimMaterial);
    lockerLid.position.set(0, .795, cabinZ + 1.42);
    boat.add(lockerLid);
    for (const side of [-1, 1]) {
      const hookPlate = new THREE.Mesh(new THREE.BoxGeometry(.38, .5, .06), hullTrimMaterial);
      hookPlate.position.set(side * .48, 1.42, cabinZ + 1.075);
      boat.add(hookPlate);
      const hookPeg = new THREE.Mesh(new THREE.CylinderGeometry(.035, .035, .28, 6), rustMaterial);
      hookPeg.rotation.x = Math.PI / 2;
      hookPeg.position.set(side * .48, 1.42, cabinZ + 1.24);
      boat.add(hookPeg);
      const hookTip = new THREE.Mesh(new THREE.BoxGeometry(.07, .22, .07), rustMaterial);
      hookTip.position.set(side * .48, 1.52, cabinZ + 1.36);
      boat.add(hookTip);
    }

    const divePlatform = new THREE.Mesh(new THREE.BoxGeometry(2.25, .14, WORKBOAT.platform), deckMaterial);
    // Begin the platform just aft of the transom instead of overlapping the
    // deck cap; the old overlap produced a flickering back-deck seam.
    divePlatform.position.set(0, .39, WORKBOAT.length * .5 + WORKBOAT.platform * .55);
    boat.add(divePlatform);
    for (const side of [-1, 1]) {
      const platformLeg = new THREE.Mesh(new THREE.BoxGeometry(.09, .72, .09), hullTrimMaterial);
      platformLeg.position.set(side * .82, .02, WORKBOAT.length * .5 + .48);
      boat.add(platformLeg);
      const ladderRail = new THREE.Mesh(new THREE.CylinderGeometry(.035, .035, 1.9, 6), rustMaterial);
      ladderRail.position.set(side * .43, -.42, WORKBOAT.length * .5 + WORKBOAT.platform);
      boat.add(ladderRail);
    }
    for (let rung = 0; rung < 4; rung++) {
      const ladderRung = new THREE.Mesh(new THREE.CylinderGeometry(.028, .028, .86, 6), rustMaterial);
      ladderRung.rotation.z = Math.PI / 2;
      ladderRung.position.set(0, .18 - rung * .42, WORKBOAT.length * .5 + WORKBOAT.platform);
      boat.add(ladderRung);
    }
    // Separate rail brackets replace the old metre-wide board that occupied
    // the same plane as the stern platform and visibly z-fought through it.
    for (const x of [-.43, .43]) {
      const ladderBracket = new THREE.Mesh(new THREE.BoxGeometry(.11, .12, .48), rustMaterial);
      ladderBracket.position.set(x, .5, WORKBOAT.length * .5 + .83);
      boat.add(ladderBracket);
    }

    const outboard = new THREE.Group();
    const outboardCowling = new THREE.Mesh(new THREE.BoxGeometry(.62, .72, .5), hullTrimMaterial);
    outboardCowling.position.y = .24;
    outboard.add(outboardCowling);
    const outboardShaft = new THREE.Mesh(new THREE.BoxGeometry(.16, 1.35, .18), rustMaterial);
    outboardShaft.position.set(0, -.72, .05);
    outboard.add(outboardShaft);
    const outboardSkeg = new THREE.Mesh(new THREE.BoxGeometry(.44, .12, .38), rustMaterial);
    outboardSkeg.position.set(0, -1.37, -.08);
    outboard.add(outboardSkeg);
    outboard.position.set(1.12, .18, WORKBOAT.length * .5 + .12);
    boat.add(outboard);

    boat.position.set(BOAT_X, 0, BOAT_Z);
    scene.add(boat);
    addCreatureObstacle(BOAT_X, BOAT_Z, 6.2, -8, 5.2);

    const chainMaterial = new THREE.MeshBasicMaterial({ color: 0x4a5047 });
    const chainLinkGeometry = new THREE.TorusGeometry(.087, .024, 4, 8);
    const chainLinkCount = 108;
    const anchorChain = new THREE.InstancedMesh(chainLinkGeometry, chainMaterial, chainLinkCount);
    const chainMatrix = new THREE.Matrix4();
    const chainQuaternion = new THREE.Quaternion();
    const chainScale = new THREE.Vector3(1, 1, 1);
    const chainEuler = new THREE.Euler();
    for (let linkIndex = 0; linkIndex < chainLinkCount; linkIndex++) {
      const chainY = -.23 - linkIndex * .218;
      const chainX = BOAT_X + Math.sin(linkIndex * .43) * .035;
      const chainZ = BOAT_Z - 3.72 + Math.sin(linkIndex * .31) * .025;
      chainEuler.set(0, linkIndex % 2 === 0 ? 0 : Math.PI / 2, 0);
      chainQuaternion.setFromEuler(chainEuler);
      chainMatrix.compose(new THREE.Vector3(chainX, chainY, chainZ), chainQuaternion, chainScale);
      anchorChain.setMatrixAt(linkIndex, chainMatrix);
    }
    anchorChain.instanceMatrix.needsUpdate = true;
    scene.add(anchorChain);

    const timberMaterial = new THREE.MeshStandardMaterial({ color: 0x404638, roughness: 1, flatShading: true });
    const roadTextureCanvas = document.createElement("canvas");
    roadTextureCanvas.width = 128;
    roadTextureCanvas.height = 128;
    const roadTextureContext = roadTextureCanvas.getContext("2d");
    const roadTextureRand = mulberry32(0x70ad51);
    if (roadTextureContext) {
      roadTextureContext.fillStyle = "#252b24";
      roadTextureContext.fillRect(0, 0, 128, 128);
      for (let mark = 0; mark < 260; mark++) {
        const shade = 34 + Math.floor(roadTextureRand() * 34);
        roadTextureContext.fillStyle = `rgba(${shade},${shade + 7},${shade - 2},${.18 + roadTextureRand() * .34})`;
        const size = .6 + roadTextureRand() * 2.4;
        roadTextureContext.fillRect(roadTextureRand() * 128, roadTextureRand() * 128, size * 1.8, size);
      }
      roadTextureContext.strokeStyle = "rgba(87,91,70,.28)";
      roadTextureContext.lineWidth = 2.2;
      for (const rutX of [40, 88]) {
        roadTextureContext.beginPath();
        for (let y = -8; y <= 136; y += 8) {
          const x = rutX + Math.sin(y * .09 + rutX) * 3.4;
          if (y < 0) roadTextureContext.moveTo(x, y);
          else roadTextureContext.lineTo(x, y);
        }
        roadTextureContext.stroke();
      }
    }
    const roadTexture = new THREE.CanvasTexture(roadTextureCanvas);
    roadTexture.wrapS = roadTexture.wrapT = THREE.RepeatWrapping;
    roadTexture.colorSpace = THREE.SRGBColorSpace;
    const roadMaterial = new THREE.MeshStandardMaterial({
      color: 0x657060,
      map: roadTexture,
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      side: THREE.DoubleSide,
    });
    const driftingDeadheads: THREE.Group[] = [];

    const drownedVillage = createDrownedVillage(terrainHeight);
    scene.add(drownedVillage.group);
    coverMeshes.push(...drownedVillage.occluderMeshes);
    creatureObstacles.push(...drownedVillage.creatureObstacles);
    playerSolidBoxes.push(...drownedVillage.playerSolids);
    drownedVillage.floraExclusions.forEach((exclusion) => addFloraExclusion(exclusion.x, exclusion.z, exclusion.radius));
    mount.dataset.ruinedVillageBuildings = String(drownedVillage.buildingCount);
    mount.dataset.ruinedVillageSystem = "six-presets-solid-thick-walls-road-oriented";

    const cargoFreighter = createCargoFreighter(terrainHeight);
    scene.add(cargoFreighter.group);
    coverMeshes.push(...cargoFreighter.occluderMeshes);
    creatureObstacles.push(cargoFreighter.creatureObstacle);
    playerSolidBoxes.push(...cargoFreighter.playerSolids);
    cargoFreighter.floraExclusions.forEach((exclusion) => addFloraExclusion(exclusion.x, exclusion.z, exclusion.radius));
    mount.dataset.freighterLocation = `${FREIGHTER_X},${FREIGHTER_Z}`;
    mount.dataset.freighterEnterable = String(cargoFreighter.group.userData.enterable);
    mount.dataset.freighterContainers = String(cargoFreighter.stats.containers);

    const roadStrips: THREE.Mesh[] = [];
    const addRoad = (startX: number, startZ: number, endX: number, endZ: number, segmentCount: number) => {
      const deltaX = endX - startX;
      const deltaZ = endZ - startZ;
      const length = Math.hypot(deltaX, deltaZ);
      const sideX = -deltaZ / length;
      const sideZ = deltaX / length;
      const samples = segmentCount * 5;
      const positions: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];
      for (let index = 0; index <= samples; index++) {
        const progress = index / samples;
        const x = THREE.MathUtils.lerp(startX, endX, progress);
        const z = THREE.MathUtils.lerp(startZ, endZ, progress);
        const halfWidth = 2.55 + Math.sin(index * 1.73) * .18;
        const leftX = x + sideX * halfWidth;
        const leftZ = z + sideZ * halfWidth;
        const rightX = x - sideX * halfWidth;
        const rightZ = z - sideZ * halfWidth;
        positions.push(leftX, terrainHeight(leftX, leftZ) + .045, leftZ);
        positions.push(rightX, terrainHeight(rightX, rightZ) + .045, rightZ);
        uvs.push(0, progress * length / 7, 1, progress * length / 7);
        if (index < samples) {
          const vertex = index * 2;
          indices.push(vertex, vertex + 2, vertex + 1, vertex + 2, vertex + 3, vertex + 1);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const road = new THREE.Mesh(geometry, roadMaterial);
      scene.add(road);
      roadStrips.push(road);
      const exclusionSteps = Math.max(2, Math.ceil(length / 4));
      for (let step = 0; step <= exclusionSteps; step++) {
        const progress = step / exclusionSteps;
        addFloraExclusion(
          THREE.MathUtils.lerp(startX, endX, progress),
          THREE.MathUtils.lerp(startZ, endZ, progress),
          3.05,
        );
      }
    };
    addRoad(12, 78, 12, -60, 19);
    addRoad(-58, -20, 12, -20, 11);
    addRoad(12, -34, 61, -56, 9);

    for (let i = 0; i < 11; i++) {
      const x = 14 + Math.sin(i * .92) * 1.85;
      const z = 13 - i * 5.9;
      const y = terrainHeight(x, z);
      const poleHeight = 5.35 + (i % 3) * .32;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(.12, .18, poleHeight, 6), timberMaterial);
      pole.position.set(x, y + poleHeight / 2, z);
      pole.rotation.z = (i % 2 ? -1 : 1) * .035;
      scene.add(pole);
      const crossbar = new THREE.Mesh(new THREE.BoxGeometry(4.1, .25, .24), timberMaterial);
      crossbar.position.set(x, y + poleHeight - .42, z);
      crossbar.rotation.z = pole.rotation.z;
      scene.add(crossbar);
      addCreatureObstacle(x, z, 1.15, y, y + poleHeight + .5);
    }

    const deadheadMaterial = new THREE.MeshStandardMaterial({ color: 0x121711, roughness: 1, flatShading: true });
    for (let i = 0; i < 6; i++) {
      const deadhead = new THREE.Group();
      const length = 3.4 + rand() * 3.8;
      const logTopRadius = .24 + rand() * .13;
      const logBottomRadius = .32 + rand() * .16;
      const log = new THREE.Mesh(new THREE.CylinderGeometry(logTopRadius, logBottomRadius, length, 6), deadheadMaterial);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = (rand() - .5) * .45;
      deadhead.add(log);
      const snag = new THREE.Mesh(new THREE.CylinderGeometry(.04, .09, 1.55, 4), deadheadMaterial);
      snag.position.set(length * .18, .45, 0);
      snag.rotation.z = -.78;
      deadhead.add(snag);
      dynamicPlayerCapsules.push({
        id: `deadhead-${i}-trunk`,
        object: log,
        halfLength: length * .48,
        radius: Math.max(logTopRadius, logBottomRadius),
      }, {
        id: `deadhead-${i}-snag`,
        object: snag,
        halfLength: 1.55 * .46,
        radius: .09,
      });
      if (i === 0) {
        deadhead.position.set(-14, -12.4, 36);
      } else {
        let deadheadX = -20 + rand() * 54;
        let deadheadZ = -47 + rand() * 83;
        if (Math.hypot(deadheadX, deadheadZ - 20) < 16) {
          deadheadX += deadheadX >= 0 ? 16 : -16;
          deadheadZ -= 10;
        }
        deadhead.position.set(deadheadX, -8 - rand() * 9, deadheadZ);
      }
      deadhead.userData.baseX = deadhead.position.x;
      deadhead.userData.baseZ = deadhead.position.z;
      deadhead.userData.phase = rand() * Math.PI * 2;
      deadhead.userData.drift = .11 + rand() * .12;
      scene.add(deadhead);
      driftingDeadheads.push(deadhead);
      addFloraExclusion(deadhead.position.x, deadhead.position.z, length * .62);
    }
    mount.dataset.deadheadColliderCount = String(dynamicPlayerCapsules.length);
    if (lakeAudit === "logs" && driftingDeadheads[0]) {
      camera.position.copy(driftingDeadheads[0].position).add(new THREE.Vector3(0, 0, 4.8));
    }
    if (lakeAudit) {
      mount.dataset.lakeFeature = lakeAudit;
      mount.dataset.movingContactCount = String(driftingDeadheads.length);
    }

    for (let i = 0; i < 18; i++) {
      const z = -69 + i * 8.1;
      const x = 28.2 + rand() * 5.5;
      const ledgeRadius = .65 + rand() * .8;
      const ledgeScaleY = 1.05 + rand() * .8;
      const ledgeScaleZ = .75 + rand() * .75;
      const ledge = new THREE.Mesh(new THREE.IcosahedronGeometry(ledgeRadius, 0), rockMat);
      ledge.scale.set(1.05, ledgeScaleY, ledgeScaleZ);
      const embeddedLedgeRadius = ledgeRadius * Math.min(1.05, ledgeScaleY, ledgeScaleZ) * .48;
      ledge.position.set(x, terrainHeight(x, z) + embeddedLedgeRadius, z);
      ledge.rotation.set(rand(), rand() * 3, rand());
      scene.add(ledge);
      coverMeshes.push(ledge);
      addFloraExclusion(x, z, ledgeRadius * 1.45);
    }

    type EvidenceRecord = {
      id: string;
      label: string;
      value: number;
      nearNest: boolean;
      collectible: boolean;
      group: THREE.Group;
      taken: boolean;
    };
    const evidenceRecords: EvidenceRecord[] = [];
    const physicalEvidenceGroups: THREE.Group[] = [];
    for (const site of PHYSICAL_EVIDENCE_SITES) {
      const group = createPhysicalEvidence(site.id);
      group.position.set(site.x, terrainHeight(site.x, site.z) + .025, site.z);
      group.rotation.y = site.rotation;
      scene.add(group);
      physicalEvidenceGroups.push(group);
      addFloraExclusion(site.x, site.z, 1.1);
      evidenceRecords.push({
        id: site.id,
        label: site.label,
        value: site.value,
        nearNest: site.nearNest,
        collectible: true,
        group,
        taken: false,
      });
    }
    if (evidenceModelAudit) {
      const auditedEvidence = evidenceRecords.find((evidence) => evidence.id === evidenceModelAudit);
      evidenceRecords.forEach((evidence) => {
        evidence.group.visible = evidence === auditedEvidence;
      });
      if (auditedEvidence) {
        camera.position.copy(auditedEvidence.group.position).add(new THREE.Vector3(0, 1.72, 3.3));
        mount.dataset.evidenceModelAudit = auditedEvidence.id;
        mount.dataset.evidenceModelLabel = auditedEvidence.label;
        mount.dataset.evidenceModelTexture = "authored-procedural-materials-v2";
      }
    }

    const creatureNest = createCreatureNest(terrainHeight);
    scene.add(creatureNest.group);
    addFloraExclusion(NEST_X, NEST_Z, 2.3);
    evidenceRecords.push({
      id: "creature-clutch",
      label: "LIVING CLUTCH",
      value: NEST_PHOTO_EVIDENCE_VALUE,
      nearNest: true,
      collectible: false,
      group: creatureNest.group,
      taken: false,
    });
    mount.dataset.nestEggCount = String(creatureNest.stats.eggCount);
    mount.dataset.nestMovingEggs = String(creatureNest.stats.movingCount);
    mount.dataset.nestBones = String(creatureNest.stats.boneCount);

    const drownedFlora = createDrownedFlora(terrainHeight, floraExclusions);
    scene.add(drownedFlora.group);
    mount.dataset.floraSystem = "5-tree-presets-4-weed-presets-dense-grass-fields";
    mount.dataset.curtainCoverBeds = String(drownedFlora.curtainBeds.length);
    mount.dataset.grassFieldCount = String(drownedFlora.group.userData.grassFieldCount);
    mount.dataset.grassPatchCount = String(drownedFlora.group.userData.grassPatchCount);
    mount.dataset.floraExclusionCount = String(drownedFlora.group.userData.placementExclusionCount);
    drownedFlora.treeMeshes.forEach((tree) => coverMeshes.push(tree));
    drownedFlora.obstacles.forEach((obstacle) => {
      addCreatureObstacle(obstacle.x, obstacle.z, obstacle.radius, obstacle.minY, obstacle.maxY);
    });

    const creatureRig = createCreature();
    const creature = creatureRig.group;
    const head = creatureRig.head;
    const creatureMaterial = creatureRig.material;
    const creatureStartPosition = creatureAttackAudit
      ? new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z - 4.35)
      : monsterModelAudit
        ? new THREE.Vector3(
            camera.position.x + (monsterModelAudit === "head" ? 8 : 0),
            camera.position.y,
            camera.position.z - (monsterModelAudit === "head" ? 7 : 15),
          )
      : creatureVocalAudit
        ? new THREE.Vector3(camera.position.x, camera.position.y - .5, camera.position.z - 15)
        : lakeAudit === "creaturecave"
        ? new THREE.Vector3(caveX + 15, caveFloor + 5.1, caveZ + .7)
      : searchParams.get("creature") === "1" && directAudit
        ? new THREE.Vector3(camera.position.x, camera.position.y + 6.9, camera.position.z - 13.2)
      : new THREE.Vector3(
        CREATURE_START_POSITION.x,
        CREATURE_START_POSITION.y,
        CREATURE_START_POSITION.z,
      );
    creature.position.copy(creatureStartPosition);
    if (creatureVocalAudit || monsterModelAudit === "front") creature.rotation.y = Math.PI;
    if (monsterModelAudit === "side" || monsterModelAudit === "head") creature.rotation.y = Math.PI / 2;
    scene.add(creature);

    const fishSystem = createFishSystem({ terrainHeight, obstacles: creatureObstacles, seed: 0x20f15a });
    scene.add(fishSystem.group);
    mount.dataset.fishMinnowSchools = String(fishSystem.stats.minnowSchools);
    mount.dataset.fishMinnowCount = String(fishSystem.stats.minnowCount);
    mount.dataset.fishBreamCount = String(fishSystem.stats.breamCount);
    mount.dataset.fishPikeCount = String(fishSystem.stats.pikeCount);
    mount.dataset.fishCoelacanthCount = String(fishSystem.stats.coelacanthCount);
    const shafts = new THREE.Group();
    const shaftMaterials: THREE.MeshBasicMaterial[] = [];
    const shaftBaseOpacities: number[] = [];
    const shaftFadeCanvas = document.createElement("canvas");
    shaftFadeCanvas.width = 4;
    shaftFadeCanvas.height = 128;
    const shaftFadeContext = shaftFadeCanvas.getContext("2d");
    if (shaftFadeContext) {
      const fade = shaftFadeContext.createLinearGradient(0, 0, 0, shaftFadeCanvas.height);
      fade.addColorStop(0, "rgba(255,255,255,0)");
      fade.addColorStop(.12, "rgba(255,255,255,.9)");
      fade.addColorStop(.5, "rgba(255,255,255,.58)");
      fade.addColorStop(.78, "rgba(255,255,255,.16)");
      fade.addColorStop(1, "rgba(255,255,255,0)");
      shaftFadeContext.fillStyle = fade;
      shaftFadeContext.fillRect(0, 0, shaftFadeCanvas.width, shaftFadeCanvas.height);
    }
    const shaftFadeTexture = new THREE.CanvasTexture(shaftFadeCanvas);
    shaftFadeTexture.minFilter = THREE.LinearFilter;
    shaftFadeTexture.magFilter = THREE.LinearFilter;

    const shaftSpots: Array<[number, number, number, number, number]> = [];
    // Stratified angular/radial slots cover the entire basin rather than only
    // the half between the workboat and the lake center. A depth-derived
    // height keeps every shaft's soft lower edge suspended above the floor.
    const shaftSlotCount = 24;
    for (let slot = 0; slot < shaftSlotCount; slot++) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const angle = (slot / shaftSlotCount) * Math.PI * 2 + (rand() - .5) * .24;
        const radius = 38 + (slot % 3) * 23 + rand() * 15;
        const x = Math.cos(angle) * radius * 1.04;
        const z = Math.sin(angle) * radius;
        const floorY = terrainHeight(x, z);
        if (floorY > -13 || Math.hypot(x / 1.04, z) > 106) continue;
        const height = THREE.MathUtils.clamp(-floorY - 4.5, 7.5, 13.5);
        shaftSpots.push([x, z, .72 + rand() * 1.55, .02 + rand() * .032, height]);
        break;
      }
    }
    mount.dataset.lightShaftCount = String(shaftSpots.length);
    mount.dataset.lightShaftCoverage = "full-lake-angular-radial";
    for (const [x, z, radius, opacity, height] of shaftSpots) {
      const geometry = new THREE.CylinderGeometry(radius * .16, radius, height, 8, 1, true);
      const material = new THREE.MeshBasicMaterial({
        color: 0xc9c58a,
        map: shaftFadeTexture,
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const shaft = new THREE.Mesh(geometry, material);
      shaft.position.set(x, .15 - height / 2, z);
      shaft.rotation.z = (x as number) * .005;
      shafts.add(shaft);
      shaftMaterials.push(material);
      shaftBaseOpacities.push(opacity);
    }
    scene.add(shafts);

    const scatterCount = 520;
    const scatterPositions = new Float32Array(scatterCount * 3);
    for (let i = 0; i < scatterCount; i++) {
      scatterPositions[i * 3] = (rand() - .5) * 18;
      scatterPositions[i * 3 + 1] = (rand() - .5) * 14;
      scatterPositions[i * 3 + 2] = -rand() * 13;
    }
    const moteCanvas = document.createElement("canvas");
    moteCanvas.width = 32;
    moteCanvas.height = 32;
    const moteContext = moteCanvas.getContext("2d");
    if (moteContext) {
      const gradient = moteContext.createRadialGradient(16, 16, 1, 16, 16, 15);
      gradient.addColorStop(0, "rgba(255,244,200,.95)");
      gradient.addColorStop(.25, "rgba(255,238,184,.62)");
      gradient.addColorStop(1, "rgba(255,238,184,0)");
      moteContext.fillStyle = gradient;
      moteContext.fillRect(0, 0, 32, 32);
    }
    const moteTexture = new THREE.CanvasTexture(moteCanvas);
    const scatterGeo = new THREE.BufferGeometry();
    scatterGeo.setAttribute("position", new THREE.BufferAttribute(scatterPositions, 3));
    const scatter = new THREE.Points(scatterGeo, new THREE.PointsMaterial({
      color: 0xf4edc5,
      size: .078,
      transparent: true,
      opacity: .72,
      map: moteTexture,
      alphaTest: .008,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    scatter.visible = directAudit;
    camera.add(scatter);

    const bubbleCount = 34;
    const bubblePositions = new Float32Array(bubbleCount * 3);
    for (let i = 0; i < bubbleCount; i++) {
      bubblePositions[i * 3] = (rand() - .5) * 1.6;
      bubblePositions[i * 3 + 1] = -1.8 + rand() * 4.6;
      bubblePositions[i * 3 + 2] = -1.2 - rand() * 2.8;
    }
    const bubbleGeo = new THREE.BufferGeometry();
    bubbleGeo.setAttribute("position", new THREE.BufferAttribute(bubblePositions, 3));
    const bubbles = new THREE.Points(bubbleGeo, new THREE.PointsMaterial({
      color: 0xd9e0bb,
      size: .085,
      transparent: true,
      opacity: .42,
      map: moteTexture,
      alphaTest: .02,
      depthWrite: false,
    }));
    bubbles.visible = directAudit;
    camera.add(bubbles);

    const sedimentCount = 90;
    const sedimentPositions = new Float32Array(sedimentCount * 3);
    for (let i = 0; i < sedimentCount; i++) {
      sedimentPositions[i * 3] = (rand() - .5) * 4.5;
      sedimentPositions[i * 3 + 1] = -1.7 + rand() * 1.2;
      sedimentPositions[i * 3 + 2] = -1.5 - rand() * 5;
    }
    const sedimentGeo = new THREE.BufferGeometry();
    sedimentGeo.setAttribute("position", new THREE.BufferAttribute(sedimentPositions, 3));
    const sedimentMaterial = new THREE.PointsMaterial({
      color: 0x9b8756,
      size: .12,
      transparent: true,
      opacity: 0,
      map: moteTexture,
      alphaTest: .015,
      depthWrite: false,
    });
    const sediment = new THREE.Points(sedimentGeo, sedimentMaterial);
    camera.add(sediment);
    scene.add(camera);

    const markerBodyGeometry = new THREE.CylinderGeometry(.14, .18, .72, 7);
    const markerBodyMaterial = new THREE.MeshStandardMaterial({ color: 0x37392f, roughness: .86, metalness: .34, flatShading: true });
    const markerGlowGeometry = new THREE.SphereGeometry(.18, 7, 4);
    const markerGlowMaterial = new THREE.MeshBasicMaterial({ color: 0xffc66d });
    const markerHaloGeometry = new THREE.SphereGeometry(1.5, 10, 6);
    const markerHaloMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb95e,
      transparent: true,
      opacity: .11,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    });
    type DroppedMarker = { group: THREE.Group; light: THREE.PointLight; position: THREE.Vector3 };
    // Keep both decoy lights in the scene from the first frame. Adding a new
    // PointLight during play changes Three's light-count shader define and can
    // force a visible compile hitch at the exact moment the player presses R.
    const markerPool: DroppedMarker[] = Array.from({ length: 2 }, () => {
      const group = new THREE.Group();
      const body = new THREE.Mesh(markerBodyGeometry, markerBodyMaterial);
      body.rotation.z = Math.PI / 2;
      const glow = new THREE.Mesh(markerGlowGeometry, markerGlowMaterial);
      glow.position.x = .45;
      const halo = new THREE.Mesh(markerHaloGeometry, markerHaloMaterial);
      halo.position.x = .45;
      group.add(body, glow, halo);
      const light = new THREE.PointLight(0xffbd68, 0, 15, 1.42);
      light.position.x = .45;
      group.add(light);
      // Leave the group renderable so the fixed light count is compiled up
      // front, but park inactive decoys well outside the playable scene.
      group.position.set(0, -1000, 0);
      scene.add(group);
      return { group, light, position: group.position };
    });
    const droppedMarkers: DroppedMarker[] = [];

    const keys = new Set<string>();
    let yaw = lakeAudit === "village" ? Math.PI / 2 : lakeAudit === "dropoff" ? -Math.PI / 2 : lakeAudit === "lines" ? -.16 : 0;
    let pitch = lakeAudit === "village" || lakeAudit === "villagefloor" || lakeAudit === "villagehouses" ? .05 : lakeAudit === "lines" ? .18 : lakeAudit === "forest" ? .08 : lakeAudit === "logs" ? 0 : lakeAudit === "dropoff" ? .06 : auditBand === "shallow" ? .16 : directAudit ? -.48 : -.2;
    if (lakeAudit === "boat") { yaw = 2.67; pitch = -.1; }
    if (lakeAudit === "grass") { yaw = .2; pitch = -.24; }
    if (lakeAudit === "pillars") { yaw = -Math.PI / 2; pitch = 0; }
    if (lakeAudit === "rays") { yaw = 1.23; pitch = .14; }
    if (lakeAudit === "creatureskin") { yaw = 0; pitch = .44; }
    if (monsterModelAudit) { yaw = 0; pitch = 0; }
    if (lakeAudit === "creaturecave") { yaw = .93; pitch = .12; }
    if (lakeAudit === "fish") { yaw = -.54; pitch = -.02; }
    if (lakeAudit === "freighter") { yaw = -Math.PI / 2; pitch = -.02; }
    if (lakeAudit === "nest" || nestAudit) { yaw = -Math.PI / 2; pitch = -.22; }
    if (creatureVocalAudit) { yaw = 0; pitch = 0; }
    if (silhouetteAudit) { yaw = 0; pitch = 0; }
    if (evidenceModelAudit) { yaw = 0; pitch = -.42; }
    let running = false;
    let sessionStarted = false;
    let paused = false;
    let onBoat = !directAudit;
    let lastCanDive = false;
    let last = performance.now();
    let frame = 0;
    let nextHudUpdate = 0;
    let nextHeartbeat = 0;
    let airValue = Number(searchParams.get("air")) || 100;
    let breathDebtValue = Number(searchParams.get("debt")) || 0;
    let forcedBreathUntil = 0;
    let mainLampOn = true;
    let floodlightOn = false;
    let floodlightCharge = 1;
    let floodlightOverheated = false;
    let mapIsHeld = false;
    let cameraIsHeld = false;
    let cameraHintTimeout: number | null = null;
    let airGasped = false;
    let wasBreathingAtSurface = false;
    let surfaceGaspCooldownUntil = 0;
    let gaspMessageUntil = 0;
    let lastBreathEvent = "";
    let audioContext: AudioContext | null = null;
    let masterBus: GainNode | null = null;
    let suitBus: GainNode | null = null;
    let waterBus: GainNode | null = null;
    let eventBus: GainNode | null = null;
    let introBus: GainNode | null = null;
    let introMusicSource: AudioBufferSourceNode | null = null;
    let introMusicGain: GainNode | null = null;
    let waterFilter: BiquadFilterNode | null = null;
    let waterNoise: AudioBufferSourceNode | null = null;
    let waterNoiseB: AudioBufferSourceNode | null = null;
    let waterSub: OscillatorNode | null = null;
    let floodlightActiveSource: AudioBufferSourceNode | null = null;
    let floodlightActiveGain: GainNode | null = null;
    let cameraShutterBuffer: AudioBuffer | null = null;
    const creatureAudio = new Map<string, AudioBuffer>();
    const creatureAudioUrls = {
      "aggro-engaged": "audio/creature/aggro-engaged.wav",
      attack: "audio/creature/attack.wav",
      "far-aggro-1": "audio/creature/far-aggro-1.wav",
      "far-aggro-2": "audio/creature/far-aggro-2.wav",
      "favorite-non-aggro": "audio/creature/favorite-non-aggro.wav",
      "mid-aggro": "audio/creature/mid-aggro.wav",
      "random-1": "audio/creature/random-1.wav",
      "random-2": "audio/creature/random-2.wav",
    } as const;
    const floodlightAudio = new Map<string, AudioBuffer>();
    const floodlightAudioUrls = {
      on: "audio/floodlight/floodlight-on.wav",
      off: "audio/floodlight/floodlight-off.wav",
      burnout: "audio/floodlight/floodlight-burnout.wav",
      active: "audio/floodlight/floodlight-active.wav",
    } as const;
    const introMusicUrl = "audio/music/creepy-music-1.wav";
    const cameraShutterUrl = "audio/camera/picture-taken.wav";
    let nextBreathAt = 0;
    let nextCreatureCallAt = 0;
    let nextPresentEventAt = 0;
    let lastPassiveNeutralCallAt = Number.NEGATIVE_INFINITY;
    let investigationMinimumUntil = Number.POSITIVE_INFINITY;
    let requiresConfirmedSightingForCommit = rand() < .75;
    let creatureSighted = false;
    let centralSightBeganAt = 0;
    let lastConfirmedVisibleAt = Number.NEGATIVE_INFINITY;
    let creatureWasConfirmedVisible = false;
    let heartSurgeUntil = 0;
    let diveStartedAt = Number.POSITIVE_INFINITY;
    let directAuditStartedAt = Number.POSITIVE_INFINITY;
    let sightingGraceUntil = 0;
    let silhouettePassScheduledAt = 0;
    let silhouettePassStartedAt = 0;
    let silhouettePassApproachStarted = false;
    let silhouettePassComplete = false;
    let silhouettePassObserved = false;
    let silhouettePassDurationMs = 7600;
    let silhouettePassAttempts = 0;
    let silhouetteDirectorResolved = false;
    let earlySightingOpportunityEnabled = false;
    let earlySightingOpportunityStartOffsetMs = 0;
    let earlySightingOpportunityEndOffsetMs = 0;
    let earlySightingTargetAssigned = false;
    let earlySightingExitTargetAssigned = false;
    let flashCuriosityUntil = 0;
    const passStart = new THREE.Vector3();
    const passEnd = new THREE.Vector3();
    let flashBlindValue = 0;
    let submersionShockValue = 0;
    let flashPeakUntil = 0;
    let exposuresLeft = 6;
    let markersLeft = 2;
    let descentActive = false;
    let enteredWater = false;
    let diveComplete = false;
    let fatalTriggered = false;
    let returnAvailable = false;
    let nextEvidenceUpdate = 0;
    let evidenceEventUntil = 0;
    let lastEvidenceEvent = "";
    let boostCooldownUntil = 0;
    let sonarCooldownUntil = 0;
    let sonarVisibleUntil = 0;
    let lastSonarBearingStep: number | null = null;
    let sonarCuriosityUntil = 0;
    let lastSonarReadinessStep = 100;
    let sonarReadyCuePending = false;
    const sonarInterestPoint = new THREE.Vector3();
    let landingSiltUntil = 0;
    let wasGrounded = false;
    const carriedEvidence: EvidenceRecord[] = [];
    const photographedEvidence = new Set<string>();
    let creaturePhotographed = false;
    let floodlightTotal = 0;
    let droppedLampTotal = 0;
    const soundAudit = searchParams.get("sound") === "1";
    const creatureAudit = searchParams.get("creature") === "1";
    const instrumentsAudit = searchParams.get("instruments") === "1";
    type CreatureState = "Present" | "Investigating" | "Committed";
    const aggroInputs = {
      mainLamp: 0,
      floodLight: 0,
      cameraFlash: 0,
      disturbingSediment: 0,
      nearNestTheft: 0,
      sonar: 0,
    };
    const aggroTotals = {
      mainLamp: 0,
      floodLight: 0,
      cameraFlash: 0,
      disturbingSediment: 0,
      nearNestTheft: 0,
      sonar: 0,
    };
    let aggro = creatureAudit ? .9 : 0;
    let creatureState: CreatureState = creatureAttackAudit ? "Committed" : "Present";
    let stateEnteredAt = performance.now();
    let pendingEscalationAt = 0;
    let commitBeganAt = creatureAttackAudit ? performance.now() - 42000 : 0;
    let nextRoamTargetAt = 0;
    let isHidden = false;
    let wasHidden = false;
    let concealmentFailure = "";
    let shyRetreatUntil = 0;
    let creatureRestUntil = 0;
    let nextCaveVisitAt = Number.POSITIVE_INFINITY;
    let headingToCave = false;
    let creatureCaveSettleStartedAt = 0;
    let creatureCaveDepartureStartedAt = 0;
    let lastShyRetreatAt = Number.NEGATIVE_INFINITY;
    let lastProximityRetreatAt = Number.NEGATIVE_INFINITY;
    let evasionVariant: CreatureEvasionVariant | null = null;
    let evasionStartedAt = 0;
    let evasionUntil = 0;
    let evasionHandedness: -1 | 1 = 1;
    let evasionVerticalDirection: -1 | 1 = -1;
    let lastEvasionAt = Number.NEGATIVE_INFINITY;
    let evasionSettleStartedAt = 0;
    let evasionSettleUntil = 0;
    let investigationOrbitPhase = 0;
    let committedOrbitPhase = 0;
    let creatureStuckSeconds = 0;
    let creatureRecoveryUntil = 0;
    let creatureAttackStartedAt = 0;
    let creatureAttackUntil = 0;
    let creatureAttackImpactPlayed = false;
    let creatureWakeAnimationStartedAt = 0;
    let creatureVocalizationStartedAt = 0;
    let creatureVocalizationUntil = 0;
    let creatureWasResting = false;
    let creatureWasLitVisible = false;
    const lastKnownPosition = camera.position.clone();
    const creatureTarget = creatureStartPosition.clone();
    const shyRetreatTarget = new THREE.Vector3();
    const evasionTarget = new THREE.Vector3();
    const evasionAway = new THREE.Vector3();
    const evasionLateral = new THREE.Vector3();
    const evasionCandidate = new THREE.Vector3();
    const evasionRawTarget = new THREE.Vector3();
    const evasionPathPoint = new THREE.Vector3();
    const evasionStartDirection = new THREE.Vector3();
    const evasionCurveControl = new THREE.Vector3();
    const evasionExitDirection = new THREE.Vector3();
    const evasionSteeringDirection = new THREE.Vector3();
    const evasionGuideTarget = new THREE.Vector3();
    const evasionSettleTarget = new THREE.Vector3();
    const creatureRecoveryTarget = new THREE.Vector3();
    const creatureFrameStart = new THREE.Vector3();
    const creatureCurrentForward = new THREE.Vector3();
    const creatureCaveSettleStart = new THREE.Vector3();
    const creatureCaveExitPosition = creatureCavePosition.clone().add(new THREE.Vector3(15, 1.15, 0));
    creatureCaveExitPosition.y = Math.max(
      creatureCaveExitPosition.y,
      terrainHeight(creatureCaveExitPosition.x, creatureCaveExitPosition.z) + 4.2,
    );
    const creatureCaveSettleStartQuaternion = new THREE.Quaternion();
    const creatureCaveRestQuaternion = new THREE.Quaternion();
    const creatureMotionPose: CreatureMotionPose = {
      speed: 0,
      turn: 0,
      vertical: 0,
      behavior: "present",
      focusYaw: 0,
      focusPitch: 0,
      caveApproach: 0,
      cavePose: 0,
      resting: false,
      wakeProgress: 1,
      departureProgress: undefined,
      vocalizationProgress: 0,
      recovering: false,
      evasionRecoveryProgress: 1,
      evasionRecoverySide: 1,
    };
    const evasionPose: CreatureEvasionPose = {
      variant: "c-turn",
      progress: 0,
      handedness: 1,
      verticalDirection: -1,
    };
    const coverDirection = new THREE.Vector3();
    const creatureTravel = new THREE.Vector3();
    const creatureForwardTarget = new THREE.Vector3();
    const cameraToCreature = new THREE.Vector3();
    const velocity = new THREE.Vector3();
    const move = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const beamDir = new THREE.Vector3();
    const fishFloodlightDirection = new THREE.Vector3();
    const scatterDrift = new THREE.Vector3();
    const inverseCameraQuaternion = new THREE.Quaternion();
    const contactDirection = new THREE.Vector3();
    const creatureHeadWorld = new THREE.Vector3();
    const projectedCreature = new THREE.Vector3();
    const creatureProbe = new THREE.Vector3();
    const creatureAvoidance = new THREE.Vector3();
    const creatureTangent = new THREE.Vector3();
    const creatureRetreatDirection = new THREE.Vector3();
    const creatureFacingPoint = new THREE.Vector3();
    const creatureAnimationFocus = new THREE.Vector3();
    const creatureAttackTarget = new THREE.Vector3();
    const creatureFocusLocal = new THREE.Vector3();
    const inverseCreatureQuaternion = new THREE.Quaternion();
    const creatureLookHelper = new THREE.Object3D();
    const silhouettePoint = new THREE.Vector3();
    const silhouetteCandidateStart = new THREE.Vector3();
    const silhouetteCandidateEnd = new THREE.Vector3();
    const silhouettePathSample = new THREE.Vector3();
    const silhouetteSightDirection = new THREE.Vector3();
    const earlySightingDirection = new THREE.Vector3();
    const sightRay = new THREE.Raycaster();
    const playerCollisionNormal = new THREE.Vector3();
    const dynamicCapsuleStart = new THREE.Vector3();
    const dynamicCapsuleEnd = new THREE.Vector3();
    const dynamicCapsuleAxis = new THREE.Vector3();
    const dynamicCapsuleClosest = new THREE.Vector3();
    const dynamicCapsuleOffset = new THREE.Vector3();

    function resolvePlayerObstacles(point: THREE.Vector3) {
      const playerRadius = .52;
      for (const obstacle of playerObstacles) {
        if (point.y < obstacle.minY || point.y > obstacle.maxY) continue;
        playerCollisionNormal.set(point.x - obstacle.x, 0, point.z - obstacle.z);
        const distance = playerCollisionNormal.length();
        const safeDistance = obstacle.radius + playerRadius;
        if (distance >= safeDistance) continue;
        if (distance < .001) playerCollisionNormal.set(1, 0, 0);
        else playerCollisionNormal.multiplyScalar(1 / distance);
        point.x = obstacle.x + playerCollisionNormal.x * safeDistance;
        point.z = obstacle.z + playerCollisionNormal.z * safeDistance;
        const inwardSpeed = velocity.x * playerCollisionNormal.x + velocity.z * playerCollisionNormal.z;
        if (inwardSpeed < 0) {
          velocity.x -= playerCollisionNormal.x * inwardSpeed;
          velocity.z -= playerCollisionNormal.z * inwardSpeed;
        }
        if (lakeAudit === "pillars") mount.dataset.lastPlayerCollision = obstacle.id;
      }
      for (const capsule of dynamicPlayerCapsules) {
        capsule.object.updateWorldMatrix(true, false);
        dynamicCapsuleStart.set(0, -capsule.halfLength, 0);
        dynamicCapsuleEnd.set(0, capsule.halfLength, 0);
        capsule.object.localToWorld(dynamicCapsuleStart);
        capsule.object.localToWorld(dynamicCapsuleEnd);
        dynamicCapsuleAxis.subVectors(dynamicCapsuleEnd, dynamicCapsuleStart);
        const axisLengthSquared = dynamicCapsuleAxis.lengthSq();
        const along = axisLengthSquared > .0001
          ? THREE.MathUtils.clamp(dynamicCapsuleOffset.subVectors(point, dynamicCapsuleStart).dot(dynamicCapsuleAxis) / axisLengthSquared, 0, 1)
          : 0;
        dynamicCapsuleClosest.copy(dynamicCapsuleStart).addScaledVector(dynamicCapsuleAxis, along);
        playerCollisionNormal.subVectors(point, dynamicCapsuleClosest);
        const distance = playerCollisionNormal.length();
        const safeDistance = capsule.radius + playerRadius;
        if (distance >= safeDistance) continue;
        if (distance < .001) playerCollisionNormal.set(0, 1, 0);
        else playerCollisionNormal.multiplyScalar(1 / distance);
        point.copy(dynamicCapsuleClosest).addScaledVector(playerCollisionNormal, safeDistance);
        const inwardSpeed = velocity.dot(playerCollisionNormal);
        if (inwardSpeed < 0) velocity.addScaledVector(playerCollisionNormal, -inwardSpeed);
        if (lakeAudit === "logs") mount.dataset.lastPlayerCollision = capsule.id;
      }
      for (let pass = 0; pass < 2; pass++) {
        for (const solid of playerSolidBoxes) {
          const minX = solid.x - solid.halfX - playerRadius;
          const maxX = solid.x + solid.halfX + playerRadius;
          const minY = solid.minY - playerRadius;
          const maxY = solid.maxY + playerRadius;
          const minZ = solid.z - solid.halfZ - playerRadius;
          const maxZ = solid.z + solid.halfZ + playerRadius;
          if (point.x <= minX || point.x >= maxX || point.y <= minY || point.y >= maxY || point.z <= minZ || point.z >= maxZ) continue;

          const candidates = [
            { depth: point.x - minX, nx: -1, ny: 0, nz: 0 },
            { depth: maxX - point.x, nx: 1, ny: 0, nz: 0 },
            { depth: point.y - minY, nx: 0, ny: -1, nz: 0 },
            { depth: maxY - point.y, nx: 0, ny: 1, nz: 0 },
            { depth: point.z - minZ, nx: 0, ny: 0, nz: -1 },
            { depth: maxZ - point.z, nx: 0, ny: 0, nz: 1 },
          ];
          const resolution = candidates.reduce((best, candidate) => candidate.depth < best.depth ? candidate : best);
          playerCollisionNormal.set(resolution.nx, resolution.ny, resolution.nz);
          point.addScaledVector(playerCollisionNormal, resolution.depth + .001);
          const inwardSpeed = velocity.dot(playerCollisionNormal);
          if (inwardSpeed < 0) velocity.addScaledVector(playerCollisionNormal, -inwardSpeed);
          if (lakeAudit === "villagehouses" || lakeAudit === "freighter") mount.dataset.lastPlayerCollision = solid.id;
        }
      }
    }

    function segmentIntersectsSolid(
      start: THREE.Vector3,
      end: THREE.Vector3,
      solid: WorldSolidBox,
      padding = .28,
    ) {
      let entry = 0;
      let exit = 1;
      const clipAxis = (origin: number, delta: number, minimum: number, maximum: number) => {
        if (Math.abs(delta) < 1e-6) return origin >= minimum && origin <= maximum;
        let near = (minimum - origin) / delta;
        let far = (maximum - origin) / delta;
        if (near > far) [near, far] = [far, near];
        entry = Math.max(entry, near);
        exit = Math.min(exit, far);
        return entry <= exit;
      };
      return clipAxis(start.x, end.x - start.x, solid.x - solid.halfX - padding, solid.x + solid.halfX + padding)
        && clipAxis(start.y, end.y - start.y, solid.minY - padding, solid.maxY + padding)
        && clipAxis(start.z, end.z - start.z, solid.z - solid.halfZ - padding, solid.z + solid.halfZ + padding)
        && exit >= 0
        && entry <= 1;
    }

    function creatureAttackPathIsClear() {
      // The monster is steered around authored structures, so a wall, roof,
      // hull plate, or other player-solid crossing the short strike segment
      // means its body cannot physically reach the diver.
      return !playerSolidBoxes.some((solid) => segmentIntersectsSolid(
        creature.position,
        camera.position,
        solid,
      ));
    }

    function keepCreaturePointClear(point: THREE.Vector3, clearance = 5.6) {
      for (let pass = 0; pass < 3; pass++) {
        for (const obstacle of creatureObstacles) {
          if (point.y < obstacle.minY - 4 || point.y > obstacle.maxY + 4) continue;
          creatureAvoidance.set(point.x - obstacle.x, 0, point.z - obstacle.z);
          const distance = creatureAvoidance.length();
          const safeDistance = obstacle.radius + clearance;
          if (distance >= safeDistance) continue;
          if (distance < .001) creatureAvoidance.set(1, 0, 0);
          else creatureAvoidance.multiplyScalar(1 / distance);
          point.x = obstacle.x + creatureAvoidance.x * safeDistance;
          point.z = obstacle.z + creatureAvoidance.z * safeDistance;
        }
      }
      keepInsideLake(point, 106);
      return point;
    }

    function silhouettePointIsClear(point: THREE.Vector3) {
      if (Math.hypot(point.x / 1.04, point.z) > 103) return false;
      if (point.y < terrainHeight(point.x, point.z) + 4.4 || point.y > -3.4) return false;
      return !creatureObstacles.some((obstacle) => {
        // Small rocks and drowned trunks remain ordinary steering concerns.
        // This director check rejects the authored landmarks that could make
        // a composed crossing emerge through a house, pillar, boat, or wreck.
        if (obstacle.radius < 3) return false;
        if (point.y < obstacle.minY - 4.5 || point.y > obstacle.maxY + 4.5) return false;
        return Math.hypot(point.x - obstacle.x, point.z - obstacle.z) < obstacle.radius + 4.4;
      });
    }

    function tryBuildSilhouettePass() {
      camera.getWorldDirection(creatureForwardTarget);
      creatureForwardTarget.y = 0;
      if (creatureForwardTarget.lengthSq() < .001) creatureForwardTarget.set(0, 0, -1);
      else creatureForwardTarget.normalize();
      right.crossVectors(creatureForwardTarget, WORLD_UP).normalize();

      let blockedPathCandidates = 0;
      let blockedViewCandidates = 0;
      let bestReadableSamples = 0;
      for (let candidateIndex = 0; candidateIndex < 8; candidateIndex++) {
        const direction = rand() < .5 ? -1 : 1;
        const forwardDistance = 22 + rand() * 10;
        const lateralSpan = 25 + rand() * 11;
        silhouetteCandidateStart.copy(camera.position)
          .addScaledVector(creatureForwardTarget, forwardDistance)
          .addScaledVector(right, lateralSpan * direction);
        silhouetteCandidateEnd.copy(camera.position)
          .addScaledVector(creatureForwardTarget, forwardDistance + (rand() - .5) * 4)
          .addScaledVector(right, -lateralSpan * direction);

        let pathFloor = Number.NEGATIVE_INFINITY;
        for (let sampleIndex = 0; sampleIndex <= 12; sampleIndex++) {
          silhouettePathSample.lerpVectors(silhouetteCandidateStart, silhouetteCandidateEnd, sampleIndex / 12);
          pathFloor = Math.max(pathFloor, terrainHeight(silhouettePathSample.x, silhouettePathSample.z));
        }
        const pathY = Math.max(
          THREE.MathUtils.clamp(camera.position.y + (rand() - .5) * 5.2, -23.5, -3.6),
          pathFloor + 4.8,
        );
        if (pathY > -3.4) continue;
        silhouetteCandidateStart.y = pathY;
        silhouetteCandidateEnd.y = pathY + (rand() - .5) * 2.8;

        let pathClear = true;
        let readableSamples = 0;
        for (let sampleIndex = 0; sampleIndex <= 12; sampleIndex++) {
          silhouettePathSample.lerpVectors(silhouetteCandidateStart, silhouetteCandidateEnd, sampleIndex / 12);
          if (!silhouettePointIsClear(silhouettePathSample)) {
            pathClear = false;
            break;
          }
          if (sampleIndex === 3 || sampleIndex === 6 || sampleIndex === 9) {
            silhouetteSightDirection.subVectors(silhouettePathSample, camera.position);
            const sightDistance = silhouetteSightDirection.length();
            silhouetteSightDirection.normalize();
            sightRay.set(camera.position, silhouetteSightDirection);
            sightRay.far = Math.max(.1, sightDistance - 2.4);
            if (sightRay.intersectObjects(coverMeshes, false).length === 0) readableSamples += 1;
          }
        }
        bestReadableSamples = Math.max(bestReadableSamples, readableSamples);
        if (!pathClear) {
          blockedPathCandidates += 1;
          continue;
        }
        if (readableSamples < 2) {
          blockedViewCandidates += 1;
          continue;
        }

        passStart.copy(silhouetteCandidateStart);
        passEnd.copy(silhouetteCandidateEnd);
        silhouettePassDurationMs = THREE.MathUtils.clamp(
          (passStart.distanceTo(passEnd) / CREATURE_CRUISE_SPEED) * 1000 * (.92 + rand() * .16),
          6200,
          9400,
        );
        silhouettePassObserved = false;
        silhouettePassAttempts += 1;
        if (creatureAudit || silhouetteAudit) {
          mount.dataset.silhouettePath = `${direction < 0 ? "right-left" : "left-right"}:${forwardDistance.toFixed(1)}m`;
          mount.dataset.silhouetteDuration = silhouettePassDurationMs.toFixed(0);
        }
        return true;
      }
      if (creatureAudit || silhouetteAudit) {
        mount.dataset.silhouetteValidation = `path-${blockedPathCandidates}:view-${blockedViewCandidates}:readable-${bestReadableSamples}`;
      }
      return false;
    }

    function resetEarlySightingOpportunity() {
      earlySightingOpportunityEnabled = earlySightingAudit || rand() < EARLY_SIGHTING_OPPORTUNITY_CHANCE;
      earlySightingOpportunityStartOffsetMs = EARLY_SIGHTING_START_MIN_MS
        + rand() * (EARLY_SIGHTING_START_MAX_MS - EARLY_SIGHTING_START_MIN_MS);
      earlySightingOpportunityEndOffsetMs = Math.min(
        110000,
        earlySightingOpportunityStartOffsetMs
          + EARLY_SIGHTING_DURATION_MIN_MS
          + rand() * (EARLY_SIGHTING_DURATION_MAX_MS - EARLY_SIGHTING_DURATION_MIN_MS),
      );
      earlySightingTargetAssigned = false;
      earlySightingExitTargetAssigned = false;
      if (earlySightingAudit) {
        mount.dataset.earlySightingOpportunity = "scheduled";
        mount.dataset.earlySightingWindow = `${earlySightingOpportunityStartOffsetMs.toFixed(0)}-${earlySightingOpportunityEndOffsetMs.toFixed(0)}`;
      }
    }

    resetEarlySightingOpportunity();

    function scheduleShyRetreat(now: number, duration: number, distance: number, reason: string) {
      creatureRetreatDirection.subVectors(creature.position, camera.position);
      creatureRetreatDirection.y *= .16;
      if (creatureRetreatDirection.lengthSq() < .01) creatureRetreatDirection.set(1, .08, 0);
      creatureRetreatDirection.normalize();
      shyRetreatTarget.copy(creature.position).addScaledVector(creatureRetreatDirection, distance);
      keepInsideLake(shyRetreatTarget, 104);
      const retreatFloor = terrainHeight(shyRetreatTarget.x, shyRetreatTarget.z) + 4.2;
      shyRetreatTarget.y = THREE.MathUtils.clamp(creature.position.y + 1.4, retreatFloor, -3.8);
      keepCreaturePointClear(shyRetreatTarget);
      shyRetreatUntil = Math.max(shyRetreatUntil, now + duration);
      if (creatureAudit) mount.dataset.creatureReaction = reason;
    }

    function orientCreatureAlongTravel(dt: number, turnRate = 2.4) {
      if (creatureTravel.lengthSq() < .0001) return;
      creatureFacingPoint.copy(creature.position).add(creatureTravel);
      creatureLookHelper.position.copy(creature.position);
      creatureLookHelper.lookAt(creatureFacingPoint);
      creatureLookHelper.rotateY(Math.PI);
      creature.quaternion.slerp(creatureLookHelper.quaternion, 1 - Math.exp(-dt * turnRate));
    }

    function beginCreatureCaveSettle(now: number) {
      if (creatureCaveSettleStartedAt > 0 || now < creatureRestUntil) return;
      headingToCave = false;
      creatureCaveDepartureStartedAt = 0;
      creatureCaveSettleStartedAt = now;
      creatureCaveSettleStart.copy(creature.position);
      creatureCaveSettleStartQuaternion.copy(creature.quaternion);
      // Face into the cave. The creature rig's authored forward axis is -Z,
      // hence the same half-turn used by ordinary travel orientation.
      creatureLookHelper.position.copy(creatureCavePosition);
      creatureFacingPoint.copy(creatureCavePosition).add(new THREE.Vector3(-1, 0, 0));
      creatureLookHelper.lookAt(creatureFacingPoint);
      creatureLookHelper.rotateY(Math.PI);
      creatureCaveRestQuaternion.copy(creatureLookHelper.quaternion);
      creatureTarget.copy(creatureCavePosition);
      creatureStuckSeconds = 0;
      creatureRecoveryUntil = 0;
      if (creatureAudit || lakeAudit === "creaturecave") mount.dataset.creatureCavePhase = "settling";
    }

    function beginCreatureCaveDeparture(now: number) {
      if (creatureCaveDepartureStartedAt > 0) return;
      headingToCave = false;
      creatureCaveSettleStartedAt = 0;
      creatureCaveDepartureStartedAt = now;
      creatureRestUntil = 0;
      creatureWakeAnimationStartedAt = now;
      creatureTarget.copy(creatureCaveExitPosition);
      nextRoamTargetAt = 0;
      creatureStuckSeconds = 0;
      creatureRecoveryUntil = 0;
      if (creatureAudit || lakeAudit === "creaturecave") mount.dataset.creatureCavePhase = "departing";
    }

    function moveCreatureSafely(goal: THREE.Vector3, speed: number, dt: number, avoidObstacles = true) {
      creatureTravel.subVectors(goal, creature.position);
      const distanceToGoal = creatureTravel.length();
      if (distanceToGoal <= .2) return distanceToGoal;
      creatureTravel.multiplyScalar(1 / distanceToGoal);
      const verticalIntent = creatureTravel.y;
      const step = Math.min(distanceToGoal, speed * dt);
      const lookAhead = Math.max(6.5, step * 6);
      creatureProbe.copy(creature.position).addScaledVector(creatureTravel, lookAhead);

      if (avoidObstacles) {
        for (const obstacle of creatureObstacles) {
          if (creature.position.y < obstacle.minY - 4 || creature.position.y > obstacle.maxY + 4) continue;
          const safeDistance = obstacle.radius + 5.8;
          const probeDistance = Math.hypot(creatureProbe.x - obstacle.x, creatureProbe.z - obstacle.z);
          if (probeDistance >= safeDistance) continue;

          creatureAvoidance.set(creature.position.x - obstacle.x, 0, creature.position.z - obstacle.z);
          if (creatureAvoidance.lengthSq() < .001) {
            creatureAvoidance.set(-creatureTravel.z, 0, creatureTravel.x);
          } else {
            creatureAvoidance.normalize();
          }
          creatureTangent.set(-creatureAvoidance.z, 0, creatureAvoidance.x);
          if (creatureTangent.dot(creatureTravel) < 0) creatureTangent.negate();
          creatureTravel.copy(creatureTangent).multiplyScalar(.86).addScaledVector(creatureAvoidance, .62);
          creatureTravel.y = verticalIntent;
          creatureTravel.normalize();
          creatureProbe.copy(creature.position).addScaledVector(creatureTravel, lookAhead);
        }
      }

      creature.position.addScaledVector(creatureTravel, step);
      if (avoidObstacles) keepCreaturePointClear(creature.position, 5.2);
      else keepInsideLake(creature.position, 106);
      return distanceToGoal;
    }

    function scoreEvasionRoute(target: THREE.Vector3) {
      let score = target.distanceTo(camera.position) * 1.4;
      const originalTarget = evasionRawTarget.copy(target);
      keepInsideLake(target, 104);
      target.y = THREE.MathUtils.clamp(
        target.y,
        terrainHeight(target.x, target.z) + 5.4,
        -3.8,
      );
      keepCreaturePointClear(target, 7);
      score -= originalTarget.distanceTo(target) * 8;

      for (const obstacle of creatureObstacles) {
        const segmentX = target.x - creature.position.x;
        const segmentZ = target.z - creature.position.z;
        const segmentLengthSq = segmentX * segmentX + segmentZ * segmentZ;
        const along = segmentLengthSq > .001
          ? THREE.MathUtils.clamp(
            ((obstacle.x - creature.position.x) * segmentX + (obstacle.z - creature.position.z) * segmentZ) / segmentLengthSq,
            0,
            1,
          )
          : 0;
        const pathX = creature.position.x + segmentX * along;
        const pathZ = creature.position.z + segmentZ * along;
        const pathY = THREE.MathUtils.lerp(creature.position.y, target.y, along);
        if (pathY < obstacle.minY - 5 || pathY > obstacle.maxY + 5) continue;
        const margin = Math.hypot(pathX - obstacle.x, pathZ - obstacle.z) - obstacle.radius;
        if (margin < 8) score -= (8 - margin) * 15;
      }

      for (const sample of [.25, .5, .75]) {
        evasionPathPoint.lerpVectors(creature.position, target, sample);
        const floorMargin = evasionPathPoint.y - terrainHeight(evasionPathPoint.x, evasionPathPoint.z);
        if (floorMargin < 4.2) score -= (4.2 - floorMargin) * 20;
      }
      if (target.y > -3.4) score -= (-3.4 - target.y) * 18;
      return score + rand() * 2.5;
    }

    function beginCreatureEvasion(now: number) {
      if (creatureCaveSettleStartedAt > 0 || headingToCave) {
        creatureCaveSettleStartedAt = 0;
        headingToCave = false;
        nextCaveVisitAt = now + 70000 + rand() * 70000;
      }
      evasionAway.subVectors(creature.position, camera.position);
      evasionAway.y *= .28;
      if (evasionAway.lengthSq() < .01) evasionAway.set(0, -.08, 1);
      evasionAway.normalize();
      evasionLateral.set(-evasionAway.z, 0, evasionAway.x).normalize();

      const routes: Array<{
        variant: CreatureEvasionVariant;
        handedness: -1 | 1;
        verticalDirection: -1 | 1;
        direction: THREE.Vector3;
        distance: number;
      }> = [];
      ([-1, 1] as const).forEach((side) => {
        routes.push({
          variant: "c-turn",
          handedness: side,
          verticalDirection: -1,
          direction: evasionAway.clone().multiplyScalar(.48).addScaledVector(evasionLateral, side).setY(evasionAway.y + .05),
          distance: 56,
        });
      });
      ([-1, 1] as const).forEach((verticalDirection) => {
        routes.push({
          variant: "roll-dive",
          handedness: verticalDirection === -1 ? -1 : 1,
          verticalDirection,
          direction: evasionAway.clone().multiplyScalar(.68)
            .addScaledVector(evasionLateral, verticalDirection * .18)
            .addScaledVector(WORLD_UP, verticalDirection * .9),
          distance: 58,
        });
      });
      ([-1, 1] as const).forEach((side) => {
        routes.push({
          variant: "about-face",
          handedness: side,
          verticalDirection: -1,
          direction: evasionAway.clone().addScaledVector(evasionLateral, side * .22).setY(evasionAway.y + .04),
          distance: 64,
        });
      });

      let bestScore = Number.NEGATIVE_INFINITY;
      let bestRoute = routes[0];
      for (const route of routes) {
        route.direction.normalize();
        evasionCandidate.copy(creature.position).addScaledVector(route.direction, route.distance);
        const routeScore = scoreEvasionRoute(evasionCandidate);
        if (routeScore > bestScore) {
          bestScore = routeScore;
          bestRoute = route;
          evasionTarget.copy(evasionCandidate);
        }
      }

      evasionVariant = bestRoute.variant;
      evasionHandedness = bestRoute.handedness;
      evasionVerticalDirection = bestRoute.verticalDirection;
      if (creatureTravel.lengthSq() > .001) {
        evasionStartDirection.copy(creatureTravel).normalize();
      } else {
        evasionStartDirection.set(0, 0, -1).applyQuaternion(creature.quaternion).normalize();
      }
      evasionExitDirection.subVectors(evasionTarget, creature.position).normalize();
      // A perfect 180-degree lerp collapses toward a zero vector halfway
      // through the turn. Give reversals a stable lateral arc so movement and
      // pose remain continuous instead of appearing to jitter in place.
      if (evasionStartDirection.dot(evasionExitDirection) < -.72) {
        evasionStartDirection.addScaledVector(evasionLateral, bestRoute.handedness * .42).normalize();
      }
      evasionCurveControl.copy(evasionStartDirection).add(evasionExitDirection);
      if (evasionCurveControl.lengthSq() < .01) {
        evasionCurveControl.copy(evasionLateral).multiplyScalar(bestRoute.handedness);
      } else {
        evasionCurveControl.normalize();
      }
      evasionCurveControl.addScaledVector(evasionLateral, bestRoute.handedness * .48);
      if (bestRoute.variant === "roll-dive") {
        evasionCurveControl.y += bestRoute.verticalDirection * .28;
      }
      evasionCurveControl.normalize();
      evasionStartedAt = now;
      evasionUntil = now + (bestRoute.variant === "c-turn" ? 3800 : bestRoute.variant === "roll-dive" ? 4100 : 4300);
      evasionSettleStartedAt = 0;
      evasionSettleUntil = 0;
      lastEvasionAt = now;
      if (creatureAudit) {
        mount.dataset.creatureEvasion = `${bestRoute.variant}:${bestRoute.handedness}:${bestRoute.verticalDirection}`;
      }
    }

    function createNoiseBuffer(seconds: number) {
      if (!audioContext) return null;
      const length = Math.floor(audioContext.sampleRate * seconds);
      const buffer = audioContext.createBuffer(1, length, audioContext.sampleRate);
      const data = buffer.getChannelData(0);
      let brown = 0;
      for (let i = 0; i < length; i++) {
        brown = brown * .965 + (Math.random() * 2 - 1) * .035;
        data[i] = brown * 3.2;
      }
      return buffer;
    }

    function ensureAudio() {
      if (!audioContext) {
        audioContext = new AudioContext();
        const limiter = audioContext.createDynamicsCompressor();
        limiter.threshold.value = -10;
        limiter.knee.value = 8;
        limiter.ratio.value = 6;
        limiter.attack.value = .01;
        limiter.release.value = .24;
        masterBus = audioContext.createGain();
        suitBus = audioContext.createGain();
        waterBus = audioContext.createGain();
        eventBus = audioContext.createGain();
        introBus = audioContext.createGain();
        masterBus.gain.value = .82;
        suitBus.gain.value = .92;
        waterBus.gain.value = .2;
        eventBus.gain.value = .78;
        introBus.gain.value = .24;
        suitBus.connect(masterBus);
        waterBus.connect(masterBus);
        eventBus.connect(masterBus);
        introBus.connect(masterBus);
        masterBus.connect(limiter).connect(audioContext.destination);

        // The supplied title music is decoded once and loops without an HTML
        // media element, so pausing/suspending the shared AudioContext still
        // freezes every part of the game consistently.
        void fetch(new URL(introMusicUrl, document.baseURI))
          .then((response) => response.arrayBuffer())
          .then((bytes) => audioContext?.decodeAudioData(bytes))
          .then((buffer) => {
            if (!buffer || !audioContext || !introBus || audioContext.state === "closed") return;
            introMusicSource = audioContext.createBufferSource();
            introMusicGain = audioContext.createGain();
            introMusicSource.buffer = buffer;
            introMusicSource.loop = true;
            introMusicGain.gain.value = .82;
            introMusicSource.connect(introMusicGain).connect(introBus);
            introMusicSource.start(0, Math.min(INTRO_MUSIC_SWELL_OFFSET_SECONDS, Math.max(0, buffer.duration - .1)));
          })
          .catch(() => undefined);

        void fetch(new URL(cameraShutterUrl, document.baseURI))
          .then((response) => response.arrayBuffer())
          .then((bytes) => audioContext?.decodeAudioData(bytes))
          .then((buffer) => { if (buffer) cameraShutterBuffer = buffer; })
          .catch(() => undefined);

        const waterBuffer = createNoiseBuffer(10.7);
        const waterBufferB = createNoiseBuffer(13.1);
        if (waterBuffer && waterBufferB) {
          waterNoise = audioContext.createBufferSource();
          waterNoiseB = audioContext.createBufferSource();
          waterFilter = audioContext.createBiquadFilter();
          waterNoise.buffer = waterBuffer;
          waterNoiseB.buffer = waterBufferB;
          waterNoise.loop = true;
          waterNoiseB.loop = true;
          waterFilter.type = "lowpass";
          waterFilter.frequency.value = 260;
          waterFilter.Q.value = 1.8;
          const bedGainA = audioContext.createGain();
          const bedGainB = audioContext.createGain();
          bedGainA.gain.value = .62;
          bedGainB.gain.value = .48;
          waterNoise.connect(bedGainA).connect(waterFilter).connect(waterBus);
          waterNoiseB.connect(bedGainB).connect(waterFilter);
          waterNoise.start();
          waterNoiseB.start(0, 3.7);
        }
        waterSub = audioContext.createOscillator();
        const subGain = audioContext.createGain();
        waterSub.type = "sine";
        waterSub.frequency.value = 31;
        subGain.gain.value = .035;
        waterSub.connect(subGain).connect(waterBus);
        waterSub.start();
        Object.entries(creatureAudioUrls).forEach(([name, path]) => {
          void fetch(new URL(path, document.baseURI))
            .then((response) => response.arrayBuffer())
            .then((bytes) => audioContext?.decodeAudioData(bytes))
            .then((buffer) => { if (buffer) creatureAudio.set(name, buffer); })
            .catch(() => undefined);
        });
        Object.entries(floodlightAudioUrls).forEach(([name, path]) => {
          void fetch(new URL(path, document.baseURI))
            .then((response) => response.arrayBuffer())
            .then((bytes) => audioContext?.decodeAudioData(bytes))
            .then((buffer) => {
              if (!buffer) return;
              floodlightAudio.set(name, buffer);
              if (name === "active" && floodlightOn) startFloodlightActiveAudio();
            })
            .catch(() => undefined);
        });
      }
      if (audioContext.state === "suspended") void audioContext.resume();
    }

    introAudioRef.current = ensureAudio;
    // Browsers that permit ambient autoplay begin here; the title screen's
    // first pointer interaction resumes the same graph when autoplay is gated.
    ensureAudio();

    function playHeartbeat(strength: number) {
      if (!audioContext || !suitBus) return;
      const start = audioContext.currentTime;
      for (const offset of [0, .115]) {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(48 - offset * 22, start + offset);
        osc.frequency.exponentialRampToValueAtTime(34, start + offset + .12);
        gain.gain.setValueAtTime(.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(.022 + strength * .052, start + offset + .018);
        gain.gain.exponentialRampToValueAtTime(.0001, start + offset + .16);
        osc.connect(gain).connect(suitBus);
        osc.start(start + offset);
        osc.stop(start + offset + .18);
      }
    }

    function playBreath(strain: number) {
      if (!audioContext || !suitBus) return;
      if (soundAudit) mount.dataset.lastSuitSound = strain > .55 ? "strained-breath" : "breath";
      const duration = 1.25;
      const buffer = createNoiseBuffer(duration);
      if (!buffer) return;
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        const t = i / data.length;
        const inhale = Math.sin(Math.min(1, t / .46) * Math.PI) * (t < .46 ? 1 : 0);
        const exhaleT = Math.max(0, (t - .53) / .47);
        const exhale = Math.sin(Math.min(1, exhaleT) * Math.PI) * (t >= .53 ? .82 : 0);
        data[i] *= (inhale + exhale) * (.75 + strain * .65);
      }
      const source = audioContext.createBufferSource();
      const filter = audioContext.createBiquadFilter();
      const gain = audioContext.createGain();
      source.buffer = buffer;
      filter.type = "bandpass";
      filter.frequency.value = 610 + strain * 170;
      filter.Q.value = .62;
      gain.gain.value = .19 + strain * .08;
      source.connect(filter).connect(gain).connect(suitBus);
      source.start();
    }

    function playGasp() {
      if (!audioContext || !suitBus) return;
      if (soundAudit) mount.dataset.lastSuitSound = "gasp";
      const buffer = createNoiseBuffer(.82);
      if (!buffer) return;
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        const attack = Math.min(1, i / (data.length * .08));
        const release = Math.max(0, 1 - i / data.length);
        data[i] *= attack * release * 1.8;
      }
      const source = audioContext.createBufferSource();
      const filter = audioContext.createBiquadFilter();
      const gain = audioContext.createGain();
      source.buffer = buffer;
      filter.type = "bandpass";
      filter.frequency.value = 720;
      filter.Q.value = .55;
      gain.gain.setValueAtTime(.48, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .82);
      source.connect(filter).connect(gain).connect(suitBus);
      source.start();
    }

    function playSurfaceGasp() {
      if (!audioContext || !suitBus) return;
      if (soundAudit) mount.dataset.lastSuitSound = "surface-gasp";
      const duration = 1.08;
      const buffer = createNoiseBuffer(duration);
      if (!buffer) return;
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        const progress = i / data.length;
        const inhale = Math.sin(Math.min(1, progress / .56) * Math.PI) * (progress < .56 ? 1 : 0);
        const catchBreath = progress > .62
          ? Math.sin(Math.min(1, (progress - .62) / .38) * Math.PI) * .32
          : 0;
        data[i] *= (inhale + catchBreath) * 2.05;
      }
      const source = audioContext.createBufferSource();
      const filter = audioContext.createBiquadFilter();
      const gain = audioContext.createGain();
      source.buffer = buffer;
      filter.type = "bandpass";
      filter.frequency.value = 840;
      filter.Q.value = .48;
      gain.gain.setValueAtTime(.52, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
      source.connect(filter).connect(gain).connect(suitBus);
      source.start();
    }

    function playFirstSightingSting() {
      if (!audioContext || !eventBus) return;
      if (soundAudit) mount.dataset.lastCreatureCall = "first-sighting-dread";
      const start = audioContext.currentTime;
      const dreadBuffer = createNoiseBuffer(5.8);
      if (dreadBuffer) {
        const source = audioContext.createBufferSource();
        const filter = audioContext.createBiquadFilter();
        const gain = audioContext.createGain();
        source.buffer = dreadBuffer;
        filter.type = "lowpass";
        filter.Q.value = 7.5;
        filter.frequency.setValueAtTime(680, start);
        filter.frequency.exponentialRampToValueAtTime(54, start + 5.5);
        gain.gain.setValueAtTime(.0001, start);
        gain.gain.exponentialRampToValueAtTime(.19, start + .28);
        gain.gain.exponentialRampToValueAtTime(.055, start + 2.7);
        gain.gain.exponentialRampToValueAtTime(.0001, start + 5.8);
        source.connect(filter).connect(gain).connect(eventBus);
        source.start(start);
      }

      for (const [frequency, level] of [[43, .075], [46.5, .052]] as const) {
        const drone = audioContext.createOscillator();
        const droneGain = audioContext.createGain();
        drone.type = "sine";
        drone.frequency.setValueAtTime(frequency, start);
        drone.frequency.exponentialRampToValueAtTime(frequency * .72, start + 8.2);
        droneGain.gain.setValueAtTime(.0001, start);
        droneGain.gain.exponentialRampToValueAtTime(level, start + .7);
        droneGain.gain.setValueAtTime(level, start + 4.8);
        droneGain.gain.exponentialRampToValueAtTime(.0001, start + 8.3);
        drone.connect(droneGain).connect(eventBus);
        drone.start(start);
        drone.stop(start + 8.4);
      }

      const descendingTone = audioContext.createOscillator();
      const descendingGain = audioContext.createGain();
      descendingTone.type = "triangle";
      descendingTone.frequency.setValueAtTime(176, start + .05);
      descendingTone.frequency.exponentialRampToValueAtTime(37, start + 3.4);
      descendingGain.gain.setValueAtTime(.0001, start);
      descendingGain.gain.exponentialRampToValueAtTime(.062, start + .12);
      descendingGain.gain.exponentialRampToValueAtTime(.0001, start + 3.6);
      descendingTone.connect(descendingGain).connect(eventBus);
      descendingTone.start(start + .05);
      descendingTone.stop(start + 3.7);
    }

    type CallMood = "curious" | "hunting";
    type CallTier = "far" | "medium" | "close";
    function callTierForDistance(distance: number): CallTier {
      return distance > 34 ? "far" : distance > 12 ? "medium" : "close";
    }

    function playCreatureClip(name: keyof typeof creatureAudioUrls, tier: CallTier, gainScale = 1) {
      if (!audioContext || !eventBus) return false;
      const buffer = creatureAudio.get(name);
      if (!buffer) return false;
      const source = audioContext.createBufferSource();
      const filter = audioContext.createBiquadFilter();
      const panner = audioContext.createPanner();
      const gain = audioContext.createGain();
      source.buffer = buffer;
      filter.type = "lowpass";
      filter.frequency.value = { far: 1150, medium: 1850, close: 3100 }[tier];
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 6;
      panner.maxDistance = 230;
      panner.rolloffFactor = .72;
      panner.positionX.value = creature.position.x;
      panner.positionY.value = creature.position.y;
      panner.positionZ.value = creature.position.z;
      gain.gain.value = { far: .62, medium: .82, close: 1 }[tier] * gainScale * CREATURE_AUDIO_GAIN_MULTIPLIER;
      source.connect(filter).connect(panner).connect(gain).connect(eventBus);
      source.start();
      const vocalNow = performance.now();
      creatureVocalizationStartedAt = vocalNow;
      creatureVocalizationUntil = vocalNow + THREE.MathUtils.clamp(buffer.duration * 820, 850, 2400);
      if (soundAudit) mount.dataset.lastCreatureCall = `${name}-${tier}`;
      return true;
    }

    type NeutralCall = "favorite-non-aggro" | "random-1" | "random-2";
    let neutralCallBag: NeutralCall[] = [];
    function nextNeutralCall(): NeutralCall {
      if (neutralCallBag.length === 0) {
        neutralCallBag = ["favorite-non-aggro", "random-1", "random-2"];
        for (let index = neutralCallBag.length - 1; index > 0; index--) {
          const swapIndex = Math.floor(rand() * (index + 1));
          [neutralCallBag[index], neutralCallBag[swapIndex]] = [neutralCallBag[swapIndex], neutralCallBag[index]];
        }
      }
      return neutralCallBag.pop()!;
    }

    function playCreatureCall(mood: CallMood, tier: CallTier) {
      const huntingChoices = tier === "far"
        ? ["far-aggro-1", "far-aggro-2"] as const
        : ["mid-aggro"] as const;
      const name = mood === "curious"
        ? nextNeutralCall()
        : huntingChoices[Math.floor(rand() * huntingChoices.length)];
      playCreatureClip(name, tier, mood === "curious" ? .96 : 1);
    }

    function wakeCreatureIntoCommitted(now: number, source: "camera" | "floodlight") {
      if (now >= creatureRestUntil || creature.position.distanceTo(camera.position) > 32) return false;
      creatureRestUntil = 0;
      headingToCave = false;
      beginCreatureCaveDeparture(now);
      shyRetreatUntil = 0;
      creatureRecoveryUntil = 0;
      creatureState = "Committed";
      stateEnteredAt = now;
      // Begin halfway through the authored 42-second closing circle.
      commitBeganAt = now - 21000;
      investigationMinimumUntil = now;
      pendingEscalationAt = 0;
      aggro = 1;
      lastKnownPosition.copy(camera.position);
      playCreatureClip("aggro-engaged", callTierForDistance(creature.position.distanceTo(camera.position)), 1.12);
      nextCreatureCallAt = now + 4200;
      if (creatureAudit || nestAudit || lakeAudit === "creaturecave") mount.dataset.creatureWakeTrigger = source;
      return true;
    }

    function playWaterEntry() {
      if (!audioContext || !eventBus || !suitBus) return;
      const start = audioContext.currentTime;
      const splashBuffer = createNoiseBuffer(1.25);
      if (splashBuffer) {
        const splash = audioContext.createBufferSource();
        const splashFilter = audioContext.createBiquadFilter();
        const splashGain = audioContext.createGain();
        splash.buffer = splashBuffer;
        splashFilter.type = "lowpass";
        splashFilter.frequency.setValueAtTime(2100, start);
        splashFilter.frequency.exponentialRampToValueAtTime(170, start + 1.1);
        splashGain.gain.setValueAtTime(.0001, start);
        splashGain.gain.exponentialRampToValueAtTime(.46, start + .018);
        splashGain.gain.exponentialRampToValueAtTime(.0001, start + 1.2);
        splash.connect(splashFilter).connect(splashGain).connect(eventBus);
        splash.start(start);
      }
      const suitHit = audioContext.createOscillator();
      const suitHitGain = audioContext.createGain();
      suitHit.type = "triangle";
      suitHit.frequency.setValueAtTime(74, start);
      suitHit.frequency.exponentialRampToValueAtTime(27, start + .44);
      suitHitGain.gain.setValueAtTime(.18, start);
      suitHitGain.gain.exponentialRampToValueAtTime(.0001, start + .48);
      suitHit.connect(suitHitGain).connect(suitBus);
      suitHit.start(start);
      suitHit.stop(start + .5);
    }

    function playAttackImpact() {
      if (!audioContext || !eventBus || !suitBus) return;
      if (soundAudit) mount.dataset.lastCreatureCall = "hunting-close-impact";
      const start = audioContext.currentTime;
      if (waterBus) {
        waterBus.gain.cancelScheduledValues(start);
        waterBus.gain.setValueAtTime(Math.max(.0001, waterBus.gain.value), start);
        waterBus.gain.exponentialRampToValueAtTime(.0001, start + .11);
      }

      const surgeBuffer = createNoiseBuffer(1.05);
      if (surgeBuffer) {
        const surge = audioContext.createBufferSource();
        const surgeFilter = audioContext.createBiquadFilter();
        const surgeGain = audioContext.createGain();
        surge.buffer = surgeBuffer;
        surgeFilter.type = "lowpass";
        surgeFilter.frequency.setValueAtTime(190, start);
        surgeFilter.frequency.exponentialRampToValueAtTime(58, start + .8);
        surgeGain.gain.setValueAtTime(.0001, start);
        surgeGain.gain.exponentialRampToValueAtTime(.34, start + .025);
        surgeGain.gain.exponentialRampToValueAtTime(.0001, start + 1.02);
        surge.connect(surgeFilter).connect(surgeGain).connect(eventBus);
        surge.start(start);
      }

      const bodyHit = audioContext.createOscillator();
      const bodyGain = audioContext.createGain();
      bodyHit.type = "triangle";
      bodyHit.frequency.setValueAtTime(46, start);
      bodyHit.frequency.exponentialRampToValueAtTime(19, start + .72);
      bodyGain.gain.setValueAtTime(.0001, start);
      bodyGain.gain.exponentialRampToValueAtTime(.28, start + .018);
      bodyGain.gain.exponentialRampToValueAtTime(.0001, start + .8);
      bodyHit.connect(bodyGain).connect(eventBus);
      bodyHit.start(start);
      bodyHit.stop(start + .82);

      const suitGroan = audioContext.createOscillator();
      const groanGain = audioContext.createGain();
      suitGroan.type = "sawtooth";
      suitGroan.frequency.setValueAtTime(93, start + .08);
      suitGroan.frequency.exponentialRampToValueAtTime(27, start + .92);
      groanGain.gain.setValueAtTime(.0001, start);
      groanGain.gain.exponentialRampToValueAtTime(.11, start + .16);
      groanGain.gain.exponentialRampToValueAtTime(.0001, start + .98);
      suitGroan.connect(groanGain).connect(suitBus);
      suitGroan.start(start + .08);
      suitGroan.stop(start + 1);
    }

    function playInstrumentClick(weight = 1) {
      if (!audioContext || !suitBus) return;
      const start = audioContext.currentTime;
      const click = audioContext.createOscillator();
      const clickGain = audioContext.createGain();
      click.type = "square";
      click.frequency.setValueAtTime(118 * weight, start);
      click.frequency.exponentialRampToValueAtTime(42, start + .07);
      clickGain.gain.setValueAtTime(.07, start);
      clickGain.gain.exponentialRampToValueAtTime(.0001, start + .085);
      click.connect(clickGain).connect(suitBus);
      click.start(start);
      click.stop(start + .09);
    }

    function playHeadlampSwitch(enabled: boolean) {
      ensureAudio();
      if (!audioContext || !suitBus) return;
      const start = audioContext.currentTime;
      const click = audioContext.createOscillator();
      const clickGain = audioContext.createGain();
      click.type = "square";
      click.frequency.setValueAtTime(enabled ? 142 : 108, start);
      click.frequency.exponentialRampToValueAtTime(48, start + .055);
      clickGain.gain.setValueAtTime(.038, start);
      clickGain.gain.exponentialRampToValueAtTime(.0001, start + .065);
      click.connect(clickGain).connect(suitBus);
      click.start(start);
      click.stop(start + .07);

      // A restrained electrical chirp separates the lamp from the map's
      // plain mechanical click without competing with the carried floodlight.
      const chirp = audioContext.createOscillator();
      const chirpGain = audioContext.createGain();
      chirp.type = "sine";
      chirp.frequency.setValueAtTime(enabled ? 235 : 255, start + .008);
      chirp.frequency.exponentialRampToValueAtTime(enabled ? 405 : 92, start + .095);
      chirpGain.gain.setValueAtTime(.0001, start);
      chirpGain.gain.exponentialRampToValueAtTime(.024, start + .014);
      chirpGain.gain.exponentialRampToValueAtTime(.0001, start + .115);
      chirp.connect(chirpGain).connect(suitBus);
      chirp.start(start + .008);
      chirp.stop(start + .12);
      if (soundAudit) mount.dataset.lastSuitSound = enabled ? "headlamp-on" : "headlamp-off";
    }

    function playCameraShutter() {
      if (!audioContext || !suitBus) return;
      if (!cameraShutterBuffer) {
        playInstrumentClick(1.6);
        return;
      }
      const source = audioContext.createBufferSource();
      const gain = audioContext.createGain();
      source.buffer = cameraShutterBuffer;
      gain.gain.value = .84;
      source.connect(gain).connect(suitBus);
      source.start();
    }

    function playFloodlightOneShot(name: "on" | "off" | "burnout", level: number) {
      ensureAudio();
      if (!audioContext || !suitBus) return;
      const buffer = floodlightAudio.get(name);
      if (!buffer) return;
      const source = audioContext.createBufferSource();
      const gain = audioContext.createGain();
      source.buffer = buffer;
      gain.gain.value = level;
      source.connect(gain).connect(suitBus);
      source.start();
    }

    function stopFloodlightActiveAudio(fade = true) {
      if (!floodlightActiveSource || !audioContext) return;
      const source = floodlightActiveSource;
      const gain = floodlightActiveGain;
      const now = audioContext.currentTime;
      if (gain && fade) {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(Math.max(.0001, gain.gain.value), now);
        gain.gain.exponentialRampToValueAtTime(.0001, now + .12);
      }
      try { source.stop(fade ? now + .13 : now); } catch { /* already stopped */ }
      floodlightActiveSource = null;
      floodlightActiveGain = null;
    }

    function startFloodlightActiveAudio() {
      if (!floodlightOn || floodlightActiveSource || !audioContext || !suitBus) return;
      const buffer = floodlightAudio.get("active");
      if (!buffer) return;
      const source = audioContext.createBufferSource();
      const gain = audioContext.createGain();
      source.buffer = buffer;
      source.loop = true;
      gain.gain.value = .36;
      source.connect(gain).connect(suitBus);
      source.start();
      floodlightActiveSource = source;
      floodlightActiveGain = gain;
      source.onended = () => {
        if (floodlightActiveSource === source) {
          floodlightActiveSource = null;
          floodlightActiveGain = null;
        }
      };
    }

    function setFloodlightPowered(
      next: boolean,
      reason: "manual" | "stow" | "burnout" | "reset" = "manual",
    ) {
      if (next) {
        if (floodlightOverheated || floodlightCharge <= .001) {
          floodRig.visible = true;
          setFloodOn(false);
          updateFloodlightChargeDisplay(floodlightCharge, floodlightOverheated);
          return false;
        }
        floodlightOn = true;
        floodRig.visible = true;
        setFloodOn(true);
        playFloodlightOneShot("on", .68);
        startFloodlightActiveAudio();
        return true;
      }

      const wasOn = floodlightOn;
      floodlightOn = false;
      setFloodOn(false);
      stopFloodlightActiveAudio();
      if (reason === "burnout") {
        floodlightOverheated = true;
        floodRig.visible = true;
        playFloodlightOneShot("burnout", .82);
      } else {
        floodRig.visible = false;
        if (wasOn && reason !== "reset") playFloodlightOneShot("off", .66);
      }
      updateFloodlightChargeDisplay(floodlightCharge, floodlightOverheated);
      return false;
    }

    function playSonarPing(distance: number) {
      if (!audioContext || !suitBus || !eventBus) return;
      const start = audioContext.currentTime;
      const ping = audioContext.createOscillator();
      const pingGain = audioContext.createGain();
      ping.type = "sine";
      ping.frequency.setValueAtTime(920, start);
      ping.frequency.exponentialRampToValueAtTime(510, start + .16);
      pingGain.gain.setValueAtTime(.12, start);
      pingGain.gain.exponentialRampToValueAtTime(.0001, start + .21);
      ping.connect(pingGain).connect(suitBus);
      ping.start(start);
      ping.stop(start + .22);

      const echo = audioContext.createOscillator();
      const echoGain = audioContext.createGain();
      const echoPanner = audioContext.createPanner();
      const echoAt = start + THREE.MathUtils.clamp(.28 + distance / 180, .34, 1.05);
      echo.type = "sine";
      echo.frequency.setValueAtTime(420, echoAt);
      echo.frequency.exponentialRampToValueAtTime(180, echoAt + .26);
      echoGain.gain.setValueAtTime(.0001, start);
      echoGain.gain.setValueAtTime(.075, echoAt);
      echoGain.gain.exponentialRampToValueAtTime(.0001, echoAt + .34);
      echoPanner.panningModel = "HRTF";
      echoPanner.distanceModel = "inverse";
      echoPanner.refDistance = 8;
      echoPanner.maxDistance = 230;
      echoPanner.rolloffFactor = .52;
      echoPanner.positionX.value = creature.position.x;
      echoPanner.positionY.value = creature.position.y;
      echoPanner.positionZ.value = creature.position.z;
      echo.connect(echoPanner).connect(echoGain).connect(eventBus);
      echo.start(echoAt);
      echo.stop(echoAt + .36);
    }

    function playSonarReadyCue() {
      if (!audioContext || !suitBus) return;
      const start = audioContext.currentTime;
      for (const [index, frequency] of [610, 880].entries()) {
        const tone = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const at = start + index * .105;
        tone.type = "sine";
        tone.frequency.setValueAtTime(frequency, at);
        tone.frequency.exponentialRampToValueAtTime(frequency * 1.12, at + .09);
        gain.gain.setValueAtTime(.0001, at);
        gain.gain.exponentialRampToValueAtTime(.055, at + .012);
        gain.gain.exponentialRampToValueAtTime(.0001, at + .12);
        tone.connect(gain).connect(suitBus);
        tone.start(at);
        tone.stop(at + .13);
      }
    }

    function updateSonarBearing() {
      contactDirection.subVectors(creature.position, camera.position);
      contactDirection.y = 0;
      if (contactDirection.lengthSq() < .0001) return 0;
      contactDirection.normalize();
      camera.getWorldDirection(beamDir);
      beamDir.y = 0;
      beamDir.normalize();
      right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      right.y = 0;
      right.normalize();
      // CSS zero degrees points straight ahead and positive angles rotate
      // clockwise, so dotting the target against the camera's right/forward
      // axes produces an exact player-relative bearing.
      const bearing = THREE.MathUtils.radToDeg(Math.atan2(
        contactDirection.dot(right),
        contactDirection.dot(beamDir),
      ));
      const bearingStep = Math.round(bearing);
      if (bearingStep !== lastSonarBearingStep) {
        lastSonarBearingStep = bearingStep;
        setSonarBearing(bearingStep);
      }
      if (instrumentsAudit) mount.dataset.sonarBearing = bearing.toFixed(0);
      return bearing;
    }

    function sendSonarPing(now = performance.now()) {
      if (!running || now < sonarCooldownUntil) return;
      ensureAudio();
      const distance = creature.position.distanceTo(camera.position);
      updateSonarBearing();
      setSonarMapPosition({
        x: THREE.MathUtils.clamp(((creature.position.x + WORLD_LIMIT) / (WORLD_LIMIT * 2)) * 100, 2, 98),
        y: THREE.MathUtils.clamp(((WORLD_LIMIT - creature.position.z) / (WORLD_LIMIT * 2)) * 100, 2, 98),
      });
      sonarVisibleUntil = now + 2600;
      sonarCooldownUntil = now + SONAR_COOLDOWN_MS;
      lastSonarReadinessStep = 0;
      sonarReadyCuePending = true;
      setSonarReadiness(0);
      sonarCuriosityUntil = now + 52000;
      const interestAngle = rand() * Math.PI * 2;
      const interestOffset = 18 + rand() * 22;
      sonarInterestPoint.copy(camera.position);
      sonarInterestPoint.x += Math.cos(interestAngle) * interestOffset;
      sonarInterestPoint.z += Math.sin(interestAngle) * interestOffset;
      sonarInterestPoint.y = THREE.MathUtils.clamp(camera.position.y + (rand() - .5) * 7, terrainHeight(sonarInterestPoint.x, sonarInterestPoint.z) + 3, -3);
      keepInsideLake(sonarInterestPoint, 104);
      playSonarPing(distance);
    }

    function evidenceInView(maxDistance: number, minDot: number, allowPhotographed = false, collectibleOnly = false) {
      camera.getWorldDirection(beamDir);
      let best: EvidenceRecord | null = null;
      let bestDistance = Infinity;
      for (const evidence of evidenceRecords) {
        if (evidence.taken || (collectibleOnly && !evidence.collectible) || (!allowPhotographed && photographedEvidence.has(evidence.id))) continue;
        contactDirection.subVectors(evidence.group.position, camera.position);
        const distance = contactDirection.length();
        if (distance > maxDistance || distance >= bestDistance) continue;
        contactDirection.normalize();
        if (beamDir.dot(contactDirection) < minDot) continue;
        best = evidence;
        bestDistance = distance;
      }
      return best;
    }

    function creatureInCameraFrame() {
      if (!creature.visible) return false;
      head.getWorldPosition(creatureHeadWorld);
      contactDirection.subVectors(creatureHeadWorld, camera.position);
      const distance = contactDirection.length();
      if (distance < .25 || distance > 34) return false;
      contactDirection.normalize();
      camera.getWorldDirection(beamDir);
      if (beamDir.dot(contactDirection) < .94) return false;
      sightRay.set(camera.position, contactDirection);
      sightRay.far = Math.max(.1, distance - .7);
      return sightRay.intersectObjects(coverMeshes, false).length === 0;
    }

    function showEvidenceEvent(message: string, duration = 2400) {
      lastEvidenceEvent = message;
      evidenceEventUntil = performance.now() + duration;
      setEvidenceEvent(message);
    }

    function takeEvidence() {
      if (!running || diveComplete) return;
      if (carriedEvidence.length >= 3) {
        showEvidenceEvent("CARRY RACK FULL");
        return;
      }
      const evidence = evidenceInView(3.25, .58, false, true);
      if (!evidence) {
        showEvidenceEvent("NO SAMPLE IN REACH", 1200);
        return;
      }
      evidence.taken = true;
      evidence.group.visible = false;
      carriedEvidence.push(evidence);
      setCarryLabels(carriedEvidence.map((item) => item.label));
      showEvidenceEvent(`SECURED — ${evidence.label} · VALUE ${evidence.value}`);
      if (evidence.nearNest) {
        aggroInputs.nearNestTheft += .34;
        lastKnownPosition.copy(camera.position);
        if (instrumentsAudit || evidenceAudit || nestAudit) mount.dataset.nestAggro = "0.34";
      }
      if (evidenceAudit || nestAudit) mount.dataset.carriedEvidence = carriedEvidence.map((item) => item.id).join("|");
    }

    function playAirBoost() {
      if (!audioContext || !suitBus || !waterBus) return;
      const start = audioContext.currentTime;
      const buffer = createNoiseBuffer(.92);
      if (buffer) {
        const rush = audioContext.createBufferSource();
        const filter = audioContext.createBiquadFilter();
        const gain = audioContext.createGain();
        rush.buffer = buffer;
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(210, start);
        filter.frequency.exponentialRampToValueAtTime(620, start + .36);
        gain.gain.setValueAtTime(.0001, start);
        gain.gain.exponentialRampToValueAtTime(.3, start + .025);
        gain.gain.exponentialRampToValueAtTime(.0001, start + .88);
        rush.connect(filter).connect(gain).connect(waterBus);
        rush.start(start);
      }
      const valve = audioContext.createOscillator();
      const valveGain = audioContext.createGain();
      valve.type = "sawtooth";
      valve.frequency.setValueAtTime(86, start);
      valve.frequency.exponentialRampToValueAtTime(34, start + .52);
      valveGain.gain.setValueAtTime(.09, start);
      valveGain.gain.exponentialRampToValueAtTime(.0001, start + .58);
      valve.connect(valveGain).connect(suitBus);
      valve.start(start);
      valve.stop(start + .6);
    }

    function triggerAirBoost(now = performance.now()) {
      if (!running || diveComplete || now < boostCooldownUntil || airValue <= 2) return;
      ensureAudio();
      playAirBoost();
      camera.getWorldDirection(beamDir);
      velocity.addScaledVector(beamDir.normalize(), 9.5);
      airValue *= .27;
      setAir(airValue);
      breathDebtValue = Math.max(breathDebtValue, .58);
      boostCooldownUntil = now + 2400;
      showEvidenceEvent(`EMERGENCY AIR BOOST — ${Math.round(airValue * 2.1)} BAR REMAIN`, 3200);
      if (evidenceAudit) mount.dataset.boostAir = airValue.toFixed(2);
    }

    function unbankedLossText() {
      const count = carriedEvidence.length + photographedEvidence.size + (creaturePhotographed ? 1 : 0);
      return count > 0 ? ` ${count} unbanked evidence record${count === 1 ? " was" : "s were"} lost.` : "";
    }

    function bankDive() {
      if (diveComplete) return;
      diveComplete = true;
      running = false;
      descentActive = false;
      const carriedValue = carriedEvidence.reduce((sum, evidence) => sum + evidence.value, 0);
      const photographedValue = evidenceRecords
        .filter((evidence) => photographedEvidence.has(evidence.id))
        .reduce((sum, evidence) => sum + evidence.value, 0);
      const creaturePhotoValue = creaturePhotographed ? NEST_PHOTO_EVIDENCE_VALUE : 0;
      const physicalPieces = carriedEvidence.length;
      const goodPhotographs = photographedEvidence.size + (creaturePhotographed ? 1 : 0);
      const attemptedPhotographs = 6 - exposuresLeft;
      const grade = evaluateDiveGrade(goodPhotographs, physicalPieces, attemptedPhotographs);
      setBankedValue(carriedValue + photographedValue + creaturePhotoValue);
      setDiveGrade(grade);
      setGoodPhotoCount(goodPhotographs);
      setPhysicalEvidenceCount(physicalPieces);
      setDivePhase("complete");
      setEvidencePrompt("");
      setEvidenceEvent("");
      document.exitPointerLock?.();
      if (evidenceAudit || returnAudit || nestAudit) {
        mount.dataset.bankedValue = String(carriedValue + photographedValue + creaturePhotoValue);
        mount.dataset.diveGrade = grade;
        mount.dataset.goodPhotographs = String(goodPhotographs);
        mount.dataset.physicalEvidencePieces = String(physicalPieces);
      }
    }

    function fireCamera(now = performance.now()) {
      if (!(running || onBoat) || !cameraIsHeld || exposuresLeft <= 0 || now < flashPeakUntil) return;
      ensureAudio();
      playCameraShutter();
      exposuresLeft -= 1;
      setExposures(exposuresLeft);
      setPhotoCount(6 - exposuresLeft);
      flashBlindValue = 1;
      flashPeakUntil = now + 90;
      if (running) {
        aggroInputs.cameraFlash += .07;
        flashCuriosityUntil = now + 18000;
        lastKnownPosition.copy(camera.position);
      }
      try {
        const preview = renderer.domElement.toDataURL("image/jpeg", .76);
        if (preview && preview !== "data:,") setPhotoPreviews((current) => [...current, preview]);
      } catch {
        // Photo evidence still registers if a privacy-restricted browser blocks canvas export.
      }
      const photographed = evidenceInView(8.4, .91);
      if (photographed) {
        photographedEvidence.add(photographed.id);
        showEvidenceEvent(`EXPOSED — ${photographed.label} · VALUE ${photographed.value}`);
        if (evidenceAudit || nestAudit) mount.dataset.photographedEvidence = [...photographedEvidence].join("|");
      }
      const photographedCreatureNow = creatureInCameraFrame();
      if (!creaturePhotographed && photographedCreatureNow) {
        creaturePhotographed = true;
        showEvidenceEvent(`EXPOSED — CREATURE · VALUE ${NEST_PHOTO_EVIDENCE_VALUE}`);
        if (evidenceAudit || creatureAudit) mount.dataset.creaturePhotographed = "true";
      }
      if (photographedCreatureNow) wakeCreatureIntoCommitted(now, "camera");
      if (instrumentsAudit) {
        mount.dataset.exposures = String(exposuresLeft);
        mount.dataset.cameraAggro = "0.07";
        mount.dataset.flashBlind = "full";
      }
    }

    function dropMarker() {
      if (!running || markersLeft <= 0) return;
      ensureAudio();
      playInstrumentClick(.62);
      const marker = markerPool.find((candidate) => !droppedMarkers.includes(candidate));
      if (!marker) return;
      camera.getWorldDirection(beamDir);
      marker.group.position.copy(camera.position).addScaledVector(beamDir, 1.25);
      marker.group.position.y -= .3;
      marker.group.rotation.set(0, yaw + rand() * .7, 0);
      marker.light.intensity = 128;
      droppedMarkers.push(marker);
      markersLeft -= 1;
      setDropLights(markersLeft);
      showEvidenceEvent(`DECOY DEPLOYED — ${markersLeft} REMAIN`, 1800);
      if (instrumentsAudit) {
        mount.dataset.dropLights = String(markersLeft);
        mount.dataset.dropAggroOwner = "marker";
      }
    }

    function resize() {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      const pixelRatio = renderer.getPixelRatio();
      const scale = width < 800 ? .68 : .78;
      const targetWidth = Math.max(2, Math.floor(width * pixelRatio * scale));
      const targetHeight = Math.max(2, Math.floor(height * pixelRatio * scale));
      target.setSize(targetWidth, targetHeight);
      postMaterial.uniforms.resolution.value.set(targetWidth, targetHeight);
    }

    function onMouseMove(event: MouseEvent) {
      if (document.pointerLockElement !== inputSurface) return;
      yaw -= event.movementX * .00165;
      pitch -= event.movementY * .00155;
      pitch = THREE.MathUtils.clamp(pitch, -1.43, 1.43);
    }
    function requestInputLock() {
      if (document.pointerLockElement === inputSurface) {
        setLocked(true);
        setPauseState(false);
        return;
      }
      try {
        const request = inputSurface.requestPointerLock();
        if (request && typeof request.catch === "function") {
          void request.catch(() => {
            setLocked(false);
            // Never leave the game running without look control. A rejected
            // recapture keeps the menu open so Continue can be tried again.
            setPauseState(true);
          });
        } else {
          // Older browsers return void; their ensuing pointerlockchange event
          // normally confirms capture, while this preserves legacy behavior.
          setLocked(true);
          setPauseState(false);
        }
      } catch {
        setLocked(false);
        setPauseState(true);
      }
    }
    function setPauseState(nextPaused: boolean) {
      if (!sessionStarted) return;
      setPauseOpen(nextPaused);
      if (paused === nextPaused) return;
      paused = nextPaused;
      if (paused) {
        keys.clear();
        if (audioContext?.state === "running") void audioContext.suspend();
      } else {
        last = performance.now();
        if (audioContext?.state === "suspended") void audioContext.resume();
      }
    }
    type DiveExit = { kind: "side" | "bow" | "stern"; side: number; deckHalfWidth: number };
    function availableDiveExit(): DiveExit | null {
      if (!sessionStarted || !onBoat || descentActive) return null;
      camera.getWorldDirection(beamDir);
      beamDir.y = 0;
      if (beamDir.lengthSq() < .001) return null;
      beamDir.normalize();
      const localX = camera.position.x - BOAT_X;
      const localZ = camera.position.z - BOAT_Z;
      const stationT = THREE.MathUtils.clamp((WORKBOAT.length * .5 - localZ) / WORKBOAT.length, 0, 1);
      const deckHalfWidth = localZ > 4.15
        ? 1.02
        : Math.max(.22, halfBeamAt(stationT) * WORKBOAT.beam * .5 - .24);
      const side = Math.sign(localX || beamDir.x || 1);
      const atSideRail = localZ < 4.18 && Math.abs(localX) >= deckHalfWidth - .24;
      const atBow = localZ <= -3.72;
      const atStern = localZ >= 4.05;
      if (atSideRail && beamDir.x * side > .42) return { kind: "side", side, deckHalfWidth };
      if (atBow && beamDir.z < -.42) return { kind: "bow", side, deckHalfWidth };
      if (atStern && beamDir.z > .42) return { kind: "stern", side, deckHalfWidth };
      return null;
    }
    function triggerJump() {
      if (!sessionStarted || !onBoat || descentActive) return;
      const exit = availableDiveExit();
      if (!exit) return;
      if (exit.kind === "side") camera.position.x = BOAT_X + exit.side * (exit.deckHalfWidth + .42);
      else camera.position.z = BOAT_Z + (exit.kind === "stern" ? 5.48 : -4.36);
      ensureAudio();
      onBoat = false;
      setCanDive(false);
      descentActive = true;
      enteredWater = false;
      velocity.copy(beamDir).multiplyScalar(2.9);
      velocity.y = 1.15;
      setDivePhase("entry");
    }
    function playCameraTransition() {
      setCameraTransitionKey((current) => current + 1);
    }
    function showCameraHint() {
      // Repeated E presses leave the existing DOM node mounted and only renew
      // its deadline, so the text never blinks or replays its entrance.
      setCameraHintVisible(true);
      if (cameraHintTimeout !== null) window.clearTimeout(cameraHintTimeout);
      cameraHintTimeout = window.setTimeout(() => {
        setCameraHintVisible(false);
        cameraHintTimeout = null;
      }, 1100);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (["Space", "ShiftLeft", "ShiftRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
        event.preventDefault();
      }
      if (event.code === "Escape" && !event.repeat && sessionStarted) {
        event.preventDefault();
        if (paused) {
          ensureAudio();
          requestInputLock();
        } else {
          // Release through the API while this key event is still being
          // dispatched. If Chrome performs its own default Escape unlock, it
          // deliberately blocks immediate re-lock attempts and Continue /
          // Restart can appear to need a random number of clicks. A self-
          // initiated release has no such lockout, so the next Escape or
          // button gesture can restore mouse-look on its first attempt.
          setPauseState(true);
          if (document.pointerLockElement === inputSurface) {
            document.exitPointerLock?.();
          }
        }
        return;
      }
      keys.add(event.code);
      if (event.code === "Space" && !event.repeat && onBoat) triggerJump();
      if (event.code === "KeyL" && !event.repeat && (running || onBoat)) {
        mainLampOn = !mainLampOn;
        setLampOn(mainLampOn);
        playHeadlampSwitch(mainLampOn);
      }
      if (event.code === "KeyF" && !event.repeat && (running || onBoat)) {
        // Toggle the held rig, not merely electrical power. After burnout the
        // lamp is unpowered but still raised, so F must be able to stow it.
        // Thermal recovery already continues whenever floodlightOn is false.
        const wantsFloodlightRaised = !floodRig.visible;
        setFloodlightPowered(wantsFloodlightRaised, wantsFloodlightRaised ? "manual" : "stow");
        if (wantsFloodlightRaised) {
          if (cameraIsHeld) playCameraTransition();
          cameraIsHeld = false;
          cameraRig.visible = false;
          setCameraHeld(false);
          mapIsHeld = false;
          setMapHeld(false);
          camera.fov = 72;
          camera.updateProjectionMatrix();
        }
      }
      if (event.code === "KeyQ" && !event.repeat && (running || onBoat)) {
        cameraIsHeld = !cameraIsHeld;
        cameraRig.visible = cameraIsHeld;
        setCameraHeld(cameraIsHeld);
        playCameraTransition();
        if (cameraIsHeld) {
          setCameraHintVisible(false);
          if (cameraHintTimeout !== null) {
            window.clearTimeout(cameraHintTimeout);
            cameraHintTimeout = null;
          }
          setFloodlightPowered(false, "stow");
          // Keep held tools mutually exclusive even if the floodlight is off
          // but still visible while thermally locked out.
          floodRig.visible = false;
          sonarVisibleUntil = 0;
          lastSonarBearingStep = null;
          setSonarBearing(null);
          mapIsHeld = false;
          setMapHeld(false);
        }
        camera.fov = cameraIsHeld ? 42 : 72;
        camera.updateProjectionMatrix();
        playInstrumentClick(cameraIsHeld ? 1.36 : .76);
      }
      if (event.code === "KeyM" && !event.repeat && (running || onBoat)) {
        mapIsHeld = !mapIsHeld;
        setMapHeld(mapIsHeld);
        if (mapIsHeld) {
          if (cameraIsHeld) playCameraTransition();
          cameraIsHeld = false;
          cameraRig.visible = false;
          setCameraHeld(false);
          setFloodlightPowered(false, "stow");
          camera.fov = 72;
          camera.updateProjectionMatrix();
        }
        playInstrumentClick(.58);
      }
      if (event.code === "ArrowLeft" && !event.repeat) yaw += .2;
      if (event.code === "ArrowRight" && !event.repeat) yaw -= .2;
      if (event.code === "ArrowUp" && !event.repeat) pitch = Math.min(1.3, pitch + .13);
      if (event.code === "ArrowDown" && !event.repeat) pitch = Math.max(-1.3, pitch - .13);
      if (event.code === "KeyW" && !event.repeat && (running || descentActive)) velocity.addScaledVector(forward, .24);
      if (event.code === "KeyE" && !event.repeat) {
        if (returnAvailable) bankDive();
        else if (!cameraIsHeld && (running || onBoat)) showCameraHint();
        else fireCamera();
      }
      if (event.code === "KeyR" && !event.repeat) dropMarker();
      if (event.code === "KeyG" && !event.repeat) sendSonarPing();
      if (event.code === "KeyX" && !event.repeat) takeEvidence();
      if (event.code === "KeyB" && !event.repeat) triggerAirBoost();
    }
    function onKeyUp(event: KeyboardEvent) { keys.delete(event.code); }
    function onLockChange() {
      const isLocked = document.pointerLockElement === inputSurface;
      setLocked(isLocked);
      setPauseState(!isLocked);
    }
    function onLockError() {
      // Some browsers report a denied recapture only through this event
      // instead of rejecting the requestPointerLock promise. In either case,
      // keep the simulation paused until a later user gesture succeeds.
      setLocked(false);
      setPauseState(true);
    }
    function onCanvasClick() {
      if (sessionStarted) {
        ensureAudio();
        requestInputLock();
      }
    }
    resumeRef.current = () => {
      ensureAudio();
      requestInputLock();
    };
    inputLockRef.current = requestInputLock;

    restartRef.current = () => {
      const restartNow = performance.now();
      last = restartNow;
      sessionStarted = true;
      ensureAudio();
      keys.clear();
      running = false;
      onBoat = true;
      descentActive = false;
      enteredWater = false;
      diveComplete = false;
      fatalTriggered = false;
      returnAvailable = false;

      camera.position.set(BOAT_X, 2.18, BOAT_Z - 2.65);
      camera.rotation.set(0, 0, 0);
      camera.fov = 72;
      camera.updateProjectionMatrix();
      velocity.set(0, 0, 0);
      yaw = 0;
      pitch = -.2;

      airValue = 100;
      breathDebtValue = 0;
      forcedBreathUntil = 0;
      gaspMessageUntil = 0;
      lastBreathEvent = "";
      airGasped = false;
      wasBreathingAtSurface = false;
      surfaceGaspCooldownUntil = 0;
      heartSurgeUntil = 0;
      nextHeartbeat = 0;
      nextBreathAt = restartNow + 650;
      boostCooldownUntil = 0;

      mainLampOn = true;
      setFloodlightPowered(false, "reset");
      floodlightCharge = 1;
      floodlightOverheated = false;
      updateFloodlightChargeDisplay(1, false);
      mapIsHeld = false;
      cameraIsHeld = false;
      if (cameraHintTimeout !== null) {
        window.clearTimeout(cameraHintTimeout);
        cameraHintTimeout = null;
      }
      exposuresLeft = 6;
      markersLeft = 2;
      floodRig.visible = false;
      cameraRig.visible = false;

      carriedEvidence.length = 0;
      photographedEvidence.clear();
      creaturePhotographed = false;
      evidenceRecords.forEach((evidence) => {
        evidence.taken = false;
        evidence.group.visible = true;
      });
      markerPool.forEach((marker) => {
        marker.light.intensity = 0;
        marker.group.position.set(0, -1000, 0);
        marker.group.rotation.set(0, 0, 0);
      });
      droppedMarkers.length = 0;
      nextEvidenceUpdate = 0;
      evidenceEventUntil = 0;
      lastEvidenceEvent = "";
      sonarCooldownUntil = 0;
      sonarVisibleUntil = 0;
      lastSonarBearingStep = null;
      sonarCuriosityUntil = 0;
      lastSonarReadinessStep = 100;
      sonarReadyCuePending = false;
      sonarInterestPoint.set(0, 0, 0);
      landingSiltUntil = 0;
      wasGrounded = false;

      creature.position.copy(creatureStartPosition);
      const modelAuditYaw = monsterModelAudit === "front"
        ? Math.PI
        : monsterModelAudit === "side" || monsterModelAudit === "head"
          ? Math.PI / 2
          : creatureVocalAudit
            ? Math.PI
            : 0;
      creature.rotation.set(0, modelAuditYaw, 0);
      creature.visible = false;
      creatureMaterial.emissive.setHex(0x000000);
      creatureTarget.copy(creatureStartPosition);
      lastKnownPosition.copy(camera.position);
      aggro = creatureAudit ? .9 : 0;
      (Object.keys(aggroInputs) as Array<keyof typeof aggroInputs>).forEach((source) => {
        aggroInputs[source] = 0;
        aggroTotals[source] = 0;
      });
      floodlightTotal = 0;
      droppedLampTotal = 0;
      creatureState = creatureAttackAudit ? "Committed" : "Present";
      stateEnteredAt = restartNow;
      pendingEscalationAt = 0;
      commitBeganAt = creatureAttackAudit ? performance.now() - 42000 : 0;
      nextRoamTargetAt = 0;
      isHidden = false;
      wasHidden = false;
      concealmentFailure = "";
      shyRetreatUntil = 0;
      creatureRestUntil = 0;
      nextCaveVisitAt = Number.POSITIVE_INFINITY;
      headingToCave = false;
      creatureCaveSettleStartedAt = 0;
      creatureCaveDepartureStartedAt = 0;
      creatureCaveSettleStart.copy(creatureStartPosition);
      creatureCaveSettleStartQuaternion.identity();
      creatureCaveRestQuaternion.identity();
      lastShyRetreatAt = Number.NEGATIVE_INFINITY;
      lastProximityRetreatAt = Number.NEGATIVE_INFINITY;
      evasionVariant = null;
      evasionStartedAt = 0;
      evasionUntil = 0;
      evasionHandedness = 1;
      evasionVerticalDirection = -1;
      lastEvasionAt = Number.NEGATIVE_INFINITY;
      evasionSettleStartedAt = 0;
      evasionSettleUntil = 0;
      investigationOrbitPhase = 0;
      committedOrbitPhase = 0;
      creatureStuckSeconds = 0;
      creatureRecoveryUntil = 0;
      creatureRecoveryTarget.copy(creatureStartPosition);
      creatureAttackStartedAt = 0;
      creatureAttackUntil = 0;
      creatureAttackImpactPlayed = false;
      creatureAttackTarget.copy(creatureStartPosition);
      creatureWakeAnimationStartedAt = 0;
      creatureVocalizationStartedAt = 0;
      creatureVocalizationUntil = 0;
      creatureWasResting = false;
      creatureWasLitVisible = false;
      creatureSighted = false;
      centralSightBeganAt = 0;
      lastConfirmedVisibleAt = Number.NEGATIVE_INFINITY;
      creatureWasConfirmedVisible = false;
      sightingGraceUntil = 0;
      silhouettePassScheduledAt = 0;
      silhouettePassStartedAt = 0;
      silhouettePassApproachStarted = false;
      silhouettePassComplete = false;
      silhouettePassObserved = false;
      silhouettePassDurationMs = 7600;
      silhouettePassAttempts = 0;
      silhouetteDirectorResolved = false;
      resetEarlySightingOpportunity();
      investigationMinimumUntil = Number.POSITIVE_INFINITY;
      requiresConfirmedSightingForCommit = rand() < .75;
      flashCuriosityUntil = 0;
      flashBlindValue = 0;
      submersionShockValue = 0;
      flashPeakUntil = 0;
      diveStartedAt = Number.POSITIVE_INFINITY;
      directAuditStartedAt = Number.POSITIVE_INFINITY;
      nextPresentEventAt = Number.POSITIVE_INFINITY;
      nextCreatureCallAt = Number.POSITIVE_INFINITY;
      lastPassiveNeutralCallAt = Number.NEGATIVE_INFINITY;
      scatter.visible = false;
      bubbles.visible = false;
      sedimentMaterial.opacity = 0;

      setStarted(true);
      setLocked(document.pointerLockElement === inputSurface);
      setCanDive(false);
      setAir(100);
      setDepth(0);
      setMapPosition({ x: 50, y: 19 });
      setLampOn(true);
      setFloodOn(false);
      setMapHeld(false);
      setCameraHeld(false);
      setCameraHintVisible(false);
      setBreathHeld(false);
      setBreathEvent("");
      setFatalCause("");
      setFatalDetail("");
      setExposures(6);
      setDropLights(2);
      setDivePhase("onboat");
      setCarryLabels([]);
      setPhotoCount(0);
      setEvidencePrompt("");
      setEvidenceEvent("");
      setBankedValue(0);
      setDiveGrade("F");
      setGoodPhotoCount(0);
      setPhysicalEvidenceCount(0);
      setPhotoPreviews([]);
      setReviewingPhotos(false);
      setPhotoReviewIndex(0);
      setSonarBearing(null);
      setSonarMapPosition(null);
      setSonarReadiness(1);

    };

    startRef.current = () => {
      last = performance.now();
      sessionStarted = true;
      paused = false;
      setPauseOpen(false);
      ensureAudio();
      nextBreathAt = last + 650;
      if (directAudit) {
        directAuditStartedAt = last;
        if (returnAudit && carriedEvidence.length === 0) {
          const carried = evidenceRecords[0];
          carried.taken = true;
          carried.group.visible = false;
          carriedEvidence.push(carried);
          photographedEvidence.add(evidenceRecords[1].id);
          setCarryLabels([carried.label]);
          setPhotoCount(1);
        }
        running = true;
        enteredWater = camera.position.y < -.1;
        scatter.visible = enteredWater;
        diveStartedAt = last - (silhouetteAudit
          ? SILHOUETTE_FAILSAFE_DELAY_MS
          : earlySightingAudit
            ? earlySightingOpportunityStartOffsetMs + 800
            : OPENING_SECLUSION_MS);
        if (silhouetteAudit) {
          creatureState = "Investigating";
          stateEnteredAt = last;
          investigationMinimumUntil = last + 120000;
        }
        nextCaveVisitAt = lakeAudit === "creaturecave" ? last : last + 18000 + rand() * 22000;
        setDivePhase("search");
        nextPresentEventAt = last + (creatureVocalAudit
          ? 900
          : soundAudit
            ? 5200
            : PASSIVE_NEUTRAL_CALL_MIN_INTERVAL_MS
              + rand() * (PASSIVE_NEUTRAL_CALL_MAX_INTERVAL_MS - PASSIVE_NEUTRAL_CALL_MIN_INTERVAL_MS));
      } else {
        running = false;
        onBoat = true;
        descentActive = false;
        enteredWater = false;
        camera.position.set(BOAT_X, 2.18, BOAT_Z - 2.65);
        velocity.set(0, 0, 0);
        yaw = 0;
        pitch = -.2;
        setDivePhase("onboat");
        setCanDive(false);
        nextPresentEventAt = Number.POSITIVE_INFINITY;
      }
      nextCreatureCallAt = last + (monsterModelAudit && creatureVocalAudit ? 650 : 9000);
      requestInputLock();
    };

    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("pointerlockerror", onLockError);
    renderer.domElement.addEventListener("click", onCanvasClick);
    resize();

    function animate(now: number) {
      frame = requestAnimationFrame(animate);
      const dt = Math.min((now - last) / 1000, .05);
      last = now;

      if (paused) {
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.render(postScene, postCamera);
        return;
      }

      const floodlightCanThermallyUpdate = sessionStarted && (running || onBoat || descentActive);
      if (floodlightCanThermallyUpdate) {
        if (floodlightOn) {
          floodlightCharge = Math.max(0, floodlightCharge - dt / FLOODLIGHT_RUNTIME_SECONDS);
          if (floodlightCharge <= 0) setFloodlightPowered(false, "burnout");
        } else if (floodlightCharge < 1) {
          floodlightCharge = Math.min(1, floodlightCharge + dt / FLOODLIGHT_RECHARGE_SECONDS);
          if (floodlightOverheated && floodlightCharge >= 1) {
            floodlightOverheated = false;
            floodRig.visible = false;
          }
        }
        updateFloodlightChargeDisplay(floodlightCharge, floodlightOverheated);
        mount.dataset.floodlightCharge = `${Math.round(floodlightCharge * 100)}`;
        mount.dataset.floodlightOverheated = floodlightOverheated ? "true" : "false";
        mount.dataset.floodlightRaised = floodRig.visible ? "true" : "false";
      }

      const waveTime = now / 1000;
      drownedFlora.update(waveTime);
      creatureNest.update(waveTime);
      camera.getWorldDirection(fishFloodlightDirection);
      fishSystem.update(waveTime, dt, {
        playerPosition: camera.position,
        floodlightOn,
        floodlightDirection: fishFloodlightDirection,
        creaturePosition: creature.position,
      });
      if (lakeAudit === "fish") {
        mount.dataset.fishNearestDistance = fishSystem.debug.nearestPlayerDistance.toFixed(2);
        mount.dataset.fishNearestSpecies = fishSystem.debug.nearestSpecies;
        mount.dataset.fishNearestPosition = fishSystem.debug.nearestPosition.toArray().map((value) => value.toFixed(2)).join(",");
        mount.dataset.fishForwardCandidates = String(fishSystem.debug.forwardCandidateCount);
        mount.dataset.fishFleeingCount = String(fishSystem.debug.fleeingCount);
        mount.dataset.fishLongestFleeRemaining = fishSystem.debug.longestFleeRemaining.toFixed(2);
        mount.dataset.fishMaxTurnCurl = fishSystem.debug.maxTurnCurl.toFixed(3);
        mount.dataset.fishMaxVerticalBend = fishSystem.debug.maxVerticalBend.toFixed(3);
        mount.dataset.fishMaxBurstBlend = fishSystem.debug.maxBurstBlend.toFixed(3);
      }
      for (let index = 0; index < surfacePositions.count; index++) {
        const offset = index * 3;
        const x = surfaceBase[offset];
        const y = surfaceBase[offset + 1];
        const worldZ = -y;
        const waveHeight = Math.sin(x * .18 + waveTime * 1.08) * .2
          + Math.sin(y * .24 - waveTime * .86) * .14
          + Math.sin((x + y) * .075 + waveTime * .51) * .085;
        const boatXMask = 1 - THREE.MathUtils.smoothstep(Math.abs(x - BOAT_X), 2.15, 3.1);
        const boatZMask = 1 - THREE.MathUtils.smoothstep(Math.abs(worldZ - BOAT_Z), 4.85, 6.0);
        const hullMask = boatXMask * boatZMask;
        surfacePositions.setZ(
          index,
          THREE.MathUtils.lerp(waveHeight, -.42, hullMask),
        );
      }
      surfacePositions.needsUpdate = true;
      if (frame % 5 === 0) surfaceGeometry.computeVertexNormals();
      waterTexture.offset.x = (waveTime * .008) % 1;
      waterTexture.offset.y = (-waveTime * .013) % 1;
      waterHighlightTexture.offset.x = (-waveTime * .011) % 1;
      waterHighlightTexture.offset.y = (waveTime * .017) % 1;
      skyMaterial.uniforms.time.value = waveTime;
      skyDome.position.copy(camera.position);

      if (descentActive) {
        if (enteredWater && keys.has("Space")) velocity.y += 2.8 * dt;
        if (enteredWater && (keys.has("ShiftLeft") || keys.has("ShiftRight"))) velocity.y -= 2.8 * dt;
        camera.position.addScaledVector(velocity, dt);
        if (enteredWater) resolvePlayerObstacles(camera.position);
        velocity.y -= (enteredWater ? 1.1 : 4.6) * dt;
        velocity.x *= Math.exp(-dt * (enteredWater ? 1.7 : .18));
        velocity.z *= Math.exp(-dt * (enteredWater ? 1.7 : .18));
        if (!enteredWater && camera.position.y <= -.18) {
          enteredWater = true;
          scatter.visible = true;
          bubbles.visible = false;
          playWaterEntry();
          submersionShockValue = 1;
          velocity.y = -2.35;
          mount.dataset.waterEntry = "complete";
        }
        mount.dataset.cameraPosition = camera.position.toArray().map((value) => value.toFixed(2)).join(",");
        if (enteredWater && camera.position.y <= -.72) {
          descentActive = false;
          running = true;
          diveStartedAt = now;
          nextCaveVisitAt = now + 42000 + rand() * 62000;
          setDivePhase("search");
          nextPresentEventAt = now + PASSIVE_NEUTRAL_CALL_MIN_INTERVAL_MS
            + rand() * (PASSIVE_NEUTRAL_CALL_MAX_INTERVAL_MS - PASSIVE_NEUTRAL_CALL_MIN_INTERVAL_MS);
          nextCreatureCallAt = now + OPENING_SECLUSION_MS + 9000;
        }
      }

      if (!sessionStarted && !directAudit) {
        camera.position.set(BOAT_X - 13.8, .52 + Math.sin(waveTime * .72) * .025, BOAT_Z - 7.4);
        velocity.set(0, 0, 0);
        yaw = -2.063;
        pitch = .035;
      } else if (onBoat && !descentActive) {
        forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        right.set(Math.cos(yaw), 0, -Math.sin(yaw));
        move.set(0, 0, 0);
        if (keys.has("KeyW")) move.add(forward);
        if (keys.has("KeyS")) move.sub(forward);
        if (keys.has("KeyD")) move.add(right);
        if (keys.has("KeyA")) move.sub(right);
        if (move.lengthSq() > 0) move.normalize().multiplyScalar(BOAT_WALK_SPEED);
        velocity.lerp(move, 1 - Math.exp(-dt * 8));
        const previousX = camera.position.x;
        const previousZ = camera.position.z;
        camera.position.addScaledVector(velocity, dt);
        camera.position.z = THREE.MathUtils.clamp(camera.position.z, BOAT_Z - 4.02, BOAT_Z + 5.12);
        const cabinLocalZ = camera.position.z - BOAT_Z;
        const stationT = THREE.MathUtils.clamp((WORKBOAT.length * .5 - cabinLocalZ) / WORKBOAT.length, 0, 1);
        const walkableHalfWidth = cabinLocalZ > 4.15
          ? 1.02
          : Math.max(.22, halfBeamAt(stationT) * WORKBOAT.beam * .5 - .24);
        camera.position.x = THREE.MathUtils.clamp(camera.position.x, BOAT_X - walkableHalfWidth, BOAT_X + walkableHalfWidth);
        const cabinLocalX = camera.position.x - BOAT_X;
        if (Math.abs(cabinLocalX) < 1.34 && cabinLocalZ > .25 && cabinLocalZ < 2.52) {
          const previousLocalZ = previousZ - BOAT_Z;
          const previousLocalX = previousX - BOAT_X;
          const enteredFromSide = Math.abs(previousLocalX) >= 1.34;
          const enteredFromEnd = previousLocalZ <= .25 || previousLocalZ >= 2.52;
          if (enteredFromSide) {
            camera.position.x = previousX;
            velocity.x = 0;
          } else if (enteredFromEnd) {
            camera.position.z = previousZ;
            velocity.z = 0;
          } else {
            const xDistance = 1.34 - Math.abs(cabinLocalX);
            const frontDistance = cabinLocalZ - .25;
            const backDistance = 2.52 - cabinLocalZ;
            if (xDistance <= Math.min(frontDistance, backDistance)) {
              camera.position.x = BOAT_X + Math.sign(cabinLocalX || previousLocalX || 1) * 1.34;
              velocity.x = 0;
            } else {
              camera.position.z = BOAT_Z + (frontDistance < backDistance ? .25 : 2.52);
              velocity.z = 0;
            }
          }
        }
        camera.position.y = 2.18 + Math.sin(now * .0014) * .025;
        const diveAvailable = availableDiveExit() !== null;
        if (diveAvailable !== lastCanDive) {
          lastCanDive = diveAvailable;
          setCanDive(diveAvailable);
        }
      } else if (lastCanDive) {
        lastCanDive = false;
        setCanDive(false);
      }

      const waterDepth = Math.max(0, -camera.position.y);
      waterColor.copy(shallowWater).lerp(thermoWater, THREE.MathUtils.smoothstep(waterDepth, 3.5, 12));
      waterColor.lerp(deepWater, THREE.MathUtils.smoothstep(waterDepth, 12, 34));
      const depth01 = THREE.MathUtils.clamp((-camera.position.y - 1) / 25, 0, 1);
      // Keep the air/water transition tight. The former half-metre blend made
      // surface views partially transparent and briefly exposed the whole lake.
      const surfaceBlend = THREE.MathUtils.smoothstep(camera.position.y, -.04, .14);
      skyMaterial.uniforms.visibility.value = surfaceBlend;
      scatter.visible = enteredWater && surfaceBlend < .9;
      // V9 removes the camera-attached stream that always rose regardless of
      // the diver's motion. Static motes remain for motion/depth orientation.
      bubbles.visible = false;
      const underwaterFogDensity = THREE.MathUtils.lerp(.042, .082, depth01) + submersionShockValue * .11;
      // The floodlight still earns a forward view in the black zone, but keeps
      // enough water haze that distant geometry cannot become broadly legible.
      const floodFogPenetration = enteredWater && sessionStarted && floodlightOn
        ? THREE.MathUtils.lerp(.80, .68, depth01)
        : 1;
      atmosphereColor.copy(waterColor).lerp(stormWater, surfaceBlend);
      scene.background = atmosphereColor;
      (scene.fog as THREE.FogExp2).color.copy(atmosphereColor);
      (scene.fog as THREE.FogExp2).density = THREE.MathUtils.lerp(underwaterFogDensity * floodFogPenetration, .064, surfaceBlend);
      postMaterial.uniforms.surfaceFog.value = surfaceBlend;
      (postMaterial.uniforms.surfaceFogColor.value as THREE.Color).copy(stormWater).lerp(surfaceFogTint, .34);
      // Underwater visibility should be earned by a beam, not by global fill.
      const lightsOut = enteredWater && !mainLampOn && !floodlightOn;
      const underwaterFill = THREE.MathUtils.lerp(.22, .025, depth01) * (lightsOut ? .32 : 1);
      hemi.intensity = THREE.MathUtils.lerp(underwaterFill, 1.05, surfaceBlend);
      daylight.intensity = THREE.MathUtils.lerp(0, 2.35, surfaceBlend);
      const underwaterExposure = THREE.MathUtils.lerp(.9, .66, depth01) * (lightsOut ? .82 : 1);
      const targetExposure = THREE.MathUtils.lerp(underwaterExposure, 1.08, surfaceBlend);
      renderer.toneMappingExposure = THREE.MathUtils.lerp(renderer.toneMappingExposure, targetExposure, 1 - Math.exp(-dt * 1.3));
      const surfaceVisibility = 1 - THREE.MathUtils.smoothstep(-camera.position.y, 2.2, 7.2);
      surfaceMaterial.opacity = surfaceBlend > .12
        ? 1
        : THREE.MathUtils.lerp(.52 * surfaceVisibility, .88, surfaceBlend / .12);
      surfaceMaterial.depthWrite = true;
      waterDetailMaterial.opacity = THREE.MathUtils.lerp(.08 * surfaceVisibility, .25, surfaceBlend);
      const shaftStrength = (1 - THREE.MathUtils.smoothstep(-camera.position.y, 1.8, 5.8)) * (1 - surfaceBlend);
      shaftMaterials.forEach((material, index) => {
        material.opacity = (shaftBaseOpacities[index] ?? .018) * shaftStrength;
      });

      let isHoldingBreath = false;
      if (running) {
        const breathingAtSurface = camera.position.y > .025;
        isHoldingBreath = !breathingAtSurface && (keys.has("KeyC") || auditHold) && now > forcedBreathUntil && airValue > 0;
        if (breathingAtSurface) {
          if (!wasBreathingAtSurface && enteredWater && airValue < 99.5 && now >= surfaceGaspCooldownUntil) {
            playSurfaceGasp();
            surfaceGaspCooldownUntil = now + 4500;
            nextBreathAt = now + 1700;
          }
          airValue = Math.min(100, airValue + dt * 18);
          breathDebtValue = Math.max(0, breathDebtValue - dt * .48);
          airGasped = false;
        } else if (isHoldingBreath) {
          breathDebtValue = Math.min(1, breathDebtValue + dt * .108);
          airValue -= dt * .11;
        } else {
          airValue -= dt * (.3 + breathDebtValue * .92);
          breathDebtValue = Math.max(0, breathDebtValue - dt * .115);
        }
        wasBreathingAtSurface = breathingAtSurface;

        if (isHoldingBreath && breathDebtValue >= .995) {
          playGasp();
          forcedBreathUntil = now + 2600;
          gaspMessageUntil = now + 1150;
          breathDebtValue = .92;
          airValue -= 2.8;
          isHoldingBreath = false;
        }

        airValue = Math.max(0, airValue);
        if (airValue <= 0 && !airGasped) {
          playGasp();
          airGasped = true;
          breathDebtValue = 1;
          running = false;
          fatalTriggered = true;
          setAir(0);
          setBreathHeld(false);
          setFatalCause("OUT OF AIR");
          setFatalDetail(`Your tank ran dry.${unbankedLossText()}`);
        }

        const eventText = now < gaspMessageUntil
          ? "INVOLUNTARY GASP"
          : now < forcedBreathUntil
            ? "RECOVERING — AIR LOSS"
            : "";
        if (eventText !== lastBreathEvent) {
          lastBreathEvent = eventText;
          setBreathEvent(eventText);
        }

        const fearHeartbeat = now < heartSurgeUntil;
        if ((breathDebtValue > .14 || fearHeartbeat) && now > nextHeartbeat) {
          playHeartbeat(fearHeartbeat ? 1 : breathDebtValue);
          nextHeartbeat = now + (fearHeartbeat ? 365 : THREE.MathUtils.lerp(1450, 430, breathDebtValue));
        }

        if (now > nextHudUpdate) {
          setAir(airValue);
          setDepth(Math.max(0, -camera.position.y));
          setMapPosition({
            x: THREE.MathUtils.clamp(((camera.position.x + WORLD_LIMIT) / (WORLD_LIMIT * 2)) * 100, 2, 98),
            y: THREE.MathUtils.clamp(((WORLD_LIMIT - camera.position.z) / (WORLD_LIMIT * 2)) * 100, 2, 98),
          });
          setBreathHeld(isHoldingBreath);
          nextHudUpdate = now + 140;
        }
      }

      if ((running || descentActive) && !isHoldingBreath && now > nextBreathAt) {
        playBreath(breathDebtValue);
        nextBreathAt = now + THREE.MathUtils.lerp(4100, 1150, breathDebtValue);
      }

      if (audioContext && waterFilter && waterBus) {
        const waterNow = audioContext.currentTime;
        if (introBus) {
          const introLevel = !sessionStarted ? .24 : .0001;
          introBus.gain.setTargetAtTime(introLevel, waterNow, onBoat ? .8 : 1.8);
        }
        waterFilter.frequency.setTargetAtTime(THREE.MathUtils.lerp(720, 105, depth01), waterNow, .8);
        waterFilter.Q.setTargetAtTime(THREE.MathUtils.lerp(.8, 3.6, depth01), waterNow, .9);
        const waterLevel = !sessionStarted
          ? .012
          : THREE.MathUtils.lerp(.16, .26, depth01);
        waterBus.gain.setTargetAtTime(waterLevel, waterNow, .52);
        if (soundAudit) mount.dataset.waterBed = "active";

        const passiveRoaming = creatureState === "Present"
          && aggro < .14
          && !headingToCave
          && now >= creatureRestUntil
          && !silhouettePassApproachStarted
          && silhouettePassStartedAt === 0;
        if (running
          && passiveRoaming
          && nextPresentEventAt > 0
          && now >= nextPresentEventAt
          && now - lastPassiveNeutralCallAt >= PASSIVE_NEUTRAL_CALL_MIN_INTERVAL_MS) {
          playCreatureCall("curious", callTierForDistance(creature.position.distanceTo(camera.position)));
          lastPassiveNeutralCallAt = now;
          nextPresentEventAt = now + (soundAudit
            ? PASSIVE_NEUTRAL_CALL_MIN_INTERVAL_MS
            : PASSIVE_NEUTRAL_CALL_MIN_INTERVAL_MS
              + rand() * (PASSIVE_NEUTRAL_CALL_MAX_INTERVAL_MS - PASSIVE_NEUTRAL_CALL_MIN_INTERVAL_MS));
          if (soundAudit) mount.dataset.passiveNeutralCall = "played-while-roaming";
        }
        if (running && creatureState !== "Present" && now > nextCreatureCallAt) {
          playCreatureCall(
            "hunting",
            callTierForDistance(creature.position.distanceTo(camera.position)),
          );
          nextCreatureCallAt = now + (creatureState === "Investigating" ? 8500 + rand() * 4800 : 4200 + rand() * 2800);
        }
      }
      postMaterial.uniforms.breathDebt.value = breathDebtValue;
      if (now >= flashPeakUntil) flashBlindValue = Math.max(0, flashBlindValue - dt * 1.55);
      postMaterial.uniforms.flashBlind.value = flashBlindValue;
      submersionShockValue = Math.max(0, submersionShockValue - dt * .68);
      postMaterial.uniforms.submersionShock.value = submersionShockValue;
      flashLight.intensity = now < flashPeakUntil ? 520 : 0;
      if (sonarVisibleUntil > now) {
        updateSonarBearing();
      } else if (sonarVisibleUntil > 0) {
        sonarVisibleUntil = 0;
        lastSonarBearingStep = null;
        setSonarBearing(null);
      }
      if (sonarCooldownUntil > 0) {
        const sonarProgress = THREE.MathUtils.clamp(1 - (sonarCooldownUntil - now) / SONAR_COOLDOWN_MS, 0, 1);
        const sonarStep = Math.round(sonarProgress * 100);
        if (sonarStep !== lastSonarReadinessStep) {
          lastSonarReadinessStep = sonarStep;
          setSonarReadiness(sonarStep / 100);
        }
        if (sonarProgress >= 1) {
          sonarCooldownUntil = 0;
          if (sonarReadyCuePending) playSonarReadyCue();
          sonarReadyCuePending = false;
        }
      }
      if (instrumentsAudit && flashBlindValue > 0 && now >= flashPeakUntil) {
        mount.dataset.flashBlind = flashBlindValue > .36 ? "afterimage" : "clearing";
      }

      const submergedSway = running ? 1 : 0;
      camera.rotation.set(
        pitch + Math.sin(now * .00043) * .008 * submergedSway,
        yaw + Math.sin(now * .00031) * .006 * submergedSway,
        Math.sin(now * .00037) * .011 * submergedSway,
      );
      const floorY = terrainHeight(camera.position.x, camera.position.z);
      const grounded = camera.position.y <= floorY + 1.85;

      if (running) {
        camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        right.crossVectors(forward, WORLD_UP).normalize();
        move.set(0, 0, 0);
        if (keys.has("KeyW")) move.add(forward);
        if (keys.has("KeyS")) move.sub(forward);
        if (keys.has("KeyD")) move.add(right);
        if (keys.has("KeyA")) move.sub(right);
        const rising = keys.has("Space");
        const descending = keys.has("ShiftLeft") || keys.has("ShiftRight");
        const verticalInput = rising || descending;
        const verticalTarget = rising === descending ? 0 : rising ? 3.2 : -2.65;
        if (move.lengthSq() > 0) move.normalize();
        const horizontalSpeed = grounded && verticalTarget <= 0 ? 1.7 : FREE_SWIM_SPEED;
        move.multiplyScalar(horizontalSpeed);
        // Buoyancy controls are independent of WASD normalization. Holding
        // Space therefore produces the same decisive ascent while moving
        // forward and immediately reverses an earlier descent.
        move.y = verticalTarget;
        const swimResponse = verticalInput ? 4.8 : 3.2;
        velocity.lerp(move, 1 - Math.exp(-dt * swimResponse));
        const surfaceBobHeight = .19 + Math.sin(now * .00155) * .065 + Math.sin(now * .00067) * .035;
        const atWaterline = camera.position.y > -.46;
        if (!verticalInput && atWaterline && now >= boostCooldownUntil) {
          velocity.y = THREE.MathUtils.lerp(
            velocity.y,
            (surfaceBobHeight - camera.position.y) * 2.35,
            1 - Math.exp(-dt * 2.8),
          );
        } else if (!verticalInput && !grounded && now >= boostCooldownUntil) {
          velocity.y = THREE.MathUtils.lerp(velocity.y, -.88, 1 - Math.exp(-dt * 1.35));
        }
        camera.position.addScaledVector(velocity, dt);
        keepInsideLake(camera.position, 108);
        resolvePlayerObstacles(camera.position);
        const nextFloor = terrainHeight(camera.position.x, camera.position.z);
        if (camera.position.y < nextFloor + 1.62) {
          camera.position.y = nextFloor + 1.62;
          velocity.y = Math.max(0, velocity.y);
        }
        camera.position.y = Math.min(surfaceBobHeight + (rising ? .18 : .08), camera.position.y);
        mount.dataset.cameraPosition = camera.position.toArray().map((value) => value.toFixed(2)).join(",");
      } else if (!descentActive) {
        velocity.multiplyScalar(.92);
      }
      if (grounded && !wasGrounded && running) landingSiltUntil = now + 2200;
      wasGrounded = grounded;

      if (running && now > nextEvidenceUpdate) {
        const sample = evidenceInView(3.25, .58, false, true);
        const boatDistance = Math.hypot(camera.position.x - BOAT_X, camera.position.z - BOAT_Z);
        returnAvailable = boatDistance < 4.6 && camera.position.y > -1.45;
        const prompt = returnAvailable
          ? "E CLIMB ABOARD — END DIVE"
          : sample ? `X TAKE — ${sample.label} · VALUE ${sample.value}` : "";
        setEvidencePrompt(prompt);
        if (evidenceAudit || nestAudit) mount.dataset.evidenceTarget = sample?.id ?? "none";
        nextEvidenceUpdate = now + 180;
      }
      if (lastEvidenceEvent && now > evidenceEventUntil) {
        lastEvidenceEvent = "";
        setEvidenceEvent("");
      }

      if (running) {
      coverDirection.subVectors(camera.position, creature.position);
      const creatureDistance = coverDirection.length();
      cameraToCreature.copy(coverDirection).negate().normalize();
      const diveElapsedMs = now - diveStartedAt;
      const openingSeclusionActive = !creatureAudit && diveElapsedMs < OPENING_SECLUSION_MS;
      const openingHardSeclusionActive = !creatureAudit && diveElapsedMs < OPENING_HARD_SECLUSION_MS;
      const earlyDistantOpportunityActive = openingSeclusionActive
        && !openingHardSeclusionActive
        && earlySightingOpportunityEnabled
        && diveElapsedMs >= earlySightingOpportunityStartOffsetMs
        && diveElapsedMs <= earlySightingOpportunityEndOffsetMs;
      const earlyDistantOpportunityExitActive = openingSeclusionActive
        && earlySightingOpportunityEnabled
        && diveElapsedMs > earlySightingOpportunityEndOffsetMs
        && diveElapsedMs <= earlySightingOpportunityEndOffsetMs + EARLY_SIGHTING_EXIT_MS;
      const creatureResting = !creatureAudit && now < creatureRestUntil;
      const silhouettePassing = silhouettePassStartedAt > 0
        && now - silhouettePassStartedAt < silhouettePassDurationMs;
      // The animal remains physically present while sleeping so a reckless
      // diver can illuminate, ping, or photograph it inside the cave.
      // The first 45 seconds stay absolute. A small minority of dives then get
      // one distant, non-confirming glimpse window before ordinary play begins.
      creature.visible = (!openingSeclusionActive || earlyDistantOpportunityActive || earlyDistantOpportunityExitActive)
        && !evidenceModelAudit;
      if (earlyDistantOpportunityActive) creatureMaterial.emissive.setHex(0x020402);
      else if (earlyDistantOpportunityExitActive) creatureMaterial.emissive.setHex(0x010201);
      else if (!silhouettePassing) creatureMaterial.emissive.setHex(0x000000);
      if (earlySightingAudit) {
        mount.dataset.openingVisibility = openingHardSeclusionActive
          ? "hard-seclusion"
          : earlyDistantOpportunityActive
            ? "distant-opportunity"
            : earlyDistantOpportunityExitActive
              ? "distant-exit"
            : openingSeclusionActive
              ? "hidden-window"
              : "normal";
        mount.dataset.earlySightingDistance = creatureDistance.toFixed(1);
      }
      if (creatureAudit || lakeAudit === "creaturecave") {
        mount.dataset.creatureState = creatureState;
        mount.dataset.creatureDistance = creatureDistance.toFixed(1);
        mount.dataset.creatureAggro = aggro.toFixed(2);
        const bearing = Math.atan2(
          forward.z * cameraToCreature.x - forward.x * cameraToCreature.z,
          forward.x * cameraToCreature.x + forward.z * cameraToCreature.z,
        );
        mount.dataset.creatureBearing = THREE.MathUtils.radToDeg(bearing).toFixed(0);
      }
      const inCurtainCover = drownedFlora.curtainBeds.some((bed) => {
        const distance = Math.hypot(camera.position.x - bed.x, camera.position.z - bed.z);
        const bedFloor = terrainHeight(bed.x, bed.z);
        return distance < bed.radius && camera.position.y < bedFloor + bed.height + .72;
      });
      isHidden = inCurtainCover || (!floodlightOn && velocity.length() < .13 && (!mainLampOn || creatureDistance > 24));
      head.getWorldPosition(creatureHeadWorld);
      projectedCreature.copy(creatureHeadWorld).project(camera);
      contactDirection.subVectors(creatureHeadWorld, camera.position);
      const creatureSightDistance = contactDirection.length();
      contactDirection.normalize();
      sightRay.set(camera.position, contactDirection);
      sightRay.far = Math.max(0, creatureSightDistance - .7);
      const creatureOccluded = sightRay.intersectObjects(coverMeshes, false).length > 0;
      const centralSightEligible = !openingSeclusionActive
        && creature.visible
        && creatureSightDistance < (silhouettePassing ? 34 : creatureState === "Investigating" ? 29 : 18)
        && Math.abs(projectedCreature.x) < .19
        && Math.abs(projectedCreature.y) < .21
        && projectedCreature.z > -1 && projectedCreature.z < 1
        && !creatureOccluded
        && (silhouettePassing || mainLampOn || floodlightOn);
      if (centralSightEligible) {
        if (centralSightBeganAt === 0) centralSightBeganAt = now;
      } else {
        centralSightBeganAt = 0;
      }
      const creatureInSight = centralSightEligible && now - centralSightBeganAt >= 480;
      const creatureLitVisible = !openingSeclusionActive
        && creature.visible
        && creatureSighted
        && creatureSightDistance < 32
        && Math.abs(projectedCreature.x) < .58
        && Math.abs(projectedCreature.y) < .5
        && projectedCreature.z > -1 && projectedCreature.z < 1
        && !creatureOccluded
        && (mainLampOn || floodlightOn);
      if (creatureInSight) {
        if (silhouettePassing) {
          silhouettePassObserved = true;
        } else if (silhouettePassStartedAt === 0 && !silhouetteDirectorResolved) {
          // A naturally earned sighting supersedes the fallback encounter,
          // including an animal that becomes visible while approaching its mark.
          silhouettePassScheduledAt = 0;
          silhouettePassApproachStarted = false;
          silhouetteDirectorResolved = true;
        }
        const suddenReentry = !creatureWasConfirmedVisible && now - lastConfirmedVisibleAt > 1800;
        if (!creatureSighted) {
          creatureSighted = true;
          sightingGraceUntil = now + 15000;
          playGasp();
          playFirstSightingSting();
          breathDebtValue = Math.max(breathDebtValue, .34);
          heartSurgeUntil = now + 6800;
          nextBreathAt = now + 700;
        } else if (suddenReentry) {
          heartSurgeUntil = Math.max(heartSurgeUntil, now + 4200);
        }
        if (!creatureWasConfirmedVisible && creatureState !== "Committed" && now - lastShyRetreatAt > 3500) {
          lastShyRetreatAt = now;
          // At the 7.8 m/s cruise pace the old 42 m target was reached in
          // roughly five seconds, leaving the animal parked for most of its
          // retreat window. Keep the route long enough for the full action.
          scheduleShyRetreat(now, 13500, 88, floodlightOn ? "seen-retreat-flood" : "seen-retreat");
          if (mainLampOn && !floodlightOn) aggro = Math.max(0, aggro - .14);
        }
        lastConfirmedVisibleAt = now;
      }
      if ((creatureInSight || creatureLitVisible)
        && !creatureWasLitVisible
        && creatureState !== "Committed"
        && !creatureResting
        && lakeAudit !== "creaturecave"
        && !silhouettePassing
        && now - lastEvasionAt > 6500) {
        beginCreatureEvasion(now);
      }
      creatureWasConfirmedVisible = creatureInSight;
      creatureWasLitVisible = creatureInSight || creatureLitVisible;
      if (soundAudit || creatureAudit) {
        mount.dataset.creatureSighted = String(creatureSighted);
        mount.dataset.sightingFocus = centralSightEligible ? (creatureInSight ? "confirmed" : "dwelling") : "outside";
      }
      if (creatureAudit) mount.dataset.creatureHidden = String(isHidden);
      if (isHidden) {
        wasHidden = true;
      } else if (wasHidden) {
        if (floodlightOn) concealmentFailure = "Raising the floodlight exposed you.";
        else if (mainLampOn) concealmentFailure = "Turning the lamp on exposed you.";
        else if (velocity.length() >= .12) concealmentFailure = "Movement exposed you.";
      }

      if (creatureResting && floodlightOn && creatureDistance < 28) {
        wakeCreatureIntoCommitted(now, "floodlight");
      }

      const creatureCloseEnoughToNotice = creatureDistance < 52;
      const diverLampSignal = 0;
      const floodlightSignal = creatureCloseEnoughToNotice && floodlightOn
        ? dt * (creatureInSight ? .032 : .016)
        : 0;
      const droppedLampSignal = creatureDistance < 34 && droppedMarkers.length > 0 ? dt * .006 : 0;
      aggroInputs.mainLamp = droppedLampSignal;
      aggroInputs.floodLight = floodlightSignal;
      aggroInputs.disturbingSediment = creatureDistance < 38 && grounded && velocity.length() > .38 ? dt * .012 : 0;
      const signal = aggroInputs.mainLamp
        + aggroInputs.floodLight
        + aggroInputs.cameraFlash
        + aggroInputs.disturbingSediment
        + aggroInputs.nearNestTheft;
      if (!openingSeclusionActive
        && lakeAudit !== "creaturecave"
        && creatureDistance < 18
        && (creatureState !== "Committed" || now - commitBeganAt < 24000)
        && now - lastProximityRetreatAt > 1800) {
        lastProximityRetreatAt = now;
        scheduleShyRetreat(now, 10000, 68, "proximity-retreat");
        if (creatureState !== "Committed") aggro = Math.max(0, aggro - .08);
      }

      const graceActive = now - diveStartedAt < OPENING_SECLUSION_MS;
      const closeLampBlocksDecay = creatureDistance < 24 && (mainLampOn || floodlightOn);
      const decay = signal === 0 && !closeLampBlocksDecay ? dt * (isHidden ? .05 : .018) : 0;
      aggro = THREE.MathUtils.clamp(
        aggro + signal - decay,
        0,
        graceActive ? .54 : 1,
      );
      floodlightTotal += floodlightSignal;
      droppedLampTotal += droppedLampSignal;
      (Object.keys(aggroInputs) as Array<keyof typeof aggroInputs>).forEach((source) => {
        aggroTotals[source] += aggroInputs[source];
      });
      const disturbanceVariety = [
        aggroTotals.mainLamp > .025,
        aggroTotals.floodLight > .09,
        aggroTotals.cameraFlash > .055,
        aggroTotals.disturbingSediment > .045,
        aggroTotals.nearNestTheft > .2,
      ].filter(Boolean).length;
      const severeProvocation = aggroTotals.nearNestTheft > .31
        || aggroTotals.cameraFlash > .2
        || aggroTotals.floodLight > .42;
      if (droppedLampSignal > 0 && diverLampSignal === 0 && floodlightSignal === 0 && aggroInputs.cameraFlash === 0) {
        lastKnownPosition.copy(droppedMarkers[droppedMarkers.length - 1].position);
        if (instrumentsAudit) mount.dataset.aggroTarget = "dropped-light";
      } else if (signal > 0 && !isHidden) {
        lastKnownPosition.copy(camera.position);
        if (instrumentsAudit) mount.dataset.aggroTarget = "diver";
      }

      const threshold = creatureState === "Present" ? .86 : .96;
      const visibilityGateSatisfied = requiresConfirmedSightingForCommit
        ? creatureSighted
        : true;
      const commitAllowed = visibilityGateSatisfied
        && now > sightingGraceUntil
        && now >= investigationMinimumUntil;
      const presentCanEscalate = disturbanceVariety >= 2 || severeProvocation;
      if (!graceActive
        && creatureState !== "Committed"
        && aggro >= threshold
        && (creatureState === "Present" ? presentCanEscalate : commitAllowed)) {
        if (pendingEscalationAt === 0) pendingEscalationAt = now;
        if (now - pendingEscalationAt >= (creatureState === "Present" ? 12000 : 9000)) {
          creatureState = creatureState === "Present" ? "Investigating" : "Committed";
          stateEnteredAt = now;
          pendingEscalationAt = 0;
          if (creatureState === "Investigating") {
            const intenseMultiActionDisturbance = disturbanceVariety >= 4 && aggro >= .96;
            investigationMinimumUntil = now + (intenseMultiActionDisturbance
              ? 55000 + rand() * 30000
              : 150000 + rand() * 60000);
            playCreatureClip("aggro-engaged", callTierForDistance(creatureDistance), 1.05);
            nextCreatureCallAt = now + 10500;
          } else {
            playCreatureCall("hunting", callTierForDistance(creatureDistance));
            nextCreatureCallAt = now + 6500;
            commitBeganAt = now;
          }
        }
      } else if (creatureState !== "Committed") {
        pendingEscalationAt = 0;
      }

      if (creatureState === "Committed" && aggro < .48 && now - stateEnteredAt > 9000) {
        creatureState = "Investigating";
        stateEnteredAt = now;
        investigationMinimumUntil = now + 90000 + rand() * 45000;
        playCreatureClip("aggro-engaged", callTierForDistance(creatureDistance), 1.05);
        nextCreatureCallAt = now + 8500;
      } else if (creatureState === "Investigating" && aggro < .14 && now - stateEnteredAt > 65000) {
        creatureState = "Present";
        stateEnteredAt = now;
        investigationMinimumUntil = Number.POSITIVE_INFINITY;
        nextPresentEventAt = Math.max(nextPresentEventAt, now + PASSIVE_NEUTRAL_CALL_MIN_INTERVAL_MS);
      }

      if (creatureState === "Investigating"
        && !creatureSighted
        && !silhouetteDirectorResolved
        && !silhouettePassComplete
        && silhouettePassAttempts < SILHOUETTE_MAX_ATTEMPTS
        && silhouettePassScheduledAt === 0
        && !silhouettePassApproachStarted
        && silhouettePassStartedAt === 0) {
        // This is a late failsafe for a player who has not seen the animal
        // naturally, not a mandatory beat attached to every investigation.
        silhouettePassScheduledAt = silhouetteAudit
          ? now + 450
          : Math.max(
              now + 18000 + rand() * 24000,
              diveStartedAt + SILHOUETTE_FAILSAFE_DELAY_MS,
            );
      }
      if (creatureState === "Investigating"
        && !creatureSighted
        && !silhouetteDirectorResolved
        && silhouettePassScheduledAt > 0
        && !silhouettePassApproachStarted
        && now >= silhouettePassScheduledAt) {
        if (tryBuildSilhouettePass()) {
          silhouettePassScheduledAt = 0;
          silhouettePassApproachStarted = true;
          if (silhouetteAudit) {
            creature.position.copy(passStart);
            creatureTarget.copy(passStart);
            silhouettePassStartedAt = now;
          }
        } else {
          silhouettePassScheduledAt = now + SILHOUETTE_RETRY_MIN_MS
            + rand() * (SILHOUETTE_RETRY_MAX_MS - SILHOUETTE_RETRY_MIN_MS);
          if (creatureAudit || silhouetteAudit) mount.dataset.silhouettePath = "retry-no-clear-route";
        }
      }
      // The opt-in creature audit should exercise an evasion on every fresh
      // run instead of depending on a random roam path crossing the reticle.
      // Normal play still begins evasion exclusively from real visibility.
      if (creatureAudit
        && !creatureAttackAudit
        && evasionVariant === null
        && lastEvasionAt === Number.NEGATIVE_INFINITY
        && now - diveStartedAt > 5200) {
        beginCreatureEvasion(now);
      }
      const creatureAuditInspectionHold = creatureVocalAudit
        || Boolean(monsterModelAudit)
        || (creatureAudit && now - directAuditStartedAt < 5000);
      const activeSilhouettePass = !creatureVocalAudit
        && silhouettePassStartedAt > 0
        && now - silhouettePassStartedAt < silhouettePassDurationMs;
      if (evasionVariant && now >= evasionUntil) {
        evasionSettleStartedAt = now;
        evasionSettleUntil = now + 1100;
        evasionSettleTarget.copy(creature.position).addScaledVector(evasionExitDirection, 22);
        evasionSettleTarget.y = THREE.MathUtils.clamp(
          evasionSettleTarget.y,
          terrainHeight(evasionSettleTarget.x, evasionSettleTarget.z) + 5.2,
          -3.8,
        );
        keepCreaturePointClear(evasionSettleTarget, 7);
        evasionVariant = null;
        nextRoamTargetAt = 0;
        if (creatureAudit) mount.dataset.creatureEvasion = "complete";
      }
      const activeEvasion = evasionVariant !== null && now < evasionUntil;
      const evasionProgress = activeEvasion
        ? THREE.MathUtils.clamp((now - evasionStartedAt) / Math.max(1, evasionUntil - evasionStartedAt), 0, 1)
        : 0;
      const evasionSettleProgress = now < evasionSettleUntil
        ? THREE.MathUtils.clamp((now - evasionSettleStartedAt) / Math.max(1, evasionSettleUntil - evasionSettleStartedAt), 0, 1)
        : 1;
      const attackMotionProgress = creatureAttackStartedAt > 0
        ? THREE.MathUtils.clamp((now - creatureAttackStartedAt) / Math.max(1, creatureAttackUntil - creatureAttackStartedAt), 0, 1)
        : 0;
      if (creatureCaveSettleStartedAt > 0
        && now - creatureCaveSettleStartedAt >= CREATURE_CAVE_SETTLE_MS) {
        creature.position.copy(creatureCavePosition);
        creature.quaternion.copy(creatureCaveRestQuaternion);
        creatureCaveSettleStartedAt = 0;
        creatureRestUntil = now + (lakeAudit === "creaturecave"
          ? auditHold ? 30000 : 5200
          : 15000 + rand() * 30000);
        nextCaveVisitAt = creatureRestUntil + 70000 + rand() * 110000;
        creatureStuckSeconds = 0;
        if (creatureAudit || lakeAudit === "creaturecave") mount.dataset.creatureCavePhase = "napping";
      }
      if (creatureWasResting && !creatureResting && creatureCaveDepartureStartedAt === 0) {
        beginCreatureCaveDeparture(now);
      }
      const caveSettleProgress = creatureCaveSettleStartedAt > 0
        ? THREE.MathUtils.clamp((now - creatureCaveSettleStartedAt) / CREATURE_CAVE_SETTLE_MS, 0, 1)
        : 0;
      let caveDepartureProgress = creatureCaveDepartureStartedAt > 0
        ? THREE.MathUtils.clamp((now - creatureCaveDepartureStartedAt) / CREATURE_CAVE_DEPARTURE_MS, 0, 1)
        : 1;
      if (creatureCaveDepartureStartedAt > 0 && caveDepartureProgress >= 1) {
        creatureCaveDepartureStartedAt = 0;
        caveDepartureProgress = 1;
        nextRoamTargetAt = 0;
        if (creatureAudit || lakeAudit === "creaturecave") mount.dataset.creatureCavePhase = "cruising";
      }
      const activeCaveSettle = creatureCaveSettleStartedAt > 0;
      const activeCaveDeparture = creatureCaveDepartureStartedAt > 0;
      let creatureSpeed = CREATURE_CRUISE_SPEED;
      let desiredDistance = 0;
      let directCreatureMotion = false;
      creatureFrameStart.copy(creature.position);
      if (activeSilhouettePass) {
        const passT = THREE.MathUtils.smoothstep(now - silhouettePassStartedAt, 0, silhouettePassDurationMs);
        silhouettePoint.lerpVectors(passStart, passEnd, passT);
        moveCreatureSafely(silhouettePoint, CREATURE_CRUISE_SPEED, dt);
        orientCreatureAlongTravel(dt);
        creatureMaterial.emissive.setHex(0x060a06);
      } else if (silhouettePassStartedAt > 0 && !silhouettePassComplete) {
        silhouettePassComplete = silhouettePassObserved;
        silhouettePassApproachStarted = false;
        creatureMaterial.emissive.setHex(0x000000);
        nextRoamTargetAt = 0;
        if (silhouettePassObserved) {
          silhouetteDirectorResolved = true;
          if (creatureAudit || silhouetteAudit) mount.dataset.silhouetteDelivery = "observed";
        } else {
          // Missing an unseen crossing does not count as delivering the beat.
          // Try once more later with a freshly generated route, then retire the
          // director rather than pestering the player indefinitely.
          silhouettePassStartedAt = 0;
          silhouettePassObserved = false;
          if (silhouettePassAttempts < SILHOUETTE_MAX_ATTEMPTS && !creatureSighted) {
            silhouettePassScheduledAt = now + SILHOUETTE_RETRY_MIN_MS
              + rand() * (SILHOUETTE_RETRY_MAX_MS - SILHOUETTE_RETRY_MIN_MS);
            if (creatureAudit || silhouetteAudit) mount.dataset.silhouetteDelivery = "missed-retry-scheduled";
          } else {
            silhouetteDirectorResolved = true;
            if (creatureAudit || silhouetteAudit) mount.dataset.silhouetteDelivery = "missed-retired";
          }
        }
      }
      if (!activeSilhouettePass && creatureAuditInspectionHold) {
        // Give visual audits a stable five-second close-up before exercising
        // the same automatic evasion route. Normal play never enters this.
        creatureTarget.copy(creature.position);
        creatureSpeed = 0;
      } else if (!activeSilhouettePass && activeEvasion) {
        const evasionTurnBlend = THREE.MathUtils.smootherstep(evasionProgress, .03, .58);
        const inverseEvasionTurnBlend = 1 - evasionTurnBlend;
        evasionSteeringDirection.copy(evasionStartDirection)
          .multiplyScalar(inverseEvasionTurnBlend * inverseEvasionTurnBlend)
          .addScaledVector(evasionCurveControl, 2 * inverseEvasionTurnBlend * evasionTurnBlend)
          .addScaledVector(evasionExitDirection, evasionTurnBlend * evasionTurnBlend);
        if (evasionSteeringDirection.lengthSq() < .001) evasionSteeringDirection.copy(evasionExitDirection);
        evasionSteeringDirection.normalize();
        evasionGuideTarget.copy(creature.position).addScaledVector(evasionSteeringDirection, 18);
        evasionGuideTarget.lerp(evasionTarget, THREE.MathUtils.smootherstep(evasionProgress, .48, .92));
        creatureTarget.copy(evasionGuideTarget);
        const evasionAcceleration = THREE.MathUtils.smootherstep(evasionProgress, 0, .18);
        const evasionDeceleration = 1 - THREE.MathUtils.smootherstep(evasionProgress, .7, 1);
        const evasionBurstBlend = evasionAcceleration * evasionDeceleration;
        const evasionBurstSpeed = Math.max(
          EVASION_SPEED_FLOOR,
          THREE.MathUtils.lerp(10.8, 14.2, Math.sin(evasionProgress * Math.PI)),
        );
        creatureSpeed = THREE.MathUtils.lerp(CREATURE_CRUISE_SPEED, evasionBurstSpeed, evasionBurstBlend);
      } else if (!activeSilhouettePass && now < evasionSettleUntil) {
        creatureTarget.copy(evasionSettleTarget);
        // The maneuver itself has already eased back to cruise speed. Keep
        // carrying that speed through the counter-bank instead of producing a
        // second, artificial burst at the animation boundary.
        creatureSpeed = CREATURE_CRUISE_SPEED;
      } else if (!activeSilhouettePass && activeCaveSettle) {
        const settleEase = THREE.MathUtils.smootherstep(caveSettleProgress, 0, 1);
        creature.position.lerpVectors(creatureCaveSettleStart, creatureCavePosition, settleEase);
        creature.quaternion.slerpQuaternions(
          creatureCaveSettleStartQuaternion,
          creatureCaveRestQuaternion,
          settleEase,
        );
        creatureTarget.copy(creatureCavePosition);
        creatureSpeed = 0;
        directCreatureMotion = true;
      } else if (!activeSilhouettePass && now < creatureRestUntil) {
        creature.position.copy(creatureCavePosition);
        creature.quaternion.copy(creatureCaveRestQuaternion);
        creatureTarget.copy(creatureCavePosition);
        creatureSpeed = 0;
        directCreatureMotion = true;
      } else if (!activeSilhouettePass && activeCaveDeparture) {
        creatureTarget.copy(creatureCaveExitPosition);
        const departureDrive = THREE.MathUtils.smootherstep(caveDepartureProgress, .08, .82);
        creatureSpeed = THREE.MathUtils.lerp(.65, CREATURE_CRUISE_SPEED, departureDrive);
      } else if (!activeSilhouettePass && earlyDistantOpportunityActive) {
        if (!earlySightingTargetAssigned) {
          camera.getWorldDirection(earlySightingDirection);
          earlySightingDirection.y = 0;
          if (earlySightingDirection.lengthSq() < .001) earlySightingDirection.set(0, 0, -1);
          else earlySightingDirection.normalize();
          right.crossVectors(earlySightingDirection, WORLD_UP).normalize();
          const glimpseSide = rand() < .5 ? -1 : 1;
          creatureTarget.copy(camera.position)
            .addScaledVector(earlySightingDirection, 48 + rand() * 8)
            .addScaledVector(right, glimpseSide * (28 + rand() * 10));
          keepInsideLake(creatureTarget, 103);
          creatureTarget.y = THREE.MathUtils.clamp(
            camera.position.y + (rand() - .5) * 6,
            terrainHeight(creatureTarget.x, creatureTarget.z) + 5,
            -4.2,
          );
          keepCreaturePointClear(creatureTarget, 7);
          earlySightingTargetAssigned = true;
          if (earlySightingAudit) {
            mount.dataset.earlySightingTargetDistance = creatureTarget.distanceTo(camera.position).toFixed(1);
            mount.dataset.earlySightingTargetSide = glimpseSide < 0 ? "left" : "right";
          }
        }
        creatureSpeed = CREATURE_CRUISE_SPEED;
      } else if (!activeSilhouettePass && earlyDistantOpportunityExitActive) {
        if (!earlySightingExitTargetAssigned) {
          creatureRetreatDirection.subVectors(creature.position, camera.position);
          creatureRetreatDirection.y = 0;
          if (creatureRetreatDirection.lengthSq() < .01) creatureRetreatDirection.set(1, 0, 0);
          else creatureRetreatDirection.normalize();
          creatureTarget.copy(camera.position).addScaledVector(creatureRetreatDirection, 102);
          keepInsideLake(creatureTarget, 104);
          creatureTarget.y = -11 - rand() * 8;
          keepCreaturePointClear(creatureTarget);
          earlySightingExitTargetAssigned = true;
          if (earlySightingAudit) mount.dataset.earlySightingExit = "retreating";
        }
        creatureSpeed = CREATURE_CRUISE_SPEED;
      } else if (!activeSilhouettePass && openingSeclusionActive) {
        if (now > nextRoamTargetAt || creatureDistance < 88 || creature.position.distanceTo(creatureTarget) < 5) {
          creatureRetreatDirection.subVectors(creature.position, camera.position);
          creatureRetreatDirection.y = 0;
          if (creatureRetreatDirection.lengthSq() < .01) creatureRetreatDirection.set(1, 0, 0);
          creatureRetreatDirection.normalize();
          creatureTarget.copy(camera.position).addScaledVector(creatureRetreatDirection, 102);
          keepInsideLake(creatureTarget, 104);
          creatureTarget.y = -11 - rand() * 8;
          keepCreaturePointClear(creatureTarget);
          nextRoamTargetAt = now + 14000 + rand() * 9000;
        }
        creatureSpeed = CREATURE_CRUISE_SPEED;
      } else if (!activeSilhouettePass && now < shyRetreatUntil) {
        creatureTarget.copy(shyRetreatTarget);
        creatureSpeed = creatureAudit ? 12 : CREATURE_CRUISE_SPEED;
      } else if (!activeSilhouettePass && silhouettePassApproachStarted && silhouettePassStartedAt === 0) {
        creatureTarget.copy(passStart);
        creatureSpeed = creatureAudit ? 12 : CREATURE_CRUISE_SPEED;
        if (creature.position.distanceTo(passStart) < 3.2) silhouettePassStartedAt = now;
      } else if (!activeSilhouettePass && creatureState === "Present") {
        if (!creatureAudit && now >= nextCaveVisitAt && now >= sonarCuriosityUntil && now >= flashCuriosityUntil) {
          headingToCave = true;
        }
        if (headingToCave) {
          creatureTarget.copy(creatureCavePosition);
          const caveDistance = creature.position.distanceTo(creatureCavePosition);
          const brakeDrive = THREE.MathUtils.smoothstep(caveDistance, 1.8, 18);
          creatureSpeed = THREE.MathUtils.lerp(.72, CREATURE_CRUISE_SPEED, brakeDrive);
          if (caveDistance < 2.15) {
            beginCreatureCaveSettle(now);
          }
        } else {
          if (now > nextRoamTargetAt || creature.position.distanceTo(creatureTarget) < 5) {
            if (creatureAudit) {
              creatureTarget.set(0, -17, -18);
            } else if (now < sonarCuriosityUntil) {
              creatureTarget.copy(sonarInterestPoint);
            } else if (now < flashCuriosityUntil) {
              const curiosityAngle = rand() * Math.PI * 2;
              creatureTarget.copy(lastKnownPosition);
              creatureTarget.x += Math.cos(curiosityAngle) * (24 + rand() * 18);
              creatureTarget.z += Math.sin(curiosityAngle) * (24 + rand() * 18);
            } else {
              camera.getWorldDirection(creatureForwardTarget);
              creatureForwardTarget.y = 0;
              if (creatureForwardTarget.lengthSq() < .001) creatureForwardTarget.set(0, 0, -1);
              else creatureForwardTarget.normalize();
              for (let attempt = 0; attempt < 4; attempt++) {
                const roamAngle = passiveBiasAudit && attempt === 0
                  ? Math.atan2(creatureForwardTarget.z, creatureForwardTarget.x)
                  : rand() * Math.PI * 2;
                const roamDistance = 82 + rand() * 22;
                creatureTarget.copy(camera.position);
                creatureTarget.x += Math.cos(roamAngle) * roamDistance;
                creatureTarget.z += Math.sin(roamAngle) * roamDistance;
                keepInsideLake(creatureTarget, 104);
                contactDirection.subVectors(creatureTarget, camera.position);
                contactDirection.y = 0;
                if (contactDirection.lengthSq() > .001) contactDirection.normalize();
                const insidePassiveCameraCone = creatureForwardTarget.dot(contactDirection) > PASSIVE_CAMERA_CONE_DOT;
                const rerollCameraConeTarget = insidePassiveCameraCone
                  && (passiveBiasAudit || rand() < PASSIVE_CAMERA_CONE_REROLL_CHANCE)
                  && attempt < 3;
                if (passiveBiasAudit && attempt === 0) {
                  mount.dataset.passiveCameraConeBias = rerollCameraConeTarget ? "rerolled" : "retained";
                }
                if (creatureTarget.distanceTo(camera.position) > 68 && !rerollCameraConeTarget) break;
              }
              creatureTarget.y = -10 - rand() * 10;
            }
            keepCreaturePointClear(creatureTarget);
            nextRoamTargetAt = now + 15000 + rand() * 17000;
          }
          creatureSpeed = creatureAudit ? 16 : CREATURE_CRUISE_SPEED;
        }
      } else if (!activeSilhouettePass && creatureState === "Investigating") {
        camera.getWorldDirection(creatureForwardTarget);
        creatureForwardTarget.y = 0;
        creatureForwardTarget.normalize();
        right.crossVectors(creatureForwardTarget, WORLD_UP).normalize();
        const orbitRadius = 44 + Math.sin(now * .00023) * 10;
        investigationOrbitPhase = (investigationOrbitPhase
          + dt * (CREATURE_CRUISE_SPEED * .56) / Math.max(24, orbitRadius)) % (Math.PI * 2);
        const orbitPhase = investigationOrbitPhase;
        creatureTarget.copy(lastKnownPosition)
          .addScaledVector(creatureForwardTarget, Math.cos(orbitPhase) * orbitRadius)
          .addScaledVector(right, Math.sin(orbitPhase) * orbitRadius);
        creatureTarget.y = camera.position.y + Math.sin(orbitPhase * 1.7) * 4.2;
        desiredDistance = 0;
        creatureSpeed = creatureAudit ? 12 : CREATURE_CRUISE_SPEED;
      } else if (!activeSilhouettePass && creatureState === "Committed") {
        if (!isHidden) lastKnownPosition.copy(camera.position);
        camera.getWorldDirection(creatureForwardTarget);
        creatureForwardTarget.y = 0;
        creatureForwardTarget.normalize();
        right.crossVectors(creatureForwardTarget, WORLD_UP).normalize();
        const closeProgress = THREE.MathUtils.clamp((now - commitBeganAt) / 42000, 0, 1);
        const committedRadius = THREE.MathUtils.lerp(16, 2.2, closeProgress);
        committedOrbitPhase = (committedOrbitPhase
          + dt * Math.min(1.05, (CREATURE_CRUISE_SPEED * .62) / Math.max(4.8, committedRadius))) % (Math.PI * 2);
        const committedPhase = committedOrbitPhase;
        creatureTarget.copy(lastKnownPosition)
          .addScaledVector(creatureForwardTarget, Math.cos(committedPhase) * committedRadius)
          .addScaledVector(right, Math.sin(committedPhase) * committedRadius);
        creatureTarget.y = camera.position.y + Math.sin(committedPhase * 1.4) * 1.7;
        creatureSpeed = creatureAudit ? 8.5 : CREATURE_CRUISE_SPEED;
      }

      if (!activeEvasion && !activeSilhouettePass && now < creatureRecoveryUntil) {
        creatureTarget.copy(creatureRecoveryTarget);
        creatureSpeed = CREATURE_CRUISE_SPEED;
      }
      if (!activeEvasion && attackMotionProgress > 0 && attackMotionProgress < 1) {
        if (attackMotionProgress < .32) {
          creatureAttackTarget.lerp(camera.position, 1 - Math.exp(-dt * 3.8));
        }
        creatureTarget.copy(creatureAttackTarget);
        desiredDistance = 0;
        const attackDrive = THREE.MathUtils.smootherstep(attackMotionProgress, .18, .62)
          * (1 - THREE.MathUtils.smootherstep(attackMotionProgress, .82, 1));
        creatureSpeed = THREE.MathUtils.lerp(4.8, 13.6, attackDrive);
      }
      const travelDistance = creature.position.distanceTo(creatureTarget);
      if (!directCreatureMotion && !activeSilhouettePass && travelDistance > desiredDistance + .2) {
        moveCreatureSafely(
          creatureTarget,
          creatureSpeed,
          dt,
          !(headingToCave || activeCaveDeparture),
        );
        const creatureFloor = terrainHeight(creature.position.x, creature.position.z) + 2.1;
        creature.position.y = THREE.MathUtils.clamp(creature.position.y, creatureFloor, -2.5);
        const evasionTurnRate = THREE.MathUtils.lerp(
          2.8,
          5.4,
          THREE.MathUtils.smootherstep(evasionProgress, .08, .72),
        );
        orientCreatureAlongTravel(
          dt,
          activeEvasion ? evasionTurnRate : attackMotionProgress > 0 && attackMotionProgress < 1 ? 4.6 : 2.4,
        );
      }
      // While settling or asleep the cave pose is spatially authored. Player
      // proximity must not shove the rig out of that pose and make it jitter.
      const caveAnchored = activeCaveSettle || now < creatureRestUntil;
      const physicalClearance = caveAnchored
        ? 0
        : creatureState === "Committed" && now - commitBeganAt > 26000 ? 3.2 : 10;
      const finalCreatureDistance = creature.position.distanceTo(camera.position);
      if (physicalClearance > 0 && finalCreatureDistance < physicalClearance) {
        creatureRetreatDirection.subVectors(creature.position, camera.position);
        if (creatureRetreatDirection.lengthSq() < .01) creatureRetreatDirection.set(1, .05, 0);
        creatureRetreatDirection.normalize();
        creature.position.addScaledVector(creatureRetreatDirection, physicalClearance - finalCreatureDistance + .12);
        keepCreaturePointClear(creature.position, 4.8);
      }
      const creatureFrameDistance = creature.position.distanceTo(creatureFrameStart);
      const restingNow = now < creatureRestUntil;
      creatureWasResting = restingNow;
      const expectedFrameDistance = creatureSpeed * dt;
      if (!restingNow
        && !activeSilhouettePass
        && creatureSpeed > 1
        && travelDistance > 4
        && creatureFrameDistance < Math.max(.004, expectedFrameDistance * .06)) {
        creatureStuckSeconds += dt;
      } else {
        creatureStuckSeconds = Math.max(0, creatureStuckSeconds - dt * 2.5);
      }
      if (creatureStuckSeconds > .65 && now >= creatureRecoveryUntil) {
        creatureCurrentForward.set(0, 0, -1).applyQuaternion(creature.quaternion).normalize();
        creatureTangent.set(-creatureCurrentForward.z, 0, creatureCurrentForward.x)
          .multiplyScalar(rand() < .5 ? -1 : 1);
        creatureRecoveryTarget.copy(creature.position)
          .addScaledVector(creatureTangent, 18)
          .addScaledVector(creatureCurrentForward, 7);
        creatureRecoveryTarget.y = THREE.MathUtils.clamp(
          creature.position.y + (rand() - .35) * 7,
          terrainHeight(creatureRecoveryTarget.x, creatureRecoveryTarget.z) + 5.4,
          -3.8,
        );
        keepCreaturePointClear(creatureRecoveryTarget, 7.2);
        creatureRecoveryUntil = now + 2600;
        creatureStuckSeconds = 0;
        nextRoamTargetAt = 0;
        if (creatureAudit) mount.dataset.creatureRecovery = "stuck-route-recovery";
      }
      creatureCurrentForward.set(0, 0, -1).applyQuaternion(creature.quaternion).normalize();
      const signedCreatureTurn = creatureCurrentForward.z * creatureTravel.x - creatureCurrentForward.x * creatureTravel.z;
      creatureMotionPose.speed = dt > .0001 ? creatureFrameDistance / dt : 0;
      creatureMotionPose.turn = THREE.MathUtils.clamp(-signedCreatureTurn * 2.1, -1, 1);
      creatureMotionPose.vertical = THREE.MathUtils.clamp(creatureTravel.y * 2.2, -1, 1);
      creatureMotionPose.behavior = creatureState.toLowerCase() as CreatureBehavior;
      creatureAnimationFocus.copy(creatureState === "Committed" && !isHidden ? camera.position : lastKnownPosition);
      creatureFocusLocal.subVectors(creatureAnimationFocus, creature.position);
      inverseCreatureQuaternion.copy(creature.quaternion).invert();
      creatureFocusLocal.applyQuaternion(inverseCreatureQuaternion);
      const focusHorizontal = Math.max(.001, Math.hypot(creatureFocusLocal.x, creatureFocusLocal.z));
      creatureMotionPose.focusYaw = THREE.MathUtils.clamp(
        Math.atan2(-creatureFocusLocal.x, -creatureFocusLocal.z),
        -.72,
        .72,
      );
      creatureMotionPose.focusPitch = THREE.MathUtils.clamp(
        Math.atan2(creatureFocusLocal.y, focusHorizontal),
        -.38,
        .38,
      );
      const finalCaveDistance = creature.position.distanceTo(creatureCavePosition);
      creatureMotionPose.caveApproach = headingToCave
        ? 1 - THREE.MathUtils.smoothstep(finalCaveDistance, 2.1, 18)
        : 0;
      creatureMotionPose.resting = restingNow;
      // A cave disturbance must feel immediate: enough time to read the head
      // lift and flipper brace, but not enough to delay committed pursuit.
      const wakeDuration = 1900;
      creatureMotionPose.wakeProgress = creatureWakeAnimationStartedAt > 0
        ? THREE.MathUtils.clamp((now - creatureWakeAnimationStartedAt) / wakeDuration, 0, 1)
        : 1;
      if (creatureMotionPose.wakeProgress >= 1) creatureWakeAnimationStartedAt = 0;
      creatureMotionPose.cavePose = activeCaveSettle
        ? THREE.MathUtils.smootherstep(caveSettleProgress, 0, 1)
        : restingNow
          ? 1
          : activeCaveDeparture
            ? 1 - THREE.MathUtils.smootherstep(caveDepartureProgress, 0, .62)
            : 0;
      creatureMotionPose.departureProgress = activeCaveDeparture ? caveDepartureProgress : undefined;
      const vocalizationActive = creatureVocalizationStartedAt > 0 && now < creatureVocalizationUntil;
      creatureMotionPose.vocalizationProgress = vocalizationActive
        ? THREE.MathUtils.clamp(
          (now - creatureVocalizationStartedAt) / Math.max(1, creatureVocalizationUntil - creatureVocalizationStartedAt),
          0,
          1,
        )
        : 0;
      if (monsterModelAudit && monsterPoseAudit === "vocal") {
        creatureMotionPose.vocalizationProgress = .5;
      }
      if (!vocalizationActive && creatureVocalizationStartedAt > 0) {
        creatureVocalizationStartedAt = 0;
        creatureVocalizationUntil = 0;
      }
      creatureMotionPose.recovering = !activeEvasion && now < creatureRecoveryUntil;
      creatureMotionPose.evasionRecoveryProgress = evasionSettleProgress;
      creatureMotionPose.evasionRecoverySide = evasionHandedness;
      const creatureAttackPathClear = creatureAttackPathIsClear();
      if (creatureAttackStartedAt > 0 && !creatureAttackPathClear) {
        // Ducking behind genuine structure during the anticipation/lunge must
        // cancel the pending fatal hit instead of allowing damage through it.
        creatureAttackStartedAt = 0;
        creatureAttackUntil = 0;
        creatureAttackImpactPlayed = false;
      }
      const attackContact = creatureState === "Committed"
        && (creatureAttackAudit || creature.position.distanceTo(camera.position) < 4.8)
        && creatureAttackPathClear
        && !isHidden
        && !activeCaveSettle
        && (!activeCaveDeparture || caveDepartureProgress > .55)
        && running
        && !fatalTriggered;
      if (attackContact && creatureAttackStartedAt === 0) {
        creatureAttackStartedAt = now;
        creatureAttackUntil = now + 1500;
        creatureAttackImpactPlayed = false;
        creatureAttackTarget.copy(camera.position);
        playCreatureClip("attack", "close", 1.15);
      }
      creatureMotionPose.attackProgress = creatureAttackStartedAt > 0 ? attackMotionProgress : 0;
      if (lakeAudit === "villagehouses" || lakeAudit === "freighter") {
        mount.dataset.creatureStrikePath = creatureAttackPathClear ? "clear" : "blocked-by-structure";
      }
      if (creatureAudit || creatureVocalAudit || silhouetteAudit || lakeAudit === "creaturecave") {
        mount.dataset.creatureTargetSpeed = creatureSpeed.toFixed(2);
        mount.dataset.creatureMeasuredSpeed = creatureMotionPose.speed.toFixed(2);
        mount.dataset.creatureFocusYaw = (creatureMotionPose.focusYaw ?? 0).toFixed(3);
        mount.dataset.creatureFocusPitch = (creatureMotionPose.focusPitch ?? 0).toFixed(3);
        mount.dataset.creatureCaveApproach = (creatureMotionPose.caveApproach ?? 0).toFixed(3);
        mount.dataset.creatureCavePose = (creatureMotionPose.cavePose ?? 0).toFixed(3);
        mount.dataset.creatureCaveDeparture = activeCaveDeparture ? caveDepartureProgress.toFixed(3) : "inactive";
        mount.dataset.creatureCaveDistance = finalCaveDistance.toFixed(3);
        mount.dataset.creaturePosition = creature.position.toArray().map((value) => value.toFixed(2)).join(",");
        mount.dataset.creatureWakeProgress = (creatureMotionPose.wakeProgress ?? 1).toFixed(3);
        mount.dataset.creatureVocalizationProgress = (creatureMotionPose.vocalizationProgress ?? 0).toFixed(3);
        mount.dataset.creatureEvasionSettle = evasionSettleProgress.toFixed(3);
        mount.dataset.creatureAttackProgress = (creatureMotionPose.attackProgress ?? 0).toFixed(3);
        mount.dataset.creatureAnimationState = activeCaveSettle
          ? "cave-settle"
          : restingNow
            ? "cave-nap"
          : (creatureMotionPose.wakeProgress ?? 1) < 1
            ? "wake"
          : activeCaveDeparture
            ? "cave-depart"
          : creatureMotionPose.attackProgress > 0
            ? "strike"
            : vocalizationActive
              ? "vocalize"
            : activeSilhouettePass
              ? "silhouette-pass"
            : silhouettePassApproachStarted
              ? "silhouette-approach"
            : activeEvasion
              ? `evade-${evasionVariant}`
              : evasionSettleProgress < 1 ? "evade-recover" : creatureState.toLowerCase();
      }
      if (activeEvasion && evasionVariant) {
        evasionPose.variant = evasionVariant;
        evasionPose.progress = evasionProgress;
        evasionPose.handedness = evasionHandedness;
        evasionPose.verticalDirection = evasionVerticalDirection;
        creatureRig.update(now / 1000, evasionPose, creatureMotionPose);
      } else {
        creatureRig.update(now / 1000, undefined, creatureMotionPose);
      }

      if (creatureAttackStartedAt > 0
        && !creatureAttackImpactPlayed
        && creatureMotionPose.attackProgress >= .68) {
        creatureAttackImpactPlayed = true;
        playAttackImpact();
        submersionShockValue = Math.max(submersionShockValue, .72);
        velocity.multiplyScalar(.12);
        if (creatureAudit) mount.dataset.creatureAttackImpact = "played";
      }

      if (creatureAttackStartedAt > 0 && now >= creatureAttackUntil && running && !fatalTriggered) {
        let dominantSource: keyof typeof aggroTotals = "mainLamp";
        (Object.keys(aggroTotals) as Array<keyof typeof aggroTotals>).forEach((source) => {
          if (aggroTotals[source] > aggroTotals[dominantSource]) dominantSource = source;
        });
        const deathReasons: Record<keyof typeof aggroTotals, string> = {
          mainLamp: droppedLampTotal > 0 ? "A dropped lamp kept its attention nearby." : "You stayed visible when it was close.",
          floodLight: floodlightTotal > 0 ? "The floodlight kept its attention on you." : "You stayed visible when it was close.",
          cameraFlash: "Repeated camera flashes led it back to you.",
          disturbingSediment: "You churned the lakebed.",
          nearNestTheft: "You took something too close to its nest.",
          sonar: "Repeated sonar pulses gave your position away.",
        };
        if (!creatureAttackImpactPlayed) playAttackImpact();
        running = false;
        fatalTriggered = true;
        setFatalCause("EATEN");
        setFatalDetail(`You were eaten in the murk. ${deathReasons[dominantSource]}${concealmentFailure ? ` ${concealmentFailure}` : ""}`);
      }

      aggroInputs.cameraFlash = 0;
      aggroInputs.nearNestTheft = 0;
      aggroInputs.sonar = 0;
      sedimentMaterial.opacity = THREE.MathUtils.lerp(
        sedimentMaterial.opacity,
        now < landingSiltUntil ? .72 : grounded && velocity.length() > .38 ? .4 : 0,
        1 - Math.exp(-dt * 3.5),
      );
      sediment.rotation.y += dt * (now < landingSiltUntil ? .34 : .07);
      }

      camera.getWorldDirection(beamDir);
      if (audioContext) {
        const listener = audioContext.listener;
        const audioNow = audioContext.currentTime;
        listener.positionX.setTargetAtTime(camera.position.x, audioNow, .02);
        listener.positionY.setTargetAtTime(camera.position.y, audioNow, .02);
        listener.positionZ.setTargetAtTime(camera.position.z, audioNow, .02);
        listener.forwardX.setTargetAtTime(beamDir.x, audioNow, .02);
        listener.forwardY.setTargetAtTime(beamDir.y, audioNow, .02);
        listener.forwardZ.setTargetAtTime(beamDir.z, audioNow, .02);
        listener.upX.setTargetAtTime(0, audioNow, .02);
        listener.upY.setTargetAtTime(1, audioNow, .02);
        listener.upZ.setTargetAtTime(0, audioNow, .02);
      }
      diverLight.position.copy(camera.position);
      pilotLight.position.copy(camera.position);
      lightTarget.position.copy(camera.position).addScaledVector(beamDir, 4);
      const gearActive = sessionStarted && (running || onBoat || descentActive);
      diverLight.intensity = gearActive && mainLampOn ? 190 : 0;
      pilotLight.intensity = 0;
      beamMaterial.opacity = gearActive && mainLampOn ? .072 : 0;
      coreMaterial.opacity = gearActive && mainLampOn ? .065 : 0;
      helmetLampRoot.visible = sessionStarted && !cameraIsHeld;
      const helmetLampIsLit = gearActive && mainLampOn;
      helmetLampGlass.color.setHex(helmetLampIsLit ? 0xffcf75 : 0x3b3a30);
      helmetLampGlass.emissive.setHex(helmetLampIsLit ? 0xffb84d : 0x000000);
      helmetLampGlass.emissiveIntensity = helmetLampIsLit ? 3.1 : 0;
      helmetLampGlass.opacity = helmetLampIsLit ? .92 : .75;
      helmetLampPoint.intensity = helmetLampIsLit ? 3 : 0;
      helmetLampGlow.visible = helmetLampIsLit;
      helmetLampGlowMaterial.opacity = helmetLampIsLit ? .46 + Math.sin(now * .0021) * .025 : 0;
      right.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
      // Emit from just beyond the front lens. Placing the spot at the camera
      // made it shine through—and bleach—the rear of the held floodlight.
      floodLight.position.copy(camera.position)
        .addScaledVector(right, .42)
        .addScaledVector(WORLD_UP, -.24)
        .addScaledVector(beamDir, 1.55);
      floodTarget.position.copy(camera.position).addScaledVector(beamDir, FLOODLIGHT_TARGET_DISTANCE);
      floodLight.intensity = gearActive && floodlightOn ? FLOODLIGHT_INTENSITY : 0;
      floodRig.position.y = -.30 + Math.sin(now * .0017) * .012;
      cameraRig.position.y = -.5 + Math.sin(now * .00145) * .01;
      const scatterAttribute = scatterGeo.attributes.position as THREE.BufferAttribute;
      inverseCameraQuaternion.copy(camera.quaternion).invert();
      // Counter-move the camera-local particle volume by the diver's complete
      // world velocity. This preserves the camera-aware rise/dive cue and now
      // also makes suspended grit pass the visor when swimming fore or aft.
      scatterDrift.copy(velocity).multiplyScalar(-dt).applyQuaternion(inverseCameraQuaternion);
      for (let i = 0; i < scatterCount; i++) {
        let particleX = scatterAttribute.getX(i) + scatterDrift.x;
        let particleY = scatterAttribute.getY(i) + scatterDrift.y;
        let particleZ = scatterAttribute.getZ(i) + scatterDrift.z;
        if (particleX > 9) particleX -= 18;
        if (particleX < -9) particleX += 18;
        if (particleY > 7) particleY -= 14;
        if (particleY < -7) particleY += 14;
        if (particleZ > 0) particleZ -= 13;
        if (particleZ < -13) particleZ += 13;
        scatterAttribute.setX(i, particleX);
        scatterAttribute.setY(i, particleY);
        scatterAttribute.setZ(i, particleZ);
      }
      scatterAttribute.needsUpdate = true;
      droppedMarkers.forEach((marker, index) => {
        const markerFloor = terrainHeight(marker.position.x, marker.position.z) + .42;
        marker.position.y = Math.max(markerFloor, marker.position.y - dt * .92);
        marker.group.rotation.z += dt * (.38 + index * .08);
        marker.light.intensity = 112 + Math.sin(now * .004 + index) * 18;
      });
      scatter.rotation.set(0, 0, 0);
      scatter.position.set(0, 0, 0);
      shafts.rotation.z = Math.sin(now * .00009) * .007;
      driftingDeadheads.forEach((deadhead, index) => {
        const phase = deadhead.userData.phase as number;
        const drift = deadhead.userData.drift as number;
        deadhead.position.x = (deadhead.userData.baseX as number) + Math.sin(now * .00006 + phase) * (1.7 + index * .16);
        deadhead.position.z = (deadhead.userData.baseZ as number) + Math.cos(now * .000045 + phase) * 1.35;
        deadhead.rotation.y += dt * drift;
        deadhead.rotation.z = Math.sin(now * .00018 + phase) * .08;
      });
      if (lakeAudit === "logs" && driftingDeadheads[0]) {
        mount.dataset.deadheadPosition = driftingDeadheads[0].position.toArray().map((value) => value.toFixed(2)).join(",");
      }

      if (monsterModelAudit) {
        // Keep the inspection camera fixed while the ordinary dive physics and
        // complete animation update continue running behind the model.
        camera.position.set(72, -14, 55);
        yaw = 0;
        pitch = 0;
        camera.rotation.set(0, 0, 0);
        submersionShockValue = 0;
        postMaterial.uniforms.submersionShock.value = 0;
      }

      postMaterial.uniforms.time.value = now / 1000;
      postMaterial.uniforms.foundFootage.value = sessionStarted && foundFootageRef.current ? 1 : 0;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCamera);
    }
    frame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frame);
      if (cameraHintTimeout !== null) window.clearTimeout(cameraHintTimeout);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("pointerlockerror", onLockError);
      renderer.domElement.removeEventListener("click", onCanvasClick);
      renderer.dispose();
      target.dispose();
      floorGeo.dispose();
      lakebedTexture.dispose();
      hullGeometry.dispose();
      bowCapGeometry.dispose();
      deckGeometry.dispose();
      chainLinkGeometry.dispose();
      surfaceGeometry.dispose();
      surfaceMaterial.dispose();
      waterTexture.dispose();
      waterHighlightTexture.dispose();
      skyGeometry.dispose();
      skyMaterial.dispose();
      roadStrips.forEach((road) => road.geometry.dispose());
      roadTexture.dispose();
      roadMaterial.dispose();
      bubbleGeo.dispose();
      scatterGeo.dispose();
      sedimentGeo.dispose();
      markerPool.forEach((marker) => scene.remove(marker.group));
      markerBodyGeometry.dispose();
      markerGlowGeometry.dispose();
      markerHaloGeometry.dispose();
      markerBodyMaterial.dispose();
      markerGlowMaterial.dispose();
      markerHaloMaterial.dispose();
      pebbleGeometry.dispose();
      pebbleMaterial.dispose();
      shellGeometry.dispose();
      shellMaterial.dispose();
      shafts.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
      shaftMaterials.forEach((material) => material.dispose());
      shaftFadeTexture.dispose();
      helmetLampGeometries.forEach((geometry) => geometry.dispose());
      helmetLampBrass.dispose();
      helmetLampSteel.dispose();
      helmetLampRubber.dispose();
      helmetLampGlass.dispose();
      helmetLampGlowMaterial.dispose();
      helmetLampGlowTexture.dispose();
      floodRig.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
      floodBodyMaterial.dispose();
      floodRubberMaterial.dispose();
      floodMetalMaterial.dispose();
      floodLensMaterial.dispose();
      floodChargeScreenMaterial.dispose();
      floodChargeTexture.dispose();
      waterDetailMaterial.dispose();
      drownedVillage.dispose();
      cargoFreighter.dispose();
      creatureNest.dispose();
      fishSystem.dispose();
      drownedFlora.dispose();
      disposePhysicalEvidence(physicalEvidenceGroups);
      moteTexture.dispose();
      postMaterial.dispose();
      introAudioRef.current = () => undefined;
      inputLockRef.current = () => undefined;
      stopFloodlightActiveAudio(false);
      try { introMusicSource?.stop(); } catch { /* It may already be stopped during teardown. */ }
      introMusicSource = null;
      introMusicGain?.disconnect();
      introMusicGain = null;
      if (audioContext) void audioContext.close();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  const begin = useCallback(() => {
    setStarted(true);
    startRef.current();
  }, []);
  const startPrologue = useCallback(() => {
    setPrologueLine(-1);
    setPrologueReady(false);
    setPrologueActive(true);
  }, []);
  const startExperience = useCallback(() => {
    // Model-inspection URLs are development-only camera setups. Bypassing the
    // story here keeps repeated silhouette, mouth, and seam checks fast while
    // leaving the ordinary player entry sequence untouched.
    if (new URLSearchParams(window.location.search).has("monsterModel")) begin();
    else startPrologue();
  }, [begin, startPrologue]);
  const continueFromPrologue = useCallback(() => {
    setPrologueActive(false);
    setPrologueReady(false);
    begin();
  }, [begin]);

  useEffect(() => {
    if (!prologueActive || prologueReady) return;
    const finalLine = PROLOGUE_LINES.length - 1;
    const delay = prologueLine < 0
      ? PROLOGUE_FIRST_LINE_DELAY_MS
      : prologueLine === finalLine ? PROLOGUE_FINAL_HOLD_MS : PROLOGUE_LINE_MS;
    const timer = window.setTimeout(() => {
      if (prologueLine === finalLine) setPrologueReady(true);
      else setPrologueLine((line) => Math.min(finalLine, line + 1));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [prologueActive, prologueLine, prologueReady]);

  useEffect(() => {
    if (!prologueActive) return;
    const onPrologueKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      event.preventDefault();
      continueFromPrologue();
    };
    window.addEventListener("keydown", onPrologueKeyDown);
    return () => window.removeEventListener("keydown", onPrologueKeyDown);
  }, [continueFromPrologue, prologueActive]);
  const restartDive = useCallback(() => {
    // Capture before the heavier reset work can consume this click's transient
    // browser activation. pointerlockchange still owns the actual unpause.
    inputLockRef.current();
    restartRef.current();
  }, []);
  const goHome = useCallback(() => {
    const homeUrl = new URL(".", document.baseURI);
    homeUrl.search = "";
    homeUrl.hash = "";
    window.location.assign(homeUrl.toString());
  }, []);
  const exitGame = useCallback(() => {
    document.exitPointerLock?.();
    try { window.close(); } catch { /* Regular browser tabs usually cannot close themselves. */ }
    window.setTimeout(() => {
      if (window.closed) return;
      if (window.history.length > 1) window.history.back();
      else window.location.replace("about:blank");
    }, 80);
  }, []);
  const resumeDive = useCallback(() => resumeRef.current(), []);
  const toggleFoundFootage = useCallback(() => {
    setFoundFootage((current) => {
      const next = !current;
      foundFootageRef.current = next;
      return next;
    });
  }, []);

  return (
    <main className="game-shell" aria-label="MURK underwater survival game">
      <div ref={mountRef} className="game-shell" />
      {started && !cameraHeld && <div className="helmet-shell" aria-hidden="true" />}
      {cameraTransitionKey > 0 && <div key={cameraTransitionKey} className="camera-black-transition" aria-hidden="true" />}
      {started && !fatalCause && divePhase !== "complete" && (
        <div className="hud" aria-hidden="true">
          {!cameraHeld && <div className="reticle" />}
          {!cameraHeld && divePhase !== "onboat" && (
            <>
              <div className="vitals-panel">
                <div className="tank-gauge">
                  <span className="gauge-label">TANK</span>
                  <div className="gauge-track"><i style={{ height: `${air}%` }} /></div>
                  <span className="gauge-value">{Math.round(air * 2.1)} BAR</span>
                </div>
                <div className="depth-meter"><span>DEPTH</span><strong>{depth.toFixed(1)}</strong><small>METERS</small></div>
              </div>
              <div className="tool-pips">
                <div className="light-charge-row">{[0, 1].map((index) => <i key={index} className={`lightbulb-icon ${index < dropLights ? "is-ready" : ""}`} />)}<kbd>R</kbd></div>
                <div className="photo-charge-row">{[0, 1, 2, 3, 4, 5].map((index) => <i key={index} className={`polaroid-icon ${index < exposures ? "is-ready" : ""}`} />)}<kbd>E</kbd></div>
                <div className="sonar-charge-row">
                  <i
                    className={`sonar-charge ${sonarReadiness >= 1 ? "is-ready" : ""}`}
                    style={{ "--sonar-fill": `${sonarReadiness * 360}deg` } as CSSProperties}
                  />
                  <kbd>G</kbd>
                </div>
              </div>
            </>
          )}
          {cameraHeld && (
            <div className="camera-viewfinder">
              <i className="finder-corner corner-tl" /><i className="finder-corner corner-tr" />
              <i className="finder-corner corner-bl" /><i className="finder-corner corner-br" />
              <div className="finder-pips">{[0, 1, 2, 3, 4, 5].map((index) => <i key={index} className={index < exposures ? "is-ready" : ""} />)}</div>
            </div>
          )}
          {!cameraHeld && sonarBearing !== null && (
            <div className="sonar-indicator" style={{ "--bearing": `${sonarBearing}deg` } as CSSProperties}>
              <i />
            </div>
          )}
          {!cameraHeld && divePhase === "onboat" && canDive && (
            <div className="jump-prompt">
              <strong>DIVE</strong>
              <kbd>SPACE</kbd>
            </div>
          )}
          {locked && !cameraHeld && (
            <div className="quick-controls">
              <div><kbd>F</kbd><span>for Floodlight</span></div>
              <div><kbd>L</kbd><span>for Helmet Lamp</span></div>
              <div><kbd>M</kbd><span>for Map</span></div>
              <div><kbd>Q</kbd><span>for Camera</span></div>
              <div><kbd>G</kbd><span>for Sonar</span></div>
            </div>
          )}
          {cameraHintVisible && !cameraHeld && <div className="camera-key-hint">Press Q for Camera</div>}
          {!cameraHeld && mapHeld && (divePhase === "search" || divePhase === "onboat") && (
            <section className="field-map">
              <div className="map-heading"><span>GREENWAKE LAKE</span><b>HYDROGRAPHIC FIELD SURVEY · SONAR LINK</b></div>
              <div className="map-lake">
                <i className="map-tech-grid" />
                <i className="map-contour contour-one" /><i className="map-contour contour-two" />
                <i className="map-contour contour-three" /><i className="map-contour contour-four" />
                <span className="deep-end-contours"><i /><i /><i /><b>DEEP END</b></span>
                <span className="map-poi point-forest"><b>FOREST</b></span>
                <span className="map-poi point-town"><b>TOWN</b></span>
                <span className="map-poi point-ship"><b>SHIP</b></span>
                <span className="north-mark"><b>N</b><i /></span>
                <i className="player-position" style={{ left: `${mapPosition.x}%`, top: `${mapPosition.y}%` }} />
                {sonarMapPosition && (
                  <i
                    className="last-sonar-contact"
                    style={{ left: `${sonarMapPosition.x}%`, top: `${sonarMapPosition.y}%` }}
                    title="Last sonar contact"
                  />
                )}
                <span className="map-readout">GRID 08-G · LAST CONTACT <b>{sonarMapPosition ? "LOCKED" : "NONE"}</b></span>
              </div>
            </section>
          )}
          {!cameraHeld && (
            <>
              {breathHeld && <div className="breath-held">HOLDING BREATH</div>}
              {breathEvent && <div className={`breath-event ${breathEvent.startsWith("INVOLUNTARY") ? "is-gasp" : ""}`}>{breathEvent}</div>}
              {evidencePrompt && <div className="evidence-prompt">{evidencePrompt}</div>}
              {evidenceEvent && <div className="evidence-event">{evidenceEvent}</div>}
            </>
          )}
        </div>
      )}
      {!started && !prologueActive && (
        <section className="start-screen" onPointerDown={() => introAudioRef.current()}>
          <div className="start-card">
            <h1 className="start-title">MURK</h1>
            <p className="start-copy"><strong>There’s something in Greenwake Lake.</strong></p>
          </div>
          <div className="title-actions">
            <button className="dive-button" onClick={startExperience}>DIVE IN</button>
            <button ref={exitButtonRef} className="exit-button" onClick={exitGame}>EXIT</button>
          </div>
        </section>
      )}
      {!started && prologueActive && (
        <section className="prologue-screen" aria-live="polite" aria-label="Opening story">
          <div className="prologue-lines">
            {PROLOGUE_LINES.map((line, index) => (
              <p
                key={line}
                className={`prologue-line ${index <= prologueLine ? "is-visible" : ""}`}
                aria-hidden={index > prologueLine}
              >
                {line}
              </p>
            ))}
          </div>
          {prologueReady && (
            <div className="prologue-continue">
              <strong>CONTINUE</strong>
              <kbd>SPACE</kbd>
            </div>
          )}
        </section>
      )}
      {fatalCause && (
        <section className="fatal-screen" aria-live="assertive">
          {fatalCause !== "EATEN" && <p className="fatal-kicker">DIVE TERMINATED</p>}
          <h2>{fatalCause}</h2>
          <span>{fatalDetail || "Your tank ran dry."}</span>
          <div className="screen-actions"><button onClick={restartDive}>RESTART</button><button onClick={goHome}>HOME</button></div>
        </section>
      )}
      {divePhase === "complete" && !fatalCause && (
        <section className="complete-screen" aria-live="polite">
          <p className="fatal-kicker">BACK ABOARD · DIVE CLOSED</p>
          <h2>EVIDENCE GRADE</h2>
          <strong className={`dive-grade grade-${diveGrade.toLowerCase()}`}>{diveGrade}</strong>
          <span>
            {goodPhotoCount} GOOD {goodPhotoCount === 1 ? "PHOTOGRAPH" : "PHOTOGRAPHS"} · {physicalEvidenceCount} PHYSICAL {physicalEvidenceCount === 1 ? "PIECE" : "PIECES"}
          </span>
          <p className="evidence-value">EVIDENCE VALUE · {bankedValue}</p>
          <div className="screen-actions">
            {photoPreviews.length > 0 && <button onClick={() => { setPhotoReviewIndex(0); setReviewingPhotos(true); }}>REVIEW PHOTOS</button>}
            <button onClick={restartDive}>RESTART</button><button onClick={goHome}>HOME</button>
          </div>
        </section>
      )}
      {reviewingPhotos && photoPreviews.length > 0 && (
        <section className="photo-review" aria-label="Dive photographs">
          {/* Canvas-generated local dive photos are not network image assets. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoPreviews[photoReviewIndex]} alt={`Dive photograph ${photoReviewIndex + 1}`} />
          <span>{photoReviewIndex + 1} / {photoPreviews.length}</span>
          <div className="screen-actions">
            <button onClick={() => setPhotoReviewIndex((index) => Math.max(0, index - 1))} disabled={photoReviewIndex === 0}>PREVIOUS</button>
            <button onClick={() => setPhotoReviewIndex((index) => Math.min(photoPreviews.length - 1, index + 1))} disabled={photoReviewIndex === photoPreviews.length - 1}>NEXT</button>
            <button onClick={() => setReviewingPhotos(false)}>CLOSE</button>
          </div>
        </section>
      )}
      {started && pauseOpen && !fatalCause && divePhase !== "complete" && (
        <div className="pause-note">
          <strong>PAUSED</strong>
          <div className="screen-actions pause-actions"><button onClick={resumeDive}>CONTINUE</button><button onClick={restartDive}>RESTART</button><button onClick={goHome}>HOME</button></div>
          <button className="visual-mode-toggle" onClick={toggleFoundFootage}>FOUND FOOTAGE · {foundFootage ? "ON" : "OFF"}</button>
          <div className="pause-controls-list" aria-label="Movement and tool controls">
            <div><kbd>WASD</kbd><span>MOVE</span></div>
            <div><kbd>MOUSE</kbd><span>LOOK</span></div>
            <div><kbd>SPACE / SHIFT</kbd><span>RISE / DESCEND</span></div>
            <div><kbd>ESC</kbd><span>PAUSE / RESUME</span></div>
            <div className="pause-tool-control"><kbd>C</kbd><span>HOLD BREATH</span></div>
            <div><kbd>X</kbd><span>COLLECT</span></div>
            <div><kbd>B</kbd><span>AIR BOOST</span></div>
          </div>
          <aside className="pause-inventory" aria-label="Dive inventory">
            <h3>DIVE INVENTORY</h3>
            <div className="inventory-photos"><i className="polaroid-icon is-ready" /><span>{photoCount} PHOTOS</span></div>
            {carryLabels.length > 0
              ? carryLabels.map((label) => <div className="inventory-item" key={label}><i />{label}</div>)
              : <p>NO PHYSICAL EVIDENCE</p>}
          </aside>
        </div>
      )}
    </main>
  );
}
