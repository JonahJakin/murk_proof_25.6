# MURK

A first-person underwater survival horror game built with Three.js. One diver enters a drowned freshwater landscape to recover evidence of something far too large for the lake. Demo V25 is the friends-and-playtest release candidate: its eight physical evidence pieces now use distinct authored models, silhouettes, damage, and material treatments instead of four reused primitives. Its release cleanup removes unused starter scaffolding and assets, gives automated checks a clean source boundary, refreshes the offline cache, and preserves every existing gameplay rule, evidence value, and location. Final playtest tuning raises creature-call volume, gives passive roaming its own restrained neutral-call schedule, reins in the floodlight's long-distance clarity, gives every drifting deadhead a moving player collider, and adds a restrained mechanical-electrical cue to the main headlamp switch.

The V23 systems pass redistributes the lake population evenly, trims the overall fish count by roughly 25%, limits the broader minnow schools to 5–15 fish, and gives the larger species a greater share of the ecosystem. Fish face and swim forward correctly, accelerate to 3.5 times cruise speed while fleeing, and use continuous motion phases so entering or leaving a scare cannot snap their animation. The creature cruises at 7.8 m/s, turns and undulates in response to its actual movement, uses longer routes and a stuck-route recovery system, and has a committed strike animation. Photographing it or exposing it to the floodlight while it rests in its cave immediately begins a half-advanced committed countdown; sonar remains non-aggressive.

The creature animation library gives its AI states smoothly blended body language: investigative head-and-neck tracking during wide circling, a streamlined committed stalking posture, a fast cave-wake head lift and flipper brace, and an asymmetric bank/paddle response during stuck-route recovery. These poses layer over measured-speed locomotion and existing evasions rather than changing aggression or navigation rules.

Evasions now enter through a brief anticipatory brace, steer along a stable curved heading, ease from cruise speed into their burst and back, then carry forward through a one-second counter-bank instead of stopping or snapping into the next route. The committed strike is staged as anticipation, lunge, impact, and follow-through; impact feedback occurs before the fatal overlay, while the supplied design constraint of no animated jaw remains intact.

The world, creature, effects, and map illustrations are generated in code. The app icon is the supplied true-grid pixel artwork. Creature calls, title music, and floodlight operation use the supplied WAV recordings; suit, water, breath, and remaining interaction sounds remain procedural.

## Controls

- `WASD` swim; mouse or arrow keys look
- `Space` skip/continue the opening prologue; dive while standing at an edge of the boat and looking out; then rise underwater
- `Shift` descend
- `F` raise or stow the carried floodlight; it runs for 20 seconds and must fully cool after overheating
- `L` main lamp
- `Q` raise or stow the camera, including while aboard the boat
- `E` camera shutter (while the camera is raised)
- `M` raise or fold the map
- `C` hold breath
- `G` ping the directional sonar; its latest contact remains on the map
- `X` take evidence
- `R` deploy a sinking decoy light
- `B` emergency air boost
- `Esc` toggle the pause menu and all audio

The pause menu also toggles the optional **Found Footage** visual mode.

Breaking the surface gradually refills the tank. Dense Curtain weed can conceal the diver even with the helmet lamp lit; the similar-looking Sparse weed cannot.

Restart resets the dive in place and returns the player to the boat without leaving the pause menu active.

## Run locally

```bash
pnpm install
pnpm dev
```

Build the hosted version with `pnpm build`.

## Installable PWA

MURK includes a web app manifest, maskable and Apple app icons, and an offline service worker. Build the standalone static PWA with:

```bash
pnpm build:pwa
```

The deployable static files are written to `pwa-dist/`.

## Publish with GitHub Pages

The repository includes `.github/workflows/deploy-pwa.yml`. Push the project to a GitHub repository, then choose **GitHub Actions** as the Pages source in the repository settings. Pushes to `main` build and publish the standalone PWA automatically.

The Sites build and GitHub Pages PWA share the same game source, controls, procedural visuals, and spatialized audio library.
